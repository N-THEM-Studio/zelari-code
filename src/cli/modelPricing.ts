/**
 * modelPricing — USD cost calculator for LLM tokens.
 *
 * Pricing table covers the providers wired in `keyStore.PROVIDERS`. Costs
 * are in **USD per 1M tokens** (industry standard). Numbers are conservative
 * defaults — the user can override per-model via env vars (see below).
 *
 * Env overrides (1M-token rate):
 *   - ANATHEMA_PRICE_GROK4
 *   - ANATHEMA_PRICE_GROK4_FAST
 *   - ANATHEMA_PRICE_GLM46
 *   - ANATHEMA_PRICE_MINIMAX_M25
 *   - ANATHEMA_PRICE_DEFAULT          (fallback for unknown models)
 *
 * Costs returned are precise to 6 decimals. Round to cents at the UI layer.
 */

/** Pricing table (USD per 1M tokens) — conservative public list prices. */
const PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
  // xAI Grok
  'grok-4':           { input: 3,    output: 15 },
  'grok-4-fast':      { input: 0.20, output: 0.50 },
  'grok-3':           { input: 3,    output: 15 },
  'grok-3-mini':      { input: 0.30, output: 0.50 },
  'grok-2-vision':    { input: 2,    output: 10 },
  // GLM / Z.AI
  'glm-4.6':          { input: 0.60, output: 2.20 },
  'glm-4.5':          { input: 0.50, output: 2.00 },
  'glm-4.5-air':      { input: 0.10, output: 0.60 },
  'glm-z1':           { input: 0.50, output: 2.00 },
  // MiniMax
  'MiniMax-M2.5':     { input: 0.20, output: 1.10 },
  'MiniMax-M2':       { input: 0.20, output: 1.10 },
  'MiniMax-M2-her':   { input: 0.30, output: 1.20 },
  // DeepSeek (global platform) — estimated list prices; override via
  // ANATHEMA_PRICE_DEEPSEEK_V4_FLASH / ANATHEMA_PRICE_DEEPSEEK_V4_PRO.
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'deepseek-v4-pro':   { input: 0.55, output: 2.19 },
  // OpenAI (for openai-compatible fallback)
  'gpt-4o':           { input: 2.50, output: 10 },
  'gpt-4o-mini':      { input: 0.15, output: 0.60 },
  'gpt-4-turbo':      { input: 10,   output: 30 },
  'o1-preview':       { input: 15,   output: 60 },
  'o1-mini':          { input: 3,    output: 12 },
};

/** Default rate for unknown models — assume a mid-tier provider. */
const DEFAULT_RATE = { input: 1.0, output: 3.0 };

/** Read an env-var override for a given model, if present. */
function envOverride(model: string): { input: number; output: number } | null {
  const key = `ANATHEMA_PRICE_${model.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const raw = process.env[key] ?? process.env.ANATHEMA_PRICE_DEFAULT;
  return parseRateOverride(raw);
}

/**
 * Parse a price-override string in the format `INPUT[/OUTPUT]`.
 * Exported for testing (env-var-based tests are subject to platform
 * content filters that rewrite numeric literals in test files).
 *
 * @returns null if `raw` is undefined/empty or if either number is invalid.
 */
export function parseRateOverride(raw: string | undefined): { input: number; output: number } | null {
  if (!raw) return null;
  const [inStr, outStr] = raw.split('/');
  const input = Number.parseFloat(inStr);
  const output = outStr !== undefined ? Number.parseFloat(outStr) : input;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output };
}

/** Look up pricing for a model. Falls back to DEFAULT_RATE. */
export function getModelRate(model: string): { input: number; output: number } {
  if (!model) return DEFAULT_RATE;
  return envOverride(model)
    ?? PRICES_PER_MILLION[model]
    ?? DEFAULT_RATE;
}

/**
 * Compute the USD cost for a given number of prompt + completion tokens.
 * Rates are per 1M tokens, so we divide the token count by 1_000_000.
 *
 * @returns cost in USD (0 if either token count is negative or NaN).
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  if (!Number.isFinite(promptTokens) || promptTokens < 0) return 0;
  if (!Number.isFinite(completionTokens) || completionTokens < 0) return 0;
  const rate = getModelRate(model);
  const inputCost = (promptTokens / 1_000_000) * rate.input;
  const outputCost = (completionTokens / 1_000_000) * rate.output;
  return Number((inputCost + outputCost).toFixed(6));
}

/** Format a USD cost as `$0.0234` style (4 decimals). */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '$0.0000';
  if (usd === 0) return '$0.0000';
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(4)}`;
}

/** Format a token count compactly: `1.2k`, `3.4M`, etc. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0';
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  return `${(tokens / 1_000_000_000).toFixed(2)}B`;
}