/**
 * verification/completionPolicy.ts — evidence-based completion gate (ADR-0023).
 *
 * PASS only when every required criterion has a `pass` result WITH at least
 * one EvidenceRef. `fail` → REPAIR_REQUIRED (repair loop); missing/unknown
 * (including "pass without evidence") → BLOCKED. A clean "done" without
 * sufficient evidence is blockable by construction: unknown ≠ pass.
 */

import type { Criterion, EvidenceRefTier, VerificationResult } from './types.js';

export type CompletionVerdict = 'PASS' | 'REPAIR_REQUIRED' | 'BLOCKED';

export interface CompletionPolicy {
  mode: 'strict';
  /** Criterion ids gating completion; '*' = every criterion with required:true. */
  required: '*' | string[];
  /**
   * Evidence tiers that may satisfy a criterion (E2.2). Undefined = every tier
   * is admissible (legacy behaviour). The strict BUILD gate admits only
   * deterministic tiers: an advisory LLM score alone is never proof of done
   * (PRINCIPLES P1 — trust tool/terminal output, not narration).
   */
  admissibleTiers?: readonly EvidenceRefTier[];
}

export const STRICT_ALL_POLICY: CompletionPolicy = { mode: 'strict', required: '*' };

/** Tiers produced by deterministic observation: tools, commands, fs, humans. */
export const DETERMINISTIC_EVIDENCE_TIERS: readonly EvidenceRefTier[] = [
  'tool-output',
  'command-output',
  'fs-observation',
  'human',
];

/** Strict BUILD/mission completion: every required criterion, deterministic evidence only. */
export const STRICT_BUILD_POLICY: CompletionPolicy = {
  mode: 'strict',
  required: '*',
  admissibleTiers: DETERMINISTIC_EVIDENCE_TIERS,
};

export interface UnsatisfiedCriterion {
  id: string;
  status: 'fail' | 'unknown' | 'missing';
  reason: string;
}

export interface CompletionEvaluation {
  verdict: CompletionVerdict;
  satisfied: string[];
  unsatisfied: UnsatisfiedCriterion[];
  /** True when every required criterion passed with evidence. */
  evidenceComplete: boolean;
  summary: string;
}

function lastResultById(results: readonly VerificationResult[]): Map<string, VerificationResult> {
  const map = new Map<string, VerificationResult>();
  for (const r of results) map.set(r.criterionId, r);
  return map;
}

export function evaluateCompletion(
  criteria: readonly Criterion[],
  results: readonly VerificationResult[],
  policy: CompletionPolicy = STRICT_ALL_POLICY,
): CompletionEvaluation {
  const requiredIds =
    policy.required === '*'
      ? criteria.filter((c) => c.required).map((c) => c.id)
      : policy.required;
  const byId = lastResultById(results);
  const order = new Map(criteria.map((c, i) => [c.id, i]));
  const satisfied: string[] = [];
  const unsatisfied: UnsatisfiedCriterion[] = [];

  const ids = [...requiredIds].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const id of ids) {
    const result = byId.get(id);
    if (!result) {
      unsatisfied.push({ id, status: 'missing', reason: 'no verification result' });
      continue;
    }
    if (result.status === 'fail') {
      unsatisfied.push({ id, status: 'fail', reason: result.detail ?? 'check failed' });
      continue;
    }
    if (result.status === 'unknown') {
      unsatisfied.push({ id, status: 'unknown', reason: result.detail ?? 'not evaluable — unknown ≠ pass' });
      continue;
    }
    if (result.evidence.length === 0) {
      unsatisfied.push({
        id,
        status: 'unknown',
        reason: 'pass without evidence refs — not acceptable for completion',
      });
      continue;
    }
    const admissible = policy.admissibleTiers;
    if (admissible && !result.evidence.some((e) => admissible.includes(e.tier))) {
      const tiers = [...new Set(result.evidence.map((e) => e.tier))].join(', ');
      unsatisfied.push({
        id,
        status: 'unknown',
        reason: `pass with inadmissible evidence tiers only (${tiers}) — not acceptable for completion`,
      });
      continue;
    }
    satisfied.push(id);
  }

  const verdict: CompletionVerdict =
    unsatisfied.length === 0
      ? 'PASS'
      : unsatisfied.some((u) => u.status === 'fail')
        ? 'REPAIR_REQUIRED'
        : 'BLOCKED';

  return {
    verdict,
    satisfied,
    unsatisfied,
    evidenceComplete: unsatisfied.length === 0,
    summary:
      verdict === 'PASS'
        ? `complete: ${satisfied.length}/${ids.length} required criteria pass with evidence`
        : `incomplete (${verdict}): ${unsatisfied
            .map((u) => `${u.id}=${u.status}`)
            .join(', ')}`,
  };
}

/** Alias for the strict BUILD/mission completion gate (ZELARI_STRICT_DONE). */
export const strictBuildGate = evaluateCompletion;
