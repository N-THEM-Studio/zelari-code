/**
 * verificationBridge — adapts the 1.x Kraken check registry onto the 2.0
 * deterministic evidence contract (ADR-0023), and enforces ZELARI_STRICT_DONE.
 *
 * The legacy completion gate (completionGate.ts) already implements
 * `unknown ≠ pass` over verify-report blocks. This bridge additionally maps
 * those results onto Criterion/VerificationResult and runs the strict
 * CompletionPolicy, where "pass without evidence" is ALSO blockable — the
 * false-done guarantee the 2.0 contract adds on top.
 *
 * Composition rule: the strict verdict can only ADD blockers, never remove
 * them. A legacy-blocked turn stays blocked; a legacy-open turn can become
 * blocked only when strict evaluation is enabled AND the evidence contract
 * is not satisfied.
 */
import { getKrakenCheckResults, krakenRequiredChecks } from './candidateRegistry.js';
import { evaluateKrakenCompletionGate, type KrakenCompletionGate } from './completionGate.js';
import type { KrakenCheckResult } from './verifyReport.js';
import {
  evaluateCompletion,
  STRICT_BUILD_POLICY,
  type CompletionEvaluation,
  snapshotToCompletionEvaluation,
  type SessionVerificationRunSnapshot,
  type Criterion,
  type EvidenceRef,
  type VerificationResult,
} from '@zelari/core/verification';

/** Strict done gate — opt-in during the alpha (default off for compat). */
export function strictDoneEnabled(): boolean {
  const v = process.env.ZELARI_STRICT_DONE;
  return v === '1' || v === 'true';
}

export interface KrakenEvidenceContract {
  criteria: Criterion[];
  results: VerificationResult[];
}

/** Stable criterion id for a required-check text (deterministic per turn). */
function criterionId(check: string, index: number): string {
  const slug = check
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `check-${index + 1}-${slug || 'criterion'}`;
}

/** Lowercase + collapse whitespace (mirrors completionGate matching). */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Find the reported result for a required check using the same tolerant
 * matching as the legacy gate (normalized equality, then containment either
 * direction at minimum length 8) so the two gates never disagree on mapping.
 */
function matchResult(
  check: string,
  byNormalized: Map<string, KrakenCheckResult>,
): KrakenCheckResult | undefined {
  const norm = normalize(check);
  const direct = byNormalized.get(norm);
  if (direct) return direct;
  for (const key of byNormalized.keys()) {
    if (key.length >= 8 && (key.includes(norm) || norm.includes(key))) {
      return byNormalized.get(key);
    }
  }
  return undefined;
}

/**
 * Map registry check results onto the evidence contract.
 *
 * Evidence discipline (ADR-0023): a `pass` counts only when the verify
 * tentacle left an evidence note pointing back at real tool output. A pass
 * without a note produces an empty evidence array — the CompletionPolicy
 * then treats it as `unknown` (pass without evidence ≠ done).
 */
export function krakenResultsToContract(
  requiredChecks: readonly string[],
  results: readonly KrakenCheckResult[] | null,
  now: number = Date.now(),
): KrakenEvidenceContract {
  const byNormalized = new Map<string, KrakenCheckResult>();
  for (const r of results ?? []) byNormalized.set(normalize(r.check), r); // later duplicates win
  const criteria: Criterion[] = [];
  const verifications: VerificationResult[] = [];
  requiredChecks.forEach((check, i) => {
    const id = criterionId(check, i);
    criteria.push({
      id,
      text: check,
      source: 'kraken-selection',
      required: true,
      check: { kind: 'none', reason: 'verified by verify tentacle report' },
    });
    const reported = matchResult(check, byNormalized);
    const evidence: EvidenceRef[] =
      reported?.note && reported.note.trim().length > 0
        ? [
            {
              tier: 'tool-output',
              ref: reported.note.trim().slice(0, 500),
              capturedAt: now,
            },
          ]
        : [];
    verifications.push({
      criterionId: id,
      status: reported?.status ?? 'unknown',
      source: 'verify-agent',
      evidence,
      evaluatedAt: now,
      durationMs: 0,
      ...(reported?.note ? { detail: `verify-report note: ${reported.note.slice(0, 200)}` } : {}),
    });
  });
  return { criteria, results: verifications };
}

/** Combined outcome: legacy gate + (optional) strict evidence evaluation. */
export interface StrictBuildGateEvaluation {
  gate: KrakenCompletionGate;
  strict: boolean;
  evaluation: CompletionEvaluation | null;
  /** True when the turn may NOT cleanly finish (either gate blocks). */
  blocked: boolean;
  /** One-line machine-readable summary for logging/NDJSON. */
  summary: string;
}

/**
 * Evaluate the BUILD completion gate. When `ZELARI_STRICT_DONE` is enabled
 * and the turn registered required checks, the evidence contract is evaluated
 * as well and the verdicts merged (blockers add up).
 */
export function evaluateStrictBuildGate(mode: 'plan' | 'build'): StrictBuildGateEvaluation {
  const gate = evaluateKrakenCompletionGate(mode);
  if (!gate.selectionUsed || gate.total === 0 || !strictDoneEnabled()) {
    return {
      gate,
      strict: false,
      evaluation: null,
      blocked: gate.blocked,
      summary: gate.blocked
        ? `blocked: ${gate.failedChecks.length} failed, ${gate.unknownChecks.length} unknown`
        : 'open',
    };
  }
  const checks = krakenRequiredChecks();
  const contract = krakenResultsToContract(checks, getKrakenCheckResults());
  const evaluation = evaluateCompletion(contract.criteria, contract.results, STRICT_BUILD_POLICY);
  const blocked = gate.blocked || evaluation.verdict !== 'PASS';
  return {
    gate,
    strict: true,
    evaluation,
    blocked,
    summary: blocked
      ? `blocked (strict ${evaluation?.verdict ?? 'n/a'}): ${gate.passed}/${gate.total} legacy-pass, evidence ${
          evaluation?.evidenceComplete ? 'complete' : 'incomplete'
        }`
      : `open (strict PASS): ${evaluation?.satisfied.length ?? 0}/${gate.total} criteria pass with evidence`,
  };
}

/**
 * E2.2 exit code for a strict-mode turn whose completion gate is still blocked
 * after the automatic repair pass: the run must NOT close as success.
 * Distinct from transport errors (3) and usage errors (2).
 */
export const STRICT_DONE_EXIT_CODE = 4;

/** Pure: strict blocked → dedicated exit code; anything else → keep the pass outcome. */
export function strictGateExitCode(evaluation: StrictBuildGateEvaluation): number {
  return evaluation.strict && evaluation.blocked ? STRICT_DONE_EXIT_CODE : 0;
}

/** Machine-readable record for the session spine `verification.run` event. *//** Machine-readable record for the session spine `verification.run` event. */
export function strictGateEventPayload(evaluation: StrictBuildGateEvaluation): Record<string, unknown> {
  return {
    engine: 'kraken-legacy+completion-policy',
    strict: evaluation.strict,
    verdict: evaluation.evaluation?.verdict ?? (evaluation.blocked ? 'BLOCKED' : 'PASS'),
    legacy: {
      total: evaluation.gate.total,
      passed: evaluation.gate.passed,
      failed: evaluation.gate.failedChecks,
      unknown: evaluation.gate.unknownChecks,
    },
    evidence: evaluation.evaluation
      ? {
          satisfied: evaluation.evaluation.satisfied,
          unsatisfied: evaluation.evaluation.unsatisfied,
          complete: evaluation.evaluation.evidenceComplete,
        }
      : null,
    summary: evaluation.summary,
  };
}

/**
 * E2.1 (ADR-0023 × ADR-0021): reconstruct the strict build gate verdict from
 * the session spine alone — no in-process registry. For hosts, mission
 * retries and audits: a turn's decision must be confirmable from its log.
 * A missing snapshot is "no verification evidence" (open, never pass); a
 * non-strict snapshot is not admissible. Blockers add up — the caller
 * combines this with its own current-process gate.
 */
export function evaluateStrictBuildGateFromSession(
  mode: 'plan' | 'build',
  snapshot: SessionVerificationRunSnapshot | null,
): StrictBuildGateEvaluation {
  // Legacy view of THIS process (usually empty on a resumed host).
  const gate = evaluateKrakenCompletionGate(mode);
  const evaluation = snapshot ? snapshotToCompletionEvaluation(snapshot) : null;
  const blocked = evaluation ? evaluation.verdict !== 'PASS' : false;
  return {
    gate,
    strict: evaluation !== null,
    evaluation,
    blocked,
    summary: evaluation
      ? blocked
        ? `blocked (strict ${evaluation.verdict} from session log seq=${snapshot?.seq}): ${evaluation.summary}`
        : `open (strict PASS from session log seq=${snapshot?.seq}): ${evaluation.summary}`
      : 'open (no strict verification record in session log)',
  };
}
