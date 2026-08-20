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
} from '@zelari/core/verification';
import { collectProviderText } from '../tools/krakenSelectTool.js';
import { loadVerifierModelSelection } from './verifierResolution.js';
import type { StrictBuildGateEvaluation } from './verificationBridge.js';

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
}

function resolveIdentity(
  selection: ModelSelection,
  session?: VerifierIdentity,
): VerifierIdentity | null {
  if (selection.mode === 'fixed') {
    return { provider: selection.provider, model: selection.model };
  }
  return session && session.provider && session.model ? session : null;
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
  const identity = resolveIdentity(selection, deps.session);
  let callModel = deps.callModel;
  if (!callModel) {
    if (!identity || !deps.loadStream) return null;
    callModel = makeVerifierCallModel(deps.loadStream, identity, deps.timeoutMs);
  }
  const service = new VerifierService({
    callModel,
    config: {
      enabled: true,
      model: selection,
      progressScoring: false,
      bon: { enabled: false, n: 3 },
    },
    emit: deps.emit,
    env,
  });
  const passed = evaluation.results.filter((r) => r.status === 'pass').length;
  const summary =
    `Kraken BUILD turn — deterministic evidence: ${passed}/${evaluation.results.length} ` +
    `criteria pass, completion verdict ${evaluation.evaluation.verdict}.`;
  const review = await service.reviewCompletion({
    summary,
    results: evaluation.results,
    session: deps.session,
  });
  evaluation.review = review;
  return review;
}
