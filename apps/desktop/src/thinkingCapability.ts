/**
 * thinkingCapability — browser-safe table of native thinking levels.
 *
 * Kept free of Node / keyStore so Desktop can import it and compute the
 * Thinking dropdown from the *selected* model, not the snapshot default.
 */

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_EFFORTS: readonly ThinkingEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export interface ThinkingCapability {
  effort?: boolean;
  budget?: boolean;
  efforts?: ThinkingEffort[];
}

const BASE_EFFORTS: ThinkingEffort[] = ['low', 'medium', 'high'];

const PROVIDER_THINKING_CAPABILITY: Record<string, ThinkingCapability> = {
  'openai-compatible': { effort: true },
  grok: { effort: true },
  chatgpt: { effort: true },
  anthropic: { budget: true },
  glm: { budget: true },
  deepseek: { effort: true },
  minimax: { effort: true },
  custom: { effort: true },
};

export function thinkingCapabilityFor(
  id: string,
  model?: string,
): ThinkingCapability {
  const base = PROVIDER_THINKING_CAPABILITY[id] ?? {};
  const efforts = effortLevelsFor(id, model);
  const budget = supportsBudget(id, model);
  return {
    ...base,
    effort: efforts.length > 0 || Boolean(base.effort),
    budget,
    efforts: efforts.length > 0 ? efforts : undefined,
  };
}

/** Native effort enum values this (provider, model) accepts on the wire. */
export function effortLevelsFor(id: string, model?: string): ThinkingEffort[] {
  const m = (model ?? '').trim();
  switch (id) {
    case 'grok':
    case 'openai-compatible':
    case 'custom':
      if (grokHasXhigh(m)) return [...BASE_EFFORTS, 'xhigh'];
      return [...BASE_EFFORTS];
    case 'chatgpt':
      if (gptHasMax(m)) return [...BASE_EFFORTS, 'xhigh', 'max'];
      if (gptHasXhigh(m)) return [...BASE_EFFORTS, 'xhigh'];
      return [...BASE_EFFORTS];
    case 'deepseek':
      return ['high', 'max'];
    case 'minimax':
      return [...BASE_EFFORTS];
    case 'glm':
      if (glmHasEffortScale(m)) return ['low', 'high', 'max'];
      return [];
    case 'anthropic':
      if (claudeHasXhigh(m)) return ['high', 'xhigh', 'max'];
      if (claudeHasMax(m)) return ['high', 'max'];
      return [];
    default:
      return [];
  }
}

export function supportsBudget(id: string, model?: string): boolean {
  if (id === 'anthropic') return true;
  if (id === 'glm') return !glmHasEffortScale(model);
  return Boolean(PROVIDER_THINKING_CAPABILITY[id]?.budget);
}

export function grokHasXhigh(model: string): boolean {
  const v = parseDottedVersion(model, /grok[-_]?(\d+)(?:[.-](\d+))?/i);
  if (!v) return false;
  return v.major > 4 || (v.major === 4 && v.minor >= 6);
}

export function gptHasXhigh(model: string): boolean {
  const v = parseDottedVersion(model, /gpt[-_]?(\d+)(?:[.-](\d+))?/i);
  if (!v) return false;
  return v.major > 5 || (v.major === 5 && v.minor >= 4);
}

export function gptHasMax(model: string): boolean {
  const v = parseDottedVersion(model, /gpt[-_]?(\d+)(?:[.-](\d+))?/i);
  if (!v) return false;
  return v.major > 5 || (v.major === 5 && v.minor >= 6);
}

export function claudeHasMax(model: string): boolean {
  const v = parseClaudeVersion(model);
  if (!v) return false;
  return v.major > 4 || (v.major === 4 && v.minor >= 6);
}

export function claudeHasXhigh(model: string): boolean {
  const v = parseClaudeVersion(model);
  if (!v) return false;
  if (v.major >= 5) return true;
  return v.major === 4 && v.minor >= 7;
}

export function glmHasEffortScale(model?: string): boolean {
  const v = parseDottedVersion(model ?? '', /glm[-_]?(\d+)(?:[.-](\d+))?/i);
  if (!v) return false;
  return v.major >= 5;
}

function parseDottedVersion(
  model: string,
  re: RegExp,
): { major: number; minor: number } | null {
  const m = re.exec(model);
  if (!m) return null;
  return {
    major: Number.parseInt(m[1], 10),
    minor: m[2] ? Number.parseInt(m[2], 10) : 0,
  };
}

function parseClaudeVersion(model: string): { major: number; minor: number } | null {
  const m = /claude-(?:sonnet|opus|haiku)[-_]?(\d+)(?:[.-](\d+))?/i.exec(model);
  if (!m) return null;
  return {
    major: Number.parseInt(m[1], 10),
    minor: m[2] ? Number.parseInt(m[2], 10) : 0,
  };
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'xHigh',
  max: 'Max',
};

export interface ThinkingSelectOption {
  value: string;
  label: string;
}

/**
 * Options for the Desktop / CLI thinking picker, computed from the
 * *selected* provider + model. Never falls back to a generic L/M/H list
 * when the provider has a native scale (DeepSeek = high/max).
 */
export function thinkingSelectOptions(
  providerId: string,
  model?: string,
): ThinkingSelectOption[] {
  const cap = thinkingCapabilityFor(providerId, model);
  const options: ThinkingSelectOption[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'off', label: 'Off' },
  ];
  const levels = cap.efforts ?? [];
  for (const level of levels) {
    options.push({ value: level, label: EFFORT_LABELS[level] ?? level });
  }
  if (cap.budget) {
    options.push(
      { value: 'budget:4000', label: '4k tokens' },
      { value: 'budget:8000', label: '8k tokens' },
      { value: 'budget:16000', label: '16k tokens' },
      { value: 'budget:32000', label: '32k tokens' },
    );
  }
  return options;
}
