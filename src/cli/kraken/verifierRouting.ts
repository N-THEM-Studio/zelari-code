/**
 * verifierRouting — t21 (§P1.D × PW §10): risk-based cross-family verifier
 * routing on top of the P0.6 cross-model default.
 *
 *   low      ⇒ reviewer OFF — deterministic verification only (strict gate).
 *   medium   ⇒ 1 reviewer, different family, ECONOMICAL (cheapest model
 *              within that family; no pricing API exists, so the established
 *              cheap heuristic from krakenModel.isCheapModelId/pickCheapModel
 *              is the "cheap" signal; unresolvable ⇒ first different-family
 *              candidate = the current P0.6 pick).
 *   high     ⇒ 1 reviewer, different family, STRONGEST available (same
 *              situation: prefer non-cheap ids within that family, else the
 *              P0.6 first different-family candidate).
 *   critical ⇒ 2 reviewers from two DIFFERENT families (neither = builder),
 *              merged PESSIMISTICALLY; reviewer disagreement surfaces as a
 *              `verifier-divergence` evidence item in the proof (PW §10).
 *
 * Risk resolution precedence: ZELARI_VERIFY_RISK env (host override) >
 * active TaskContract (t22 seam, setActiveContractScope) > 'medium'.
 *
 * ADVISORY-ONLY invariant is untouched: whatever this module routes can never
 * rewrite the deterministic gate verdict — reviewers inform, they do not
 * decide (ADR-0026 / CompletionPolicy locks stay the only authority).
 */
import { basename } from 'node:path';
import { TASK_RISKS, type TaskRisk } from '@zelari/core';
import type { VerifierReview } from '@zelari/core/verification';
import {
  inferModelFamily,
  isCheapModelId,
  pickCheapModel,
  pickDifferentFamily,
  resolveCrossModelVerifier,
} from '../tools/krakenModel.js';
// t22 seam (required): the active contract of THIS turn carries its risk.
import { activeContractScope } from './contractCompiler.js';
// t29 (§16): passive reputation consult — records come from the injected
// store snapshot (reputationStore.ts); null/empty source keeps the t21
// behavior byte-identical. Family constraints below are NOT weakened: the
// reputation pick only reorders WITHIN an already family-filtered pool.
import { reputationFamilyPick, type ReputationRecord } from './modelReputation.js';
import type { VerifierDivergenceEvidence } from './verificationBridge.js';

type Env = Record<string, string | undefined>;

// t29: runtime reputation source. The host (graph executor) loads the
// per-repo JSONL store and injects a snapshot; tests inject fixtures and
// reset with setReputationSource(null).
let reputationSource: readonly ReputationRecord[] | null = null;

/** Inject (or clear, with null) the reputation records routing consults. */
export function setReputationSource(records: readonly ReputationRecord[] | null): void {
  reputationSource = records;
}

/** Host override switch: wins over the task-contract risk declaration. */
export const VERIFY_RISK_ENV = 'ZELARI_VERIFY_RISK';

export interface RoutingReviewer {
  /** Effective provider+model identity to invoke. */
  identity: { provider: string; model: string };
  /** Coarse provider family bucket (krakenModel.inferModelFamily). */
  family: string;
  /** Why this reviewer was chosen at this risk level. */
  role: 'economical' | 'strongest' | 'second-opinion';
}

export interface VerifierRoutingDecision {
  risk: TaskRisk;
  /** Stable machine-readable code for logs/tests (see table above). */
  rationaleCode: string;
  reviewers: RoutingReviewer[];
}

export interface ResolveVerifierRoutingOptions {
  selectionMode?: 'inherit' | 'fixed';
  /** Parent/session identity (inherit mode). */
  session?: { provider: string; model: string } | null;
  /** P0.6 cross-model family candidates (host seam). */
  familyCandidates?: readonly { provider: string; model: string }[];
  env?: Env;
  /**
   * t29: repo identity for reputation buckets (basename of the workspace
   * root at the host seam). Omitted ⇒ basename(process.cwd()) — the CLI runs
   * from the workspace root, so this matches the executor's recording key in
   * the common case (documented v1 approximation).
   */
  repo?: string | null;
}

/**
 * Active risk for the verify pass: `ZELARI_VERIFY_RISK` wins over the ACTIVE
 * TaskContract (`contractCompiler.setActiveContractScope`, t22); absent both
 * ⇒ 'medium' (the historical single-reviewer behavior). Invalid env values
 * are ignored so a typo cannot silently downgrade enforcement.
 */
export function activeRisk(env: Env = process.env): TaskRisk {
  const raw = env[VERIFY_RISK_ENV]?.trim().toLowerCase();
  if (raw && (TASK_RISKS as readonly string[]).includes(raw)) return raw as TaskRisk;
  return activeContractScope()?.contract.risk ?? 'medium';
}

/** Candidate model ids inside one family bucket, stable first-seen order. */
function idsInFamily(
  family: string,
  candidates: readonly { provider: string; model: string }[],
): string[] {
  const ids: string[] = [];
  for (const c of candidates) {
    if (!c.provider || !c.model) continue;
    if (inferModelFamily(c.provider, c.model) === family && !ids.includes(c.model)) {
      ids.push(c.model);
    }
  }
  return ids;
}

/** t29: family-pool model ids → rankable candidate objects (real provider when known). */
function poolCandidates(
  pool: readonly string[],
  candidates: readonly { provider: string; model: string }[],
  fallbackProvider: string,
): { provider: string; model: string }[] {
  return pool.map((m) => candidates.find((c) => c.model === m) ?? { provider: fallbackProvider, model: m });
}

/**
 * Pick within an already-selected family:
 * - 'cheap': krakenModel.pickCheapModel (the repo's only cheap signal);
 * - 'strong': first id NOT matching the cheap heuristic (no pricing API and
 *   no exported strong registry exists — documented per t21 brief; degrades
 *   to the family's stable first candidate when everything looks cheap).
 */
function pickWithinFamily(family: string, builderModel: string, ids: readonly string[], prefer: 'cheap' | 'strong'): string {
  if (ids.length === 0) return builderModel;
  if (prefer === 'cheap') {
    return pickCheapModel(builderModel, ids) ?? ids[0]!;
  }
  const strong = ids.filter((id) => !isCheapModelId(id));
  return strong[0] ?? ids[0]!;
}

/** Critical fallback: second reviewer from another family than A's/builder. */
function secondCrossPick(
  builder: { provider: string; model: string },
  firstFamily: string,
  candidates: readonly { provider: string; model: string }[],
  firstIdentity: { provider: string; model: string },
): { identity: { provider: string; model: string }; family: string } | null {
  const remaining = candidates.filter((c) => inferModelFamily(c.provider, c.model) !== firstFamily);
  const alt = pickDifferentFamilyIdentity(builder, remaining, firstIdentity);
  return alt;
}

function pickDifferentFamilyIdentity(
  builder: { provider: string; model: string },
  candidates: readonly { provider: string; model: string }[],
  avoidIdentity?: { provider: string; model: string },
): { identity: { provider: string; model: string }; family: string } | null {
  const picked = pickDifferentFamily(builder, candidates);
  if (!picked || picked.provider === '') return null;
  if (
    avoidIdentity &&
    picked.provider === avoidIdentity.provider &&
    picked.model === avoidIdentity.model
  ) {
    return null;
  }
  return { identity: picked, family: inferModelFamily(picked.provider, picked.model) };
}

/**
 * Resolve the reviewer set for one advisory verify pass.
 *
 * Precedence mirrors the pre-t21 P0.6 resolution path: a FIXED dedicated
 * selection IS the user-configured reviewer (kept verbatim; critical cannot
 * conjure independence around it and degrades to a single review). Inherit
 * mode reuses resolveCrossModelVerifier for the primary so ZELARI_KRAKEN_*
 * semantics stay identical at every risk; strength/economy refinement applies
 * ONLY to a successful cross-family pick — same-family fallback keeps the
 * session identity verbatim (P0.6 parity, never a worse model than today).
 *
 * Degrade-and-continue: missing/incomplete candidates reduce the reviewer
 * count (encoded in rationaleCode), never throw and never fabricate one.
 */
export function resolveVerifierRouting(
  builderIdentity: { provider: string; model: string } | null,
  risk: TaskRisk,
  opts: ResolveVerifierRoutingOptions = {},
): VerifierRoutingDecision {
  if (risk === 'low') {
    // PW §10: reviewer OFF — deterministic checks are the whole verdict basis.
    return { risk, rationaleCode: 'reviewer-off-low-risk-deterministic-only', reviewers: [] };
  }
  const base = opts.selectionMode === 'fixed'
    ? builderIdentity
    : (opts.session ?? builderIdentity);
  if (!base || !base.provider || !base.model) {
    return { risk, rationaleCode: 'no-verifiable-identity', reviewers: [] };
  }
  if (opts.selectionMode === 'fixed') {
    return {
      risk,
      rationaleCode: risk === 'critical' ? 'critical-fixed-single-reviewer' : 'fixed-dedicated-verifier',
      reviewers: [{ identity: base, family: inferModelFamily(base.provider, base.model), role: 'strongest' }],
    };
  }

  const candidates = (opts.familyCandidates ?? []).filter((c) => c.provider && c.model);
  const builderFamily = inferModelFamily(base.provider, base.model);
  const cross = resolveCrossModelVerifier(base, candidates, opts.env ?? process.env);

  if (risk !== 'critical') {
    if (cross && inferModelFamily(cross.provider, cross.model) !== builderFamily) {
      const family = inferModelFamily(cross.provider, cross.model);
      const pool = [...new Set([cross.model, ...idsInFamily(family, candidates)])];
      const prefer = risk === 'medium' ? 'cheap' : 'strong';
      // t29: when a trusted reputation sample exists for this (repo, verify)
      // bucket, the pool's top-ranked identity wins — same family constraint,
      // better in-family choice; otherwise the cheap/strong heuristic stands.
      const repPick = reputationFamilyPick(
        reputationSource,
        poolCandidates(pool, candidates, cross.provider),
        opts.repo ?? basename(process.cwd()),
      );
      const identity = repPick ?? {
        provider: cross.provider,
        model: pickWithinFamily(family, cross.model, pool, prefer),
      };
      return {
        risk,
        rationaleCode: repPick
          ? `cross-family-${risk === 'medium' ? 'economical' : 'strongest-available'}-reputation`
          : risk === 'medium'
            ? 'cross-family-economical'
            : 'cross-family-strongest-available',
        reviewers: [{ identity, family, role: risk === 'medium' ? 'economical' : 'strongest' }],
      };
    }
    // No usable different-family candidate: keep the session identity verbatim.
    return {
      risk,
      rationaleCode: risk === 'medium' ? 'same-family-fallback-medium' : 'same-family-fallback-high',
      reviewers: [{ identity: base, family: builderFamily, role: risk === 'medium' ? 'economical' : 'strongest' }],
    };
  }

  // critical: two independent families. First choice = strongest within the
  // primary cross family (or session fallback when none exists).
  let firstReviewer: RoutingReviewer;
  if (cross && inferModelFamily(cross.provider, cross.model) !== builderFamily) {
    const family = inferModelFamily(cross.provider, cross.model);
    const pool = [...new Set([cross.model, ...idsInFamily(family, candidates)])];
    firstReviewer = {
      // t29: reputation-refined within the primary family (constraint intact);
      // falls back to the strongest heuristic when no trusted sample exists.
      identity: reputationFamilyPick(
        reputationSource,
        poolCandidates(pool, candidates, cross.provider),
        opts.repo ?? basename(process.cwd()),
      ) ?? {
        provider: cross.provider,
        model: pickWithinFamily(family, cross.model, pool, 'strong'),
      },
      family,
      role: 'strongest',
    };
  } else {
    firstReviewer = { identity: base, family: builderFamily, role: 'second-opinion' };
  }

  if (firstReviewer.family === builderFamily) {
    // Not even one different-family candidate: single degraded review.
    return { risk, rationaleCode: 'critical-single-same-family-degraded', reviewers: [firstReviewer] };
  }
  let second = secondCrossPick(base, firstReviewer.family, candidates, firstReviewer.identity);
  let code = 'critical-dual-cross-family-pessimistic-merge';
  if (!second) {
    // Only one other family: take a DIFFERENT model within it (weaker but
    // still a distinct judge); nothing left ⇒ drop the second reviewer.
    const sameFamilyAlt = candidates.find(
      (c) => inferModelFamily(c.provider, c.model) === firstReviewer.family &&
        !(c.provider === firstReviewer.identity.provider && c.model === firstReviewer.identity.model),
    );
    second = sameFamilyAlt
      ? { identity: { provider: sameFamilyAlt.provider, model: sameFamilyAlt.model }, family: firstReviewer.family }
      : null;
    if (second) code = 'critical-second-reviewer-same-family';
    else return { risk, rationaleCode: 'critical-single-cross-family-degraded', reviewers: [firstReviewer] };
  }
  const secondRole = second.family === firstReviewer.family ? firstReviewer.role : 'second-opinion';
  return {
    risk,
    rationaleCode: code,
    reviewers: [firstReviewer, { ...second, role: secondRole }],
  };
}

/** Pessimistic merge order: any blocker/fail dominates confidence. */
const VERDICT_RANK: Record<VerifierReview['verdict'], number> = {
  rejected: 2,
  unknown: 1,
  confirmed: 0,
};

/**
 * Merge N reviews pessimistically: the WORST verdict wins (rejected beats
 * unknown beats confirmed; earliest review wins exact ties so behavior is
 * deterministic). The merged review is what attaches to the gate payload.
 */
export function mergeVerifierVerdicts(reviews: readonly VerifierReview[]): VerifierReview {
  if (reviews.length === 0) throw new Error('mergeVerifierVerdicts: no reviews');
  return reviews.reduce((worst, next) =>
    VERDICT_RANK[next.verdict] > VERDICT_RANK[worst.verdict] ? next : worst,
  );
}

/** True when the two verdicts disagree (recorded as evidence, not resolved). */
export function verdictsDiverge(reviews: readonly VerifierReview[]): boolean {
  return new Set(reviews.map((r) => r.verdict)).size > 1;
}

/**
 * Build the `verifier-divergence` EVIDENCE item (PW §10): when two critical-
 * risk reviewers disagree (one blocker, one pass — or any mismatch), BOTH
 * verdicts travel side by side into the proof instead of one winning quietly.
 * Rationale text is capped like every other proof cell. Null for <2 reviews
 * (single-reviewer runs carry no divergence entry — payloads stay stable).
 */
export function divergenceFromReviews(
  reviews: readonly VerifierReview[],
  meta?: readonly { family?: string; role?: string }[],
): VerifierDivergenceEvidence | null {
  if (reviews.length < 2) return null;
  return {
    kind: 'verifier-divergence',
    risk: 'critical',
    divergent: verdictsDiverge(reviews),
    mergedVerdict: mergeVerifierVerdicts(reviews).verdict,
    reviews: reviews.map((r, i) => ({
      provider: r.effectiveModel.provider ?? null,
      model: r.effectiveModel.model ?? null,
      family: meta?.[i]?.family ?? inferModelFamily(r.effectiveModel.provider ?? '', r.effectiveModel.model ?? ''),
      role: meta?.[i]?.role ?? 'strongest',
      verdict: r.verdict,
      score: r.score ?? null,
      rationale: r.rationale?.slice(0, 500) ?? null,
      fallback: r.fallback ?? null,
    })),
  };
}

