/**
 * toolEmission — post-condition tool-emission checks (v0.7.6), extracted
 * verbatim from agents/councilApi.ts. Pure functions, zero module deps.
 */

// ── Post-condition tool emission check (v0.7.6) ────────────────────────────
//
// After each council member's turn, verify that the tools the role was
// REQUIRED to call were actually emitted. If the model skipped them, the
// downstream deliverable is incomplete (e.g. Minosse's risks.md missing,
// Lucifero's synthesis.md missing, Nettuno's tasks missing).
//
// This is a runtime guard, not a prompt-only fix: the role prompts in
// roles.ts (Fix e987284) already enumerate the required tools, but a
// non-deterministic model can still skip them. The check turns silent
// gaps into observable warnings without blocking the council run.
//
// Pure function — exported so it can be unit-tested without spinning up a
// full AgentHarness. See tests/unit/cli-councilToolEmission.test.ts.

export interface ToolEmissionRequirement {
  /** Tool name, e.g. 'createDocument'. */
  name: string;
  /** Minimum number of times this tool must have been emitted. */
  min: number;
}

export interface ToolEmissionCheckResult {
  /** True when every requirement is satisfied. */
  ok: boolean;
  /** Human-readable list of unmet requirements (empty when ok=true). */
  missing: string[];
}

/**
 * Pure helper: given the list of tool names a member emitted during its
 * turn, and a list of requirements, return whether all requirements are
 * met.
 */
export function checkMemberToolEmissions(
  _memberId: string,
  emittedToolNames: string[],
  requirements: ToolEmissionRequirement[],
): ToolEmissionCheckResult {
  if (requirements.length === 0) {
    return { ok: true, missing: [] };
  }
  // Tally emitted counts once for all requirements.
  const counts = new Map<string, number>();
  for (const name of emittedToolNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const req of requirements) {
    const got = counts.get(req.name) ?? 0;
    if (got < req.min) {
      missing.push(`${req.name} (got ${got}, need >= ${req.min})`);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * v0.7.8 — Per-member tool-emission requirement SETS for the design-phase
 * council run. The outer array is an OR of alternatives: the member's turn
 * is complete when ANY one set is fully satisfied. The FIRST set is the
 * preferred contract — its unmet requirements drive the warning message
 * and the forced-retry tool list.
 *
 * Nettuno has two ways to satisfy its contract:
 *   1. (preferred) ONE `createPlan` batch call — phases + nested tasks +
 *      milestone in a single emission. Retry budget: 1 call, which
 *      composer-2.5 handles reliably (same shape as the Minosse/Lucifero
 *      retries that already work).
 *   2. (legacy) the itemized trio — kept so stronger models (e.g. Opus)
 *      that emit createPhase/createTask/createMilestone directly are not
 *      flagged or retried.
 */
export const DESIGN_PHASE_REQUIREMENT_SETS: Record<string, ToolEmissionRequirement[][]> = {
  nettun: [
    [{ name: 'createPlan', min: 1 }],
    [
      { name: 'createPhase', min: 3 },
      { name: 'createTask', min: 6 },
      { name: 'createMilestone', min: 1 },
    ],
  ],
  geryon: [
    [{ name: 'createDocument', min: 3 }],
  ],
  pluton: [
    [{ name: 'createDocument', min: 1 }],
  ],
  minos: [
    [{ name: 'createDocument', min: 1 }],
  ],
  lucifer: [
    [{ name: 'createDocument', min: 1 }],
  ],
};

/**
 * Preferred (first) requirement set per member — kept as the flat map the
 * council loops pass to `applyRetryIfMissing` for the retry budget. For
 * Nettuno this is `createPlan min 1`, so the forced retry advertises ONE
 * tool with a 1-call budget instead of the old 13+-call itemized contract.
 */
export const DESIGN_PHASE_REQUIREMENTS: Record<string, ToolEmissionRequirement[]> =
  Object.fromEntries(
    Object.entries(DESIGN_PHASE_REQUIREMENT_SETS).map(([id, sets]) => [id, sets[0]!]),
  );

/**
 * Pure helper: OR-of-sets variant of {@link checkMemberToolEmissions}.
 * Returns ok when ANY set is fully satisfied. When none is, the missing
 * list reflects the FIRST (preferred) set so the warning and the retry
 * point the model at the cheapest way to comply.
 */
export function checkMemberToolEmissionSets(
  memberId: string,
  emittedToolNames: string[],
  sets: ToolEmissionRequirement[][],
): ToolEmissionCheckResult {
  if (sets.length === 0) {
    return { ok: true, missing: [] };
  }
  const results = sets.map((set) => checkMemberToolEmissions(memberId, emittedToolNames, set));
  if (results.some((r) => r.ok)) {
    return { ok: true, missing: [] };
  }
  return results[0]!;
}

/**
 * Run the post-condition check for a member and emit a console.warn when
 * any required tool was not emitted the minimum number of times. Returns
 * the check result so callers can act on it (Pass 3 may add automatic
 * retry; for now we only warn).
 */
export function enforceDesignPhaseToolEmissions(
  memberId: string,
  emittedToolNames: string[],
): ToolEmissionCheckResult {
  const sets = DESIGN_PHASE_REQUIREMENT_SETS[memberId];
  if (!sets || sets.length === 0) {
    return { ok: true, missing: [] };
  }
  const result = checkMemberToolEmissionSets(memberId, emittedToolNames, sets);
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `[council] member "${memberId}" did not emit required tools: ${result.missing.join(', ')}. ` +
        `The downstream .zelari/ deliverable may be incomplete. ` +
        `(A forced retry turn scoped to the missing tools follows; the deterministic ` +
        `complete-design fallback covers any remaining gap.)`,
    );
  }
  return result;
}
