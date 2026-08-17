/**
 * Provider harness profiles — single source of model-aware policy.
 *
 * Context window, reasoning replay, prompt-cache expectations, sampling
 * defaults and compaction thresholds used to live as ad-hoc literals
 * (`deepseek-v4` regex in tokenBudget, temperature 0.7 in the OpenAI
 * adapter, 85/95% clamps in applyBudgetPolicy). Consumers read from
 * {@link capabilitiesFor}; Kraken core stays provider-agnostic.
 *
 * Profile `deepseek-v4` currently matches the previous hardcoded values
 * (1M ctx, cache priced, reasoning replay, same 70/85/95 compaction)
 * so existing tests stay green. New knobs go here, not in call sites.
 */

export type HarnessProfileId = 'default' | 'deepseek-v4';

export interface ProviderCapabilities {
  contextWindow: number;
  reasoning: {
    supported: boolean;
    /** Wire-level effort labels the profile understands (informational). */
    levels?: string[];
    /** Assistant `reasoning_content` must be echoed on the next request. */
    replayReasoning: boolean;
  };
  promptCache: {
    supported: boolean;
    /** True when the price table has an explicit cached-input rate. */
    pricedCacheRead?: boolean;
  };
  toolCalling: {
    parallel: boolean;
  };
  sampling: {
    temperature: number;
  };
  compaction: {
    /** Soft warning occupancy (0–1). */
    warnAt: number;
    /** Forced compact occupancy (0–1). */
    compactAt: number;
    /** Hard-trim occupancy (0–1). */
    hardAt: number;
  };
  /** preferredHarnessProfile */
  profile: HarnessProfileId;
}

const DEFAULT_CAPS: Readonly<ProviderCapabilities> = Object.freeze({
  contextWindow: 400_000,
  reasoning: Object.freeze({
    supported: true,
    levels: Object.freeze(['low', 'medium', 'high']) as string[],
    replayReasoning: true,
  }),
  promptCache: Object.freeze({ supported: true, pricedCacheRead: false }),
  toolCalling: Object.freeze({ parallel: true }),
  sampling: Object.freeze({ temperature: 0.7 }),
  compaction: Object.freeze({ warnAt: 0.7, compactAt: 0.85, hardAt: 0.95 }),
  profile: 'default',
});

const DEEPSEEK_V4_CAPS: Readonly<ProviderCapabilities> = Object.freeze({
  contextWindow: 1_000_000,
  reasoning: Object.freeze({
    supported: true,
    levels: Object.freeze(['high', 'max']) as string[],
    replayReasoning: true,
  }),
  promptCache: Object.freeze({ supported: true, pricedCacheRead: true }),
  toolCalling: Object.freeze({ parallel: true }),
  sampling: Object.freeze({ temperature: 0.7 }),
  compaction: Object.freeze({ warnAt: 0.7, compactAt: 0.85, hardAt: 0.95 }),
  profile: 'deepseek-v4',
});

/** Model-id detector. The only `deepseek-v4` capability regex in src/. */
const DEEPSEEK_V4_RE = /^deepseek-v4(\.|-|$)/i;

export function resolveHarnessProfile(model?: string): HarnessProfileId {
  if (model && DEEPSEEK_V4_RE.test(model)) return 'deepseek-v4';
  return 'default';
}

export function capabilitiesFor(model?: string): Readonly<ProviderCapabilities> {
  return resolveHarnessProfile(model) === 'deepseek-v4' ? DEEPSEEK_V4_CAPS : DEFAULT_CAPS;
}

export function isDeepSeekV4Model(model?: string): boolean {
  return resolveHarnessProfile(model) === 'deepseek-v4';
}
