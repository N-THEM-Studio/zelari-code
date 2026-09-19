/**
 * cacheHitReport — offline prompt-cache aggregation over `metrics.jsonl` (M1.2).
 *
 * Cache-hit-rate plan (`.zelari/docs/2026-09-18-cache-hit-rate-piano-implementazione.md`):
 * folds the provider-verified `kind: 'message'` rows written by
 * `recordMessageUsage` into the number the plan is measured against —
 *
 *   hit% = cachedPromptTokens / promptTokens   (overall + per provider/model)
 *
 * Pure functions (no fs, no clock) so the aggregation is unit-testable;
 * `utils/doctor.ts` reads the shared metrics file and wires them in — same
 * shape as `utils/contextGrowthSummary.ts`, which does this for `kind: 'run'`.
 */

/** Fields of a `kind: 'message'` record this report depends on. */
export interface CacheHitMessageRecord {
  ts?: number;
  provider?: string;
  model?: string;
  promptTokens?: number;
  cachedPromptTokens?: number;
}

/** Per provider/model cache trajectory. */
export interface CacheHitModelRow {
  provider: string;
  model: string;
  /** Number of LLM calls aggregated into this row. */
  messages: number;
  promptTokens: number;
  cachedPromptTokens: number;
  /** `cachedPromptTokens / promptTokens` — 0 when the model reported no cache. */
  hitRate: number;
}

export interface CacheHitSummary {
  /** Number of instrumented LLM calls in the window. */
  messages: number;
  promptTokens: number;
  cachedPromptTokens: number;
  hitRate: number;
  /** Provider/model breakdown, heaviest prompt volume first. */
  byModel: CacheHitModelRow[];
}

/** A row is usable only when we know how many prompt tokens were billed. */
function billable(record: CacheHitMessageRecord): boolean {
  return typeof record.promptTokens === 'number' && record.promptTokens > 0;
}

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Fold the last `window` usable `kind: 'message'` rows into a summary.
 *
 * Returns `null` when NO row carries a prompt-token count — i.e. no session
 * has produced the M1.1 telemetry yet (fresh install, or every session
 * predates it). Callers must surface that as "no data", never as 0%: a fake
 * zero would read as "the cache is useless" instead of "not measured".
 */
export function summarizeCacheHits(
  records: CacheHitMessageRecord[],
  window = 500,
): CacheHitSummary | null {
  const usable = records.filter(billable);
  if (usable.length === 0) return null;
  const tail = usable.slice(-window);

  const rows = new Map<string, CacheHitModelRow>();
  let promptTokens = 0;
  let cachedPromptTokens = 0;
  for (const record of tail) {
    const provider = record.provider ?? 'unknown';
    const model = record.model ?? 'unknown';
    const prompt = num(record.promptTokens);
    // Clamp: cached is a subset of prompt, so a bad row can't push hit% > 100.
    const cached = Math.min(num(record.cachedPromptTokens), prompt);
    promptTokens += prompt;
    cachedPromptTokens += cached;
    const key = `${provider}::${model}`;
    const row = rows.get(key) ?? {
      provider,
      model,
      messages: 0,
      promptTokens: 0,
      cachedPromptTokens: 0,
      hitRate: 0,
    };
    row.messages += 1;
    row.promptTokens += prompt;
    row.cachedPromptTokens += cached;
    row.hitRate = row.promptTokens > 0 ? row.cachedPromptTokens / row.promptTokens : 0;
    rows.set(key, row);
  }

  return {
    messages: tail.length,
    promptTokens,
    cachedPromptTokens,
    hitRate: promptTokens > 0 ? cachedPromptTokens / promptTokens : 0,
    byModel: [...rows.values()].sort((a, b) => b.promptTokens - a.promptTokens),
  };
}

function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Human-readable doctor lines: one summary line + a top-models line.
 * The plan's target (`hit% >= 60%` from turn 2 on DeepSeek) is a
 * post-M2 expectation, so it is stated as context, not as a gate.
 */
export function formatCacheHitSummary(summary: CacheHitSummary, top = 3): string[] {
  const lines = [
    `messages ${summary.messages} · prompt ${fmtTokens(summary.promptTokens)} tokens · ` +
      `cached ${fmtTokens(summary.cachedPromptTokens)} · hit ${fmtRate(summary.hitRate)}`,
  ];
  const rows = summary.byModel.slice(0, top);
  if (rows.length > 0) {
    lines.push(
      'top models: ' +
        rows
          .map(
            (r) =>
              `${r.provider}/${r.model} ${fmtRate(r.hitRate)} ` +
              `(${r.messages} msg · ${fmtTokens(r.promptTokens)} prompt)`,
          )
          .join(' · '),
    );
  }
  return lines;
}
