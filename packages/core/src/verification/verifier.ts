/**
 * verification/verifier.ts — optional LLM VerifierService (Phase 3B, alpha).
 *
 * Contract (plan §14 / ADR-0023):
 * - enable/disable + model selection `inherit | fixed` (same semantics as the
 *   1.49 `--verifier-provider/--verifier-model/--verifier-clear` channel);
 * - the EFFECTIVE provider/model is always recorded in the emitted event;
 * - unparseable/absent model output degrades to a DECLARED discrete fallback
 *   (`verdict: 'unknown', fallback: 'discrete'`) — never to `pass`;
 * - ADVISORY ONLY: reviews and scores never enter CompletionPolicy. No done
 *   based on the score alone; no P2 bypass;
 * - progress score is labeled "experimental", never "% complete";
 * - BoN selection requires BOTH config.bon.enabled and the experimental flag.
 */

import { z } from 'zod';
import type { SessionEventInput } from '../session/types.js';
import { isExperimentalEnabled } from '../experimental.js';
import type { VerificationResult } from './types.js';

export const ModelSelectionSchema = z.union([
  z.object({ mode: z.literal('inherit') }),
  z.object({ mode: z.literal('fixed'), provider: z.string().min(1), model: z.string().min(1) }),
]);
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const BonConfigSchema = z.object({
  enabled: z.boolean().default(false),
  n: z.number().int().min(2).max(8).default(3),
});

export const VerifierConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: ModelSelectionSchema.default({ mode: 'inherit' }),
  progressScoring: z.boolean().default(false),
  bon: BonConfigSchema.default({ enabled: false, n: 3 }),
});
export type VerifierConfig = z.infer<typeof VerifierConfigSchema>;

export const DEFAULT_VERIFIER_CONFIG: VerifierConfig = VerifierConfigSchema.parse({});

export interface VerifierModelResponse {
  text: string;
  provider?: string;
  model?: string;
  /** Present only when the provider exposes them (optional path). */
  logprobs?: number[];
}

export type VerifierModelCaller = (input: { system: string; user: string }) => Promise<VerifierModelResponse>;

export interface VerifierReview {
  verdict: 'confirmed' | 'rejected' | 'unknown';
  score?: number;
  rationale?: string;
  /** Declared degradation path (discrete fallback), when used. */
  fallback?: 'discrete';
  effectiveModel: { mode: 'inherit' | 'fixed'; provider?: string; model?: string };
  usedLogprobs: boolean;
}

export interface SessionModelInfo {
  provider?: string;
  model?: string;
}

export interface Hypothesis {
  id: string;
  summary?: string;
  /** Optional prior score (e.g. from selection). */
  score?: number;
}

export interface RankingResult<T extends { id: string }> {
  ordered: T[];
  /** True when no usable scores existed and original order was kept. */
  fallbackUsed: boolean;
}

export interface BonSelection {
  enabled: boolean;
  selected?: string;
  fallbackUsed: boolean;
  reason: string;
}

export interface ProgressScore {
  tier: 'deterministic' | 'blended';
  value: number | null;
  label: string;
}

const ReviewOutputSchema = z.object({
  verdict: z.enum(['confirmed', 'rejected', 'unknown']),
  score: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
});

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface VerifierServiceDeps {
  callModel: VerifierModelCaller;
  config?: VerifierConfig;
  emit?: (input: SessionEventInput) => Promise<unknown>;
  env?: Record<string, string | undefined>;
}

const VERIFIER_SYSTEM_PROMPT = [
  'You are an independent completion verifier.',
  'You receive the original task, a git diff summary, a test output excerpt,',
  'and deterministic verification results — never the builder narration.',
  'Answer with a single JSON object and nothing else:',
  '{"verdict":"confirmed|rejected|unknown","score":0..1,"rationale":"..."}',
  'Rules: never confirm when a required deterministic check failed or is unknown;',
  'when evidence is insufficient, use verdict "unknown".',
].join('\n');

export class VerifierService {
  readonly config: VerifierConfig;

  constructor(private readonly deps: VerifierServiceDeps) {
    this.config = deps.config ?? DEFAULT_VERIFIER_CONFIG;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Resolve the model that would actually be used (§14: log the effective model). */
  effectiveModel(session?: SessionModelInfo): { mode: 'inherit' | 'fixed'; provider?: string; model?: string } {
    if (this.config.model.mode === 'fixed') {
      const fixed = this.config.model;
      return { mode: 'fixed', provider: fixed.provider, model: fixed.model };
    }
    return { mode: 'inherit', provider: session?.provider, model: session?.model };
  }

  /** Review a claimed completion. Degrades to a declared discrete fallback. */
  async reviewCompletion(request: {
    summary: string;
    results: readonly VerificationResult[];
    session?: SessionModelInfo;
    /** Original user task (blind-review context). */
    task?: string;
    /** Git diff summary of the work under review. */
    diffSummary?: string;
    /** Excerpt of deterministic test/typecheck/build/lint output. */
    testOutputExcerpt?: string;
  }): Promise<VerifierReview> {
    const effective = this.effectiveModel(request.session);
    const base = { effectiveModel: effective, usedLogprobs: false } as const;
    if (!this.config.enabled) {
      return { ...base, verdict: 'unknown', fallback: 'discrete', rationale: 'verifier disabled' };
    }
    let response: VerifierModelResponse;
    try {
      response = await this.deps.callModel({
        system: VERIFIER_SYSTEM_PROMPT,
        // Blind review payload: evidence only (task, diff summary, test output
        // excerpt, deterministic results). Builder narration/reasoning is
        // structurally excluded — undefined keys are omitted.
        user: JSON.stringify(
          {
            ...(request.task === undefined ? {} : { task: request.task }),
            summary: request.summary,
            ...(request.diffSummary === undefined ? {} : { diffSummary: request.diffSummary }),
            ...(request.testOutputExcerpt === undefined
              ? {}
              : { testOutputExcerpt: request.testOutputExcerpt }),
            deterministicResults: request.results.map((r) => ({
              criterionId: r.criterionId,
              status: r.status,
              detail: r.detail,
            })),
          },
          null,
          2,
        ),
      });
    } catch (err) {
      const review: VerifierReview = {
        ...base,
        verdict: 'unknown',
        fallback: 'discrete',
        rationale: `verifier call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      await this.emitReview(review);
      return review;
    }
    const parsed = ReviewOutputSchema.safeParse(extractJson(response.text));
    if (!parsed.success) {
      const review: VerifierReview = {
        ...base,
        verdict: 'unknown',
        fallback: 'discrete',
        rationale: 'verifier output unparseable — declared discrete fallback',
        effectiveModel: {
          ...effective,
          provider: response.provider ?? effective.provider,
          model: response.model ?? effective.model,
        },
      };
      await this.emitReview(review);
      return review;
    }
    const blockedByDeterministic = request.results.some(
      (r) => r.status === 'fail' && parsed.data.verdict === 'confirmed',
    );
    const review: VerifierReview = {
      ...base,
      verdict: blockedByDeterministic ? 'unknown' : parsed.data.verdict,
      score: parsed.data.score,
      rationale: blockedByDeterministic
        ? 'cannot confirm while a deterministic check failed — downgraded to unknown'
        : parsed.data.rationale,
      fallback: blockedByDeterministic ? 'discrete' : undefined,
      effectiveModel: {
        ...effective,
        provider: response.provider ?? effective.provider,
        model: response.model ?? effective.model,
      },
      usedLogprobs: Array.isArray(response.logprobs) && response.logprobs.length > 0,
    };
    await this.emitReview(review);
    return review;
  }

  private async emitReview(review: VerifierReview): Promise<void> {
    if (!this.deps.emit) return;
    await this.deps.emit({
      kind: 'verification.run',
      actor: { type: 'system', role: 'verifier' },
      data: {
        source: 'verifier-model',
        verdict: review.verdict,
        score: review.score,
        fallback: review.fallback ?? null,
        provider: review.effectiveModel.provider ?? null,
        model: review.effectiveModel.model ?? null,
        selectionMode: review.effectiveModel.mode,
      },
    });
  }

  /** Rank hypotheses by score; original order is the declared fallback. */
  rankHypotheses<T extends Hypothesis>(hypotheses: readonly T[]): RankingResult<T> {
    const scored = hypotheses.filter((h) => typeof h.score === 'number');
    if (scored.length === 0) {
      return { ordered: [...hypotheses], fallbackUsed: true };
    }
    const ordered = [...hypotheses].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    return { ordered, fallbackUsed: false };
  }

  /** BoN alpha selection: requires config + experimental flag; ties declare fallback. */
  selectBestN(candidates: readonly Hypothesis[]): BonSelection {
    const env = this.deps.env ?? process.env;
    if (!this.config.bon.enabled) {
      return { enabled: false, fallbackUsed: true, reason: 'BoN disabled in verifier config (default)' };
    }
    if (!isExperimentalEnabled('bon', env)) {
      return {
        enabled: false,
        fallbackUsed: true,
        reason: 'BoN requires ZELARI_EXPERIMENTAL=bon (alpha flag)',
      };
    }
    const { ordered, fallbackUsed } = this.rankHypotheses(candidates);
    const top = ordered[0];
    const second = ordered[1];
    const margin = (top?.score ?? 0) - (second?.score ?? 0);
    if (fallbackUsed || !top || (second !== undefined && margin < 0.05)) {
      return {
        enabled: true,
        selected: candidates[0]?.id,
        fallbackUsed: true,
        reason: fallbackUsed
          ? 'no usable scores — declared fallback to first candidate'
          : `score margin ${margin.toFixed(3)} below 0.05 — declared fallback to first candidate`,
      };
    }
    return { enabled: true, selected: top.id, fallbackUsed: false, reason: 'selected by score' };
  }

  /**
   * Epistemically honest progress: deterministic ratio, optionally blended
   * with the verifier score. Always labeled `experimental`, never "% complete".
   */
  progressScore(
    results: readonly VerificationResult[],
    review?: VerifierReview,
  ): ProgressScore {
    const total = results.length;
    const passed = results.filter((r) => r.status === 'pass').length;
    const deterministic = total === 0 ? null : passed / total;
    if (this.config.progressScoring && review?.score !== undefined) {
      const blended = deterministic === null ? review.score : 0.5 * deterministic + 0.5 * review.score;
      return { tier: 'blended', value: blended, label: `Verifier score: ${blended.toFixed(2)} · experimental` };
    }
    return {
      tier: 'deterministic',
      value: deterministic,
      label: deterministic === null ? 'no criteria yet' : `Evidence: ${passed}/${total} criteria pass`,
    };
  }
}
