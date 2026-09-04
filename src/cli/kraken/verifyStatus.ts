/**
 * verifyStatus — session-level verification state for the TUI (identity wave).
 *
 * The strict gate (verificationBridge, ADR-0023/0026) already decides whether
 * a build turn may finish. This module PROJECTS that decision onto UI the
 * user can see at all times:
 *
 *   - Verifica chip:   prova: PASS | RIPARA | BLOCCATO   (P1 as product)
 *   - Permessi chip:   phase gate + strict-done declaration (P2+P3 honesty)
 *   - Block explanation: why a turn was stopped, which criteria miss proof
 *
 * Store discipline mirrors tools/krakenLive.ts: ephemeral, per-process,
 * fail-open. A missing/never-evaluated state renders NO chip — never a fake
 * one (EMPTY ≠ absent).
 */
import { strictDoneEnabled, type StrictBuildGateEvaluation } from './verificationBridge.js';

export type VerifySessionState = 'pass' | 'repair' | 'blocked';

export interface StatusChip {
  label: string;
  tone: 'green' | 'yellow' | 'red';
}

/**
 * Map a strict-gate evaluation onto the three-state session contract.
 * `blocked` (CompletionPolicy BLOCKED) is the hard stop; every other blocked
 * outcome (REPAIR_REQUIRED, legacy gate) means work remains — never pass.
 */
export function verifyStateFromGate(
  evaluation: StrictBuildGateEvaluation,
): VerifySessionState {
  if (!evaluation.blocked) return 'pass';
  const verdict = evaluation.evaluation?.verdict;
  if (verdict === 'BLOCKED') return 'blocked';
  return 'repair';
}

/** Verifica chip label. Italian on purpose: this is the product contract. */
export function formatVerifyChip(state: VerifySessionState): StatusChip {
  if (state === 'pass') return { label: 'prova: PASS', tone: 'green' };
  if (state === 'blocked') return { label: 'prova: BLOCCATO', tone: 'red' };
  return { label: 'prova: RIPARA', tone: 'yellow' };
}

/**
 * Permessi chip: what the agent may write RIGHT NOW, honestly declared.
 * - plan phase never writes (P2 phase gate);
 * - build + strict-on: proof is mandatory before "done" (P1);
 * - build with strict opted out: declared fail-open, shown as such (P3) —
 *   never hidden to look safer than it is.
 */
export function permissionsChip(
  phase: 'plan' | 'build',
  strictOn: boolean = strictDoneEnabled(),
): StatusChip {
  if (phase === 'plan') return { label: 'scrive: no (piano)', tone: 'yellow' };
  return strictOn
    ? { label: 'scrive: sì · prova obbligatoria', tone: 'green' }
    : { label: 'scrive: sì · senza prova (dichiarato)', tone: 'yellow' };
}

/**
 * Structural view of CompletionEvaluation — read defensively so a shape
 * drift in @zelari/core degrades the explanation to counts, never crashes
 * the turn loop.
 */
type EvaluationLike = {
  verdict?: string;
  criteria?: readonly { id: string; text: string }[];
  results?: readonly { criterionId: string; status: string }[];
} | null;

/**
 * Human-readable explanation of a strict-gate outcome: verdict word, how
 * much proof passed, WHICH criteria are still unsatisfied, and the rule.
 * Used where the gate stops a turn — the user sees why, not an exit code.
 */
export function formatStrictBlockExplanation(
  evaluation: StrictBuildGateEvaluation,
): string {
  const state = verifyStateFromGate(evaluation);
  const gate = evaluation.gate;
  if (state === 'pass') {
    return `[verifica] PASS — ${gate.passed}/${gate.total} prove superate.`;
  }
  const word = state === 'blocked' ? 'BLOCCATO' : 'RIPARA';
  const lines: string[] = [
    `[verifica] ${word} — ${gate.passed}/${gate.total} prove superate; il turno non può dichiararsi finito senza prova.`,
  ];
  const evalr = (evaluation.evaluation ?? null) as unknown as EvaluationLike;
  if (evalr) {
    const byId = new Map<string, string>();
    for (const c of evalr.criteria ?? []) byId.set(c.id, c.text);
    const unsatisfied = (evalr.results ?? []).filter((r) => r.status !== 'pass');
    if (unsatisfied.length > 0) {
      lines.push('Mancano:');
      for (const r of unsatisfied.slice(0, 8)) {
        lines.push(`  • ${byId.get(r.criterionId) ?? r.criterionId} [${r.status}]`);
      }
      if (unsatisfied.length > 8) {
        lines.push(`  • … e altri ${unsatisfied.length - 8}`);
      }
    }
  }
  lines.push(
    'La prova è obbligatoria: chiudo il turno solo quando ogni criterio richiesto ha evidenza.',
  );
  return lines.join('\n');
}

// ── Ephemeral per-process store (same discipline as krakenLive.ts) ──

interface StoredVerifyState {
  state: VerifySessionState;
  at: number;
  passed: number;
  total: number;
}

type G = { __zelariVerifyState?: StoredVerifyState };

/**
 * Record the latest strict-gate evaluation. Single writer discipline: the
 * turn loop (TUI useChatTurn) calls this right after each evaluation —
 * including the post-repair re-check, so a successful repair flips the
 * chip to PASS instead of lying on RIPARA.
 */
export function recordStrictGateEvaluation(evaluation: StrictBuildGateEvaluation): void {
  const g = globalThis as unknown as G;
  g.__zelariVerifyState = {
    state: verifyStateFromGate(evaluation),
    at: Date.now(),
    passed: evaluation.gate.passed,
    total: evaluation.gate.total,
  };
}

/**
 * Current Verifica chip for the StatusBar. Null before the first evaluation
 * of the process — no verdict has been observed yet, so no chip (honesty
 * over decoration).
 */
export function getVerifyChip(): StatusChip | null {
  const g = globalThis as unknown as G;
  const s = g.__zelariVerifyState;
  if (!s) return null;
  return formatVerifyChip(s.state);
}
