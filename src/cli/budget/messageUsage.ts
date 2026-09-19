/**
 * messageUsage — provider-verified usage on the process metrics log (M1.1).
 *
 * Cache-hit-rate plan (`.zelari/docs/2026-09-18-cache-hit-rate-piano-implementazione.md`):
 * every LLM call appends ONE `kind: 'message'` row carrying the numbers the
 * provider actually returned — never the ~4-char/token approximation:
 *
 *   { kind: 'message', ts, sessionId, provider, model,
 *     promptTokens, completionTokens, cachedPromptTokens, costUsd }
 *
 * Why a dedicated record instead of enriching `kind: 'run'`: a run folds a
 * whole turn (every tool-loop iteration) into a single row, so the per-call
 * cache trajectory inside a turn — the thing the plan optimizes — is
 * unrecoverable. Usage inside `assistant.message` on the session spine stays
 * backlog (M4, needs an ADR-0021 contract check).
 *
 * The row rides the shared `MetricsLogger` singleton: same file
 * (`~/.zelari-code/metrics.jsonl`, override `ANATHEMA_METRICS_FILE`), same
 * rotation, same fire-and-forget queue. Short-lived processes (headless runs)
 * must await {@link flushMessageUsage} before returning so the last row lands.
 *
 * Best-effort by contract: telemetry never breaks a turn.
 */

import { getMetricsLogger } from '../metrics.js';
import { calculateCost } from '../modelPricing.js';

/**
 * One provider-verified LLM call, as persisted in `metrics.jsonl`.
 *
 * The numeric fields are declared on the shared `MetricsRecord`
 * (`src/cli/metrics.ts`: `promptTokens` / `completionTokens` /
 * `cachedPromptTokens`), so this row type-checks against the logger instead of
 * relying on unknown keys being serialized verbatim.
 */
export interface MessageUsageRecord {
  kind: 'message';
  ts: number;
  sessionId?: string;
  provider?: string;
  model?: string;
  /** Prompt tokens billed on this call — cache HITS included. */
  promptTokens: number;
  completionTokens: number;
  /** Subset of `promptTokens` served from the provider prompt cache. */
  cachedPromptTokens: number;
  /** Cache-aware USD cost (see modelPricing.calculateCost). */
  costUsd: number;
}

export interface MessageUsageInput {
  sessionId?: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Reported cache hits; clamped to `promptTokens` before persisting. */
  cachedPromptTokens?: number;
  /** Epoch ms override (tests). Defaults to now. */
  ts?: number;
}

/** Coerce a provider counter (possibly absent/NaN/negative) to a safe >= 0 int. */
function counter(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/**
 * Persist one `kind: 'message'` row computed from provider-reported usage.
 *
 * `cachedPromptTokens` is a SUBSET of `promptTokens` by definition: we clamp
 * it so a chatty gateway can never produce a hit rate above 100%.
 */
export function recordMessageUsage(input: MessageUsageInput): void {
  try {
    const promptTokens = counter(input.promptTokens);
    const completionTokens = counter(input.completionTokens);
    const cachedPromptTokens = Math.min(counter(input.cachedPromptTokens), promptTokens);
    const model = input.model ?? '';
    const record: MessageUsageRecord = {
      kind: 'message',
      ts: input.ts ?? Date.now(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(model ? { model } : {}),
      promptTokens,
      completionTokens,
      cachedPromptTokens,
      costUsd: calculateCost(model, promptTokens, completionTokens, cachedPromptTokens),
    };
    // Bound to a typed local (not an inline literal) on purpose: the persisted
    // row stays pinned to `MessageUsageRecord` — the subset of `MetricsRecord`
    // (`kind: 'message'`) that `--doctor` aggregates in M1.2.
    getMetricsLogger().record(record);
  } catch {
    // Fire-and-forget telemetry — a metrics failure must never fail a turn.
  }
}

/**
 * Drain the metrics write queue so the rows emitted by
 * {@link recordMessageUsage} reach disk before this process exits.
 * Never throws: a failed flush degrades to "no data" in `--doctor`.
 */
export async function flushMessageUsage(): Promise<void> {
  try {
    await getMetricsLogger().flush();
  } catch {
    // Best-effort: see doc comment above.
  }
}
