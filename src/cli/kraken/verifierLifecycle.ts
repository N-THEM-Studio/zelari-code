/**
 * verifierLifecycle — 2.1 T4: wires the core VerifierService into the normal
 * headless lifecycle as an OPT-IN advisory pass (ADR-0023 × ADR-0026).
 *
 * The 2.0 stable shipped VerifierService as a core capability (config, tests,
 * Desktop seam) without lifecycle invocation. This module closes that gap for
 * the Kraken headless path:
 *
 *   deterministic gate (evaluateStrictBuildGate)
 *          ↓
 *   optional VerifierService.reviewCompletion()   ← this module, opt-in
 *          ↓
 *   advisory result → spine `verification.run` event + gate payload
 *
 * Contract:
 * - OPT-IN, zero default cost: the review runs ONLY when a dedicated verifier
 *   is configured in provider.json (`krakenVerifier` → ModelSelection
 *   `fixed`, mapped by verifierResolution.ts) OR ZELARI_VERIFIER_REVIEW is
 *   explicitly on (1|on|true). `ZELARI_VERIFIER_REVIEW=0|off|false` forces
 *   OFF even with a fixed override. Default (inherit, no env): OFF — the
 *   2.0 baseline cost/behaviour is untouched (ADR-0026).
 * - ADVISORY ONLY: the review is attached to the StrictBuildGateEvaluation
 *   and serialized into the `verification.run` payload; it NEVER touches
 *   verdict/blocked. The CompletionPolicy locks (unknown ≠ pass, verifier
 *   never rewrites a deterministic verdict) remain the only authority.
 * - Degrade-and-continue: a failed/unparseable verifier call degrades to a
 *   DECLARED discrete fallback inside VerifierService and never fails the
 *   parent turn (mirrors the 1.x selection-verifier discipline).
 */
import type { ProviderStreamFn } from '@zelari/core/harness';
import type { SessionEventInput } from '@zelari/core/session';
import {
  VerifierService,
  type ModelSelection,
  type VerifierModelCaller,
  type VerifierReview,
  type VerificationResult,
} from '@zelari/core/verification';
import { collectProviderText } from '../tools/krakenSelectTool.js';
import { getWorkingDiff } from '../gitOps.js';
import { loadVerifierModelSelection } from './verifierResolution.js';
// t21 (§P1.D): risk-based reviewer routing on top of the P0.6 cross-family default.
import { activeRisk, divergenceFromReviews, mergeVerifierVerdicts, resolveVerifierRouting } from './verifierRouting.js';
import type { StrictBuildGateEvaluation } from './verificationBridge.js';
import type { TaskRisk } from '@zelari/core';

type Env = Record<string, string | undefined>;

/** Provider + model identity (the run parent, or a fixed verifier). */
export interface VerifierIdentity {
  provider: string;
  model: string;
}

/**
 * Opt-in rule (see module doc): explicit env wins in both directions;
 * otherwise a dedicated (fixed) verifier selection enables the review.
 */
export function verifierReviewEnabled(
  selection: ModelSelection = loadVerifierModelSelection(),
  env: Env = process.env,
): boolean {
  const v = env.ZELARI_VERIFIER_REVIEW?.toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'on') return true;
  return selection.mode === 'fixed';
}

/**
 * Adapt a provider stream factory into the VerifierModelCaller seam.
 * `loadStream` receives the EFFECTIVE identity (fixed override, or the run
 * parent when inherit) so a dedicated verifier can live on another provider.
 */
export function makeVerifierCallModel(
  loadStream: (provider: string, model: string) => Promise<ProviderStreamFn | null>,
  identity: VerifierIdentity,
  timeoutMs: number = 120_000,
): VerifierModelCaller {
  return async ({ system, user }) => {
    const stream = await loadStream(identity.provider, identity.model);
    if (!stream) {
      throw new Error(`no provider config for verifier "${identity.provider}"`);
    }
    const { text } = await collectProviderText(stream, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      model: identity.model,
      provider: identity.provider,
      tools: [],
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { text, provider: identity.provider, model: identity.model };
  };
}

export interface VerifierReviewDeps {
  /** Env snapshot (tests); default process.env. */
  env?: Env;
  /** Mapped override; default: live provider.json read (verifierResolution). */
  selection?: ModelSelection;
  /** Parent run identity — `inherit` resolves to it. */
  session?: VerifierIdentity;
  /** Stream factory keyed by EFFECTIVE provider+model (production wiring). */
  loadStream?: (provider: string, model: string) => Promise<ProviderStreamFn | null>;
  /** Direct call seam (tests) — wins over loadStream. */
  callModel?: VerifierModelCaller;
  /** Spine emitter — VerifierService appends its own `verification.run` review event. */
  emit?: (input: SessionEventInput) => Promise<unknown>;
  /** Verifier call timeout. Default 120s (mirrors the 1.x selection verifier). */
  timeoutMs?: number;
  /** Original user task text for the blind review (caller-provided). */
  task?: string;
  /** Working directory for the git diff; default process.cwd(). */
  cwd?: string;
  /**
   * Injectable diff seam; production default = getWorkingDiff from
   * ../gitOps.js (staged working-tree diff). Never allowed to throw into
   * the review path.
   */
  getDiff?: (opts: {
    cwd: string;
    maxChars: number;
    staged?: boolean;
  }) => Promise<{ diff: string; empty: boolean; truncated: boolean }>;
  /**
   * P0.6 cross-model family candidates; consulted ONLY in inherit mode via
   * resolveCrossModelVerifier. Default: unused (session identity kept).
   */
  familyCandidates?: { provider: string; model: string }[];
  /**
   * t21: explicit verify-risk for this pass (`low|medium|high|critical`).
   * Default: activeRisk(env) — ZELARI_VERIFY_RISK > active contract > medium.
   */
  risk?: TaskRisk;
}

/** Criterion ids that look like deterministic test/typecheck/build/lint runs. */
function isTestEvidenceCriterion(criterionId: string): boolean {
  const id = criterionId.toLowerCase();
  return ['test', 'typecheck', 'build', 'lint'].some((k) => id.includes(k));
}

/**
 * Blind evidence excerpt: criterionId + status + detail for deterministic
 * test/typecheck/build/lint criteria, capped at maxChars. Empty when none.
 */
export function extractTestOutputExcerpt(
  results: readonly { criterionId: string; status: string; detail?: string }[],
  maxChars = 4000,
): string {
  const lines: string[] = [];
  for (const r of results) {
    if (!isTestEvidenceCriterion(r.criterionId)) continue;
    lines.push([r.criterionId, r.status, r.detail].filter(Boolean).join(' — '));
  }
  if (lines.length === 0) return '';
  return lines.join('\n').slice(0, maxChars);
}

export interface BlindReviewInput {
  task?: string;
  summary: string;
  diffSummary?: string;
  testOutputExcerpt?: string;
  results: readonly VerificationResult[];
}

/**
 * Build the BLIND review input for VerifierService.reviewCompletion:
 * original task, synthetic deterministic-evidence summary, staged git diff
 * summary, and a capped test-output excerpt. Never reads session messages,
 * builder reasoning, or assistant text — the verifier sees evidence only.
 * Every extra input degrades independently (empty/failing diff → omitted).
 */
export async function buildBlindReviewInput(
  evaluation: StrictBuildGateEvaluation,
  deps: VerifierReviewDeps,
): Promise<BlindReviewInput> {
  const results = evaluation.results ?? [];
  const passed = results.filter((r) => r.status === 'pass').length;
  const verdict = evaluation.evaluation?.verdict ?? 'UNKNOWN';
  const summary =
    `Kraken BUILD turn — deterministic evidence: ${passed}/${results.length} ` +
    `criteria pass, completion verdict ${verdict}.`;
  const task = deps.task?.trim();
  const testOutputExcerpt = extractTestOutputExcerpt(results);
  let diffSummary: string | undefined;
  try {
    const res = await (deps.getDiff ?? getWorkingDiff)({
      cwd: deps.cwd ?? process.cwd(),
      maxChars: 8000,
      staged: true,
    });
    if (res && !res.empty && res.diff) diffSummary = res.diff;
  } catch {
    // degrade-and-continue: the blind review proceeds without the diff
  }
  return {
    ...(task ? { task } : {}),
    summary,
    ...(diffSummary !== undefined ? { diffSummary } : {}),
    ...(testOutputExcerpt ? { testOutputExcerpt } : {}),
    results,
  };
}

/**
 * Run the advisory completion review and ATTACH it to the evaluation
 * (`evaluation.review`). Returns null when disabled or not applicable (no
 * strict evidence ran this turn). Never mutates verdict/blocked — advisory
 * by construction; failures degrade inside VerifierService.
 */
export async function runAdvisoryVerifierReview(
  evaluation: StrictBuildGateEvaluation,
  deps: VerifierReviewDeps = {},
): Promise<VerifierReview | null> {
  if (!evaluation.evaluation || !evaluation.results) return null;
  const env = deps.env ?? process.env;
  const selection = deps.selection ?? loadVerifierModelSelection();
  if (!verifierReviewEnabled(selection, env)) return null;
  // t21 / PW §10: LOW risk turns the LLM reviewer OFF — deterministic
  // verification only. The reviewer is ADVISORY, so its absence cannot
  // create an `unknown` blocker: `evaluation.review` simply stays unset and
  // the CompletionPolicy verdict rests solely on the deterministic criteria.
  const risk = deps.risk ?? activeRisk(env);
  if (risk === 'low') return null;
  // Route reviewers per risk (t21): resolves the identity family-wise exactly
  // like the previous P0.6 path (fixed selection wins; inherit may cross to a
  // different provider family), then refines economy/strength and, at critical
  // risk, adds an independent second-family reviewer.
  const route = resolveVerifierRouting(
    selection.mode === 'fixed' ? { provider: selection.provider, model: selection.model } : null,
    risk,
    {
      selectionMode: selection.mode === 'fixed' ? 'fixed' : 'inherit',
      session: deps.session ?? null,
      familyCandidates: deps.familyCandidates,
      env,
    },
  );
  const reviewers = route.reviewers;
  let callModel = deps.callModel;
  if (reviewers.length === 0 || (!callModel && !deps.loadStream)) return null;
  const blind = await buildBlindReviewInput(evaluation, deps);
  const reviews: VerifierReview[] = [];
  for (const reviewer of reviewers) {
    // One VerifierService per reviewer so each appends its own spine
    // `verification.run` event. Sequential on purpose — mirrors the single
    // advisory pass; no new spawn machinery.
    const call =
      callModel ??
      makeVerifierCallModel(deps.loadStream!, reviewer.identity, deps.timeoutMs);
    const service = new VerifierService({
      callModel: call,
      config: {
        enabled: true,
        model: selection,
        progressScoring: false,
        bon: { enabled: false, n: 3 },
      },
      emit: deps.emit,
      env,
    });
    reviews.push(await service.reviewCompletion({ ...blind, session: deps.session }));
  }
  // Single reviewer (low churn default): behavior identical to pre-t21.
  // Multiple reviewers (critical): merge PESSIMISTICALLY — any blocker/fail
  // wins over unknown wins over confirmed.
  const review = reviews.length > 1 ? mergeVerifierVerdicts(reviews) : reviews[0]!;
  evaluation.review = review;
  // PW §10: disagreement between the two critical reviewers becomes
  // structured EVIDENCE (`verifier-divergence`) in the verification.run
  // payload → completion proof json; it never rewrites the merged verdict.
  if (reviews.length > 1 && risk === 'critical') {
    evaluation.reviewDivergence = divergenceFromReviews(
      reviews,
      reviewers.map((r) => ({ family: r.family, role: r.role })),
    );
  }
  return review;
}
