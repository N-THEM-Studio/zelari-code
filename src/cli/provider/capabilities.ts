/**
 * OpenAI-compatible provider profiles — the only layer that knows provider
 * wire quirks. Core liveness, completion and progress policy stay neutral.
 */

export type HarnessProfileId =
  | 'default'
  | 'deepseek-v4'
  | 'grok'
  | 'minimax'
  | 'glm';

export interface ProviderCapabilities {
  contextWindow: number;
  reasoning: {
    supported: boolean;
    levels?: readonly string[];
    /** Assistant reasoning must be preserved on tool-call continuations. */
    replayReasoning: boolean;
  };
  promptCache: {
    supported: boolean;
    pricedCacheRead?: boolean;
    /** Chat-Completions affinity header, when the provider documents one. */
    conversationAffinityHeader?: 'x-grok-conv-id';
  };
  toolCalling: { parallel: boolean };
  buildRecovery: {
    /** Whether `tool_choice=required` is a supported recovery serialization. */
    forceToolChoice: boolean;
    /** Only the first N recoveries are forced; later attempts are prompt-only. */
    maxForcedTurns: number;
  };
  sampling: { temperature: number };
  compaction: { warnAt: number; compactAt: number; hardAt: number };
  profile: HarnessProfileId;
}

function frozenProfile(input: ProviderCapabilities): Readonly<ProviderCapabilities> {
  if (input.reasoning.levels) Object.freeze(input.reasoning.levels);
  Object.freeze(input.reasoning);
  Object.freeze(input.promptCache);
  Object.freeze(input.toolCalling);
  Object.freeze(input.buildRecovery);
  Object.freeze(input.sampling);
  Object.freeze(input.compaction);
  return Object.freeze(input);
}

const SHARED_COMPACTION = { warnAt: 0.7, compactAt: 0.85, hardAt: 0.95 } as const;

const DEFAULT_CAPS = frozenProfile({
  contextWindow: 400_000,
  reasoning: { supported: true, levels: ['low', 'medium', 'high'], replayReasoning: true },
  promptCache: { supported: true, pricedCacheRead: false },
  toolCalling: { parallel: true },
  buildRecovery: { forceToolChoice: false, maxForcedTurns: 0 },
  sampling: { temperature: 0.7 },
  compaction: { ...SHARED_COMPACTION },
  profile: 'default',
});

const DEEPSEEK_V4_CAPS = frozenProfile({
  contextWindow: 1_000_000,
  reasoning: { supported: true, levels: ['high', 'max'], replayReasoning: true },
  promptCache: { supported: true, pricedCacheRead: true },
  toolCalling: { parallel: true },
  buildRecovery: { forceToolChoice: false, maxForcedTurns: 0 },
  sampling: { temperature: 0.7 },
  compaction: { ...SHARED_COMPACTION },
  profile: 'deepseek-v4',
});

const GROK_CAPS = frozenProfile({
  contextWindow: 500_000,
  reasoning: {
    supported: true,
    levels: ['low', 'medium', 'high', 'xhigh'],
    replayReasoning: false,
  },
  promptCache: {
    supported: true,
    pricedCacheRead: true,
    conversationAffinityHeader: 'x-grok-conv-id',
  },
  toolCalling: { parallel: true },
  buildRecovery: { forceToolChoice: true, maxForcedTurns: 1 },
  sampling: { temperature: 0.7 },
  compaction: { ...SHARED_COMPACTION },
  profile: 'grok',
});

const MINIMAX_M3_CAPS = frozenProfile({
  contextWindow: 1_000_000,
  reasoning: { supported: true, replayReasoning: true },
  promptCache: { supported: false, pricedCacheRead: false },
  toolCalling: { parallel: true },
  buildRecovery: { forceToolChoice: false, maxForcedTurns: 0 },
  sampling: { temperature: 0.7 },
  compaction: { ...SHARED_COMPACTION },
  profile: 'minimax',
});

const MINIMAX_M2_CAPS = frozenProfile({
  contextWindow: 204_800,
  reasoning: { supported: true, replayReasoning: true },
  promptCache: { supported: false, pricedCacheRead: false },
  toolCalling: { parallel: true },
  buildRecovery: { forceToolChoice: false, maxForcedTurns: 0 },
  sampling: { temperature: 0.7 },
  compaction: { ...SHARED_COMPACTION },
  profile: 'minimax',
});

const GLM_CAPS = frozenProfile({
  contextWindow: 200_000,
  reasoning: { supported: true, replayReasoning: true },
  promptCache: { supported: true, pricedCacheRead: false },
  toolCalling: { parallel: true },
  buildRecovery: { forceToolChoice: false, maxForcedTurns: 0 },
  sampling: { temperature: 0.7 },
  compaction: { ...SHARED_COMPACTION },
  profile: 'glm',
});

const DEEPSEEK_RE = /^deepseek-(?:v4(?:\.|-|$)|chat$|reasoner$)/i;
const GROK_RE = /^grok(?:\.|-|$)/i;
const MINIMAX_RE = /^minimax(?:\.|-|$)/i;
const MINIMAX_M3_RE = /^minimax-m3(?:\.|-|$)/i;
const GLM_RE = /^glm(?:\.|-|$)/i;

export function resolveHarnessProfile(model?: string, providerId?: string): HarnessProfileId {
  const provider = providerId?.trim().toLowerCase();
  if (provider === 'deepseek') return 'deepseek-v4';
  if (provider === 'grok') return 'grok';
  if (provider === 'minimax') return 'minimax';
  if (provider === 'glm') return 'glm';
  if (model && DEEPSEEK_RE.test(model)) return 'deepseek-v4';
  if (model && GROK_RE.test(model)) return 'grok';
  if (model && MINIMAX_RE.test(model)) return 'minimax';
  if (model && GLM_RE.test(model)) return 'glm';
  return 'default';
}

export function capabilitiesFor(
  model?: string,
  providerId?: string,
): Readonly<ProviderCapabilities> {
  switch (resolveHarnessProfile(model, providerId)) {
    case 'deepseek-v4': return DEEPSEEK_V4_CAPS;
    case 'grok': return GROK_CAPS;
    case 'minimax': return model && MINIMAX_M3_RE.test(model) ? MINIMAX_M3_CAPS : MINIMAX_M2_CAPS;
    case 'glm': return GLM_CAPS;
    default: return DEFAULT_CAPS;
  }
}

export function isDeepSeekV4Model(model?: string, providerId?: string): boolean {
  return resolveHarnessProfile(model, providerId) === 'deepseek-v4';
}
