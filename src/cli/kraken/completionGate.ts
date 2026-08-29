/**
 * completionGate — BUILD clean-finish gate for selection turns (Fase 8,
 * ADR-0020).
 *
 * A BUILD turn that used kraken_select cannot cleanly finish while its
 * required checks are unresolved: a `fail` blocks by contradiction, an
 * `unknown` blocks because a degraded or missing observation is never proof
 * (§23 observation integrity — the same rule verifyReport enforces).
 *
 * The gate integrates into the EXISTING recovery flow (the headless BUILD
 * write-retry pattern) rather than adding a second recovery system: one
 * automatic repair pass, structural budget = 1 (the TUI enqueues it once via
 * a local flag; headless fires a single guarded block). PLAN turns are never
 * gated — their checks fold into the final plan document (Fase 6 routing),
 * and verify tentacles cannot run there anyway (Fase 1).
 */
import { getKrakenCheckResults, krakenRequiredChecks } from './candidateRegistry.js';
import type { KrakenCheckResult } from './verifyReport.js';

/** Checks grouped by outcome (pure — no registry access). */
export interface KrakenCheckClassification {
  passed: string[];
  failed: string[];
  unknown: string[];
}

/** Lowercase + collapse whitespace (mirrors verifyReport matching). */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Map required checks onto their latest reported results. Matching mirrors
 * verifyReport: normalized equality first, then containment (either
 * direction, minimum length 8) so a lightly reworded criterion still maps.
 * A check with no matching result is `unknown` — never assumed `pass`.
 */
export function classifyKrakenChecks(
  requiredChecks: readonly string[],
  results: readonly KrakenCheckResult[] | null,
): KrakenCheckClassification {
  const byCriterion = new Map<string, KrakenCheckResult>();
  for (const result of results ?? []) {
    byCriterion.set(normalize(result.check), result); // later duplicates win
  }
  const keys = [...byCriterion.keys()];
  const out: KrakenCheckClassification = { passed: [], failed: [], unknown: [] };
  for (const check of requiredChecks) {
    const norm = normalize(check);
    let result = byCriterion.get(norm) ?? null;
    if (!result) {
      for (const key of keys) {
        if (key.length >= 8 && (key.includes(norm) || norm.includes(key))) {
          result = byCriterion.get(key) ?? null;
          break;
        }
      }
    }
    if (!result || result.status === 'unknown') out.unknown.push(check);
    else if (result.status === 'pass') out.passed.push(check);
    else out.failed.push(check);
  }
  return out;
}

/** Outcome of evaluating the current turn against its proof obligations. */
export interface KrakenCompletionGate {
  /** True when the turn may NOT cleanly finish (fail or unknown present). */
  blocked: boolean;
  /** True only when a `selected` verdict registered checks this turn. */
  selectionUsed: boolean;
  total: number;
  passed: number;
  failedChecks: string[];
  unknownChecks: string[];
}

const OPEN_GATE: KrakenCompletionGate = {
  blocked: false,
  selectionUsed: false,
  total: 0,
  passed: 0,
  failedChecks: [],
  unknownChecks: [],
};

/**
 * Evaluate the turn registry. Reads the per-turn candidate registry
 * (selection verdict + last verify report); returns an open gate for PLAN
 * turns, turns without selection, and selections that produced no checks.
 * Never throws.
 *
 * v2.16 (t23): a BUILD turn whose registry evaluation THROWS is fail-closed:
 * the gate returns BLOCKED (checks already read count as unknown, and
 * unknown ≠ pass) so a broken registry can never mint a green finish.
 */
export function evaluateKrakenCompletionGate(mode: 'plan' | 'build'): KrakenCompletionGate {
  // PLAN turns are never gated (Fase 6 routing) — outside the try so even a
  // broken registry cannot block a plan.
  if (mode !== 'build') return OPEN_GATE;
  let checks: readonly string[] = [];
  try {
    checks = krakenRequiredChecks();
    if (checks.length === 0) return OPEN_GATE;
    const classification = classifyKrakenChecks(checks, getKrakenCheckResults());
    return {
      blocked: classification.failed.length > 0 || classification.unknown.length > 0,
      selectionUsed: true,
      total: checks.length,
      passed: classification.passed.length,
      failedChecks: classification.failed,
      unknownChecks: classification.unknown,
    };
  } catch {
    // v2.16 (t23): fail-closed — an unevaluatable gate is never a pass
    // (unknown ≠ pass, §23 observation integrity). Checks read so far count
    // as unknown (the repair prompt lists them); a registry broken before
    // any check was read still blocks with nothing passed.
    return {
      blocked: true,
      selectionUsed: false,
      total: checks.length,
      passed: 0,
      failedChecks: [],
      unknownChecks: [...checks],
    };
  }
}

/**
 * User directive for the single automatic repair pass. The selection itself
 * is settled (no re-running kraken_select); the model must fix, then
 * re-verify ALL required checks via a verify tentacle.
 */
export function buildKrakenRepairPrompt(gate: KrakenCompletionGate): string {
  const lines: string[] = [
    `The BUILD turn is ending, but the required checks from kraken_select are not all satisfied (passed ${gate.passed}/${gate.total}).`,
    '',
  ];
  if (gate.failedChecks.length > 0) {
    lines.push('FAILED checks (evidence contradicts them):');
    for (const check of gate.failedChecks) lines.push(`- ${check}`);
    lines.push('');
  }
  if (gate.unknownChecks.length > 0) {
    lines.push(
      'UNKNOWN checks (never conclusively verified — a degraded or missing observation is NOT proof):',
    );
    for (const check of gate.unknownChecks) lines.push(`- ${check}`);
    lines.push('');
  }
  lines.push(
    'Recover this turn:',
    '1. The approach selection is settled — do NOT call kraken_select again.',
    '2. Fix each failing check directly with focused edits.',
    '3. Make each unknown check conclusively verifiable (run the real command, read the real output).',
    '4. Spawn a `task verify` tentacle whose Acceptance lists ALL required checks; its conclusion must contain one <verify-report> block per check with an explicit status.',
    '5. Only end the turn when every check reports status: pass — an unverified assumption is not a pass.',
  );
  return lines.join('\n');
}
