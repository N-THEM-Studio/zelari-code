/**
 * runTelemetry — provider-backed run usage accumulator.
 *
 * HarnessDev efficiency axis (steal #1, 2026-09 session): capability without
 * token-cost is half the picture, and every eval record on disk said
 * `tokens: null` because nobody aggregated the usage the provider already
 * reports. This module is the read-side fix: it watches the SAME BrainEvent
 * stream the spine mirrors (`spine.observe`) and accumulates:
 *
 *   - `message_end.usage`     → promptTokens / completionTokens /
 *                                cachedPromptTokens (provider ground truth,
 *                                Task G.4 `UsageBreakdown`; zero estimation)
 *   - `tool_execution_end`    → tool call count
 *
 * Rules (mirrors the ledger constitution, ADR-0036):
 *   - pure accumulator: no I/O, no clock, no LLM, never throws;
 *   - honest by construction: token fields surface ONLY when at least one
 *     provider usage report was seen — no chars/4 fabrication here;
 *   - additive: unknown event shapes are ignored, never fatal.
 */
export interface RunUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  toolCalls: number;
  /** How many provider usage reports back the token numbers (0 ⇒ estimated absence). */
  usageReports: number;
}

/** NDJSON `usage` event payload (flat shape `parseZelariUsage` already expects). */
export interface RunUsageEventPayload extends RunUsageTotals {
  type: 'usage';
  model?: string;
  provider?: string;
}

export class RunTelemetryAccumulator {
  private readonly totals: RunUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    toolCalls: 0,
    usageReports: 0,
  };

  constructor(private readonly meta: { model?: string; provider?: string } = {}) {}

  /** Mirror one dispatch/spine event. Never throws on unknown shapes. */
  observe(ev: unknown): void {
    if (!ev || typeof ev !== 'object' || !('type' in ev)) return;
    const e = ev as Record<string, unknown>;
    if (e['type'] === 'tool_execution_end') {
      this.totals.toolCalls += 1;
      return;
    }
    if (e['type'] !== 'message_end') return;
    const usage = e['usage'];
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    if (typeof u['promptTokens'] === 'number') this.totals.inputTokens += u['promptTokens'];
    if (typeof u['completionTokens'] === 'number') this.totals.outputTokens += u['completionTokens'];
    if (typeof u['cachedPromptTokens'] === 'number') this.totals.cacheHitTokens += u['cachedPromptTokens'];
    this.totals.usageReports += 1;
  }

  /** Cumulative totals (defensive copy). */
  usage(): RunUsageTotals {
    return { ...this.totals };
  }

  /**
   * Final NDJSON `usage` event for JSON hosts (Desktop, competitive bench,
   * anchor runner). Emitted once per run, after the dispatch stream ends —
   * `tools/eval/competitive/adapters.ts#parseZelariUsage` reads exactly this
   * flat `{ inputTokens, outputTokens, cacheHitTokens, model?, provider? }`
   * shape, so the bench stops recording `tokens: null` with no bench change.
   */
  usageEvent(): RunUsageEventPayload {
    return {
      type: 'usage',
      ...this.usage(),
      ...(this.meta.model ? { model: this.meta.model } : {}),
      ...(this.meta.provider ? { provider: this.meta.provider } : {}),
    };
  }

  /**
   * Ledger projection: toolCalls always (event-countable), token fields ONLY
   * when backed by ≥1 provider usage report (unknown ≠ estimated ≠ zero).
   */
  ledgerFields(): { toolCalls: number; inputTokens?: number; outputTokens?: number } {
    return {
      toolCalls: this.totals.toolCalls,
      ...(this.totals.usageReports > 0
        ? { inputTokens: this.totals.inputTokens, outputTokens: this.totals.outputTokens }
        : {}),
    };
  }
}
