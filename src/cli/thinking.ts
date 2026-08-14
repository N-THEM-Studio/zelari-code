/**
 * thinking — unified "thinking effort" selection for all providers.
 *
 * ADR-0017. A single `ThinkingSpec` abstraction is translated, per provider,
 * into the vendor-specific request parameters that control how much the model
 * reasons before answering:
 *
 *   - OpenAI / xAI → `reasoning_effort` enum (low/medium/high).
 *   - Anthropic / GLM → `thinking` block (enabled + budget_tokens, or disabled).
 *   - DeepSeek → `thinking` toggle + `reasoning_effort` (high/max).
 *   - OpenAI Responses (ChatGPT) → `reasoning.effort`.
 *
 * Any unsupported combination degrades to `'auto'` (no parameter sent → the
 * provider default) with a `degraded: true` flag + a human-readable `note`,
 * never an error. This keeps the UI honest and the wire safe even as vendor
 * APIs drift.
 */

import type { ProviderName } from './keyStore.js';

export type ThinkingEffort = 'low' | 'medium' | 'high';

export type ThinkingSpec =
  | 'auto'
  | { kind: 'off' }
  | { kind: 'effort'; effort: ThinkingEffort }
  | { kind: 'budget'; budgetTokens: number };

/** Which thinking controls a provider supports. Empty = only 'auto'. */
export interface ThinkingCapability {
  effort?: boolean;
  budget?: boolean;
}

/**
 * Capability table (per ADR-0017). Effort = reasoning_effort enum; budget =
 * budget_tokens block. DeepSeek exposes an effort enum (high/max) + a toggle,
 * so it is `effort` here; GLM takes an Anthropic-style `thinking` budget block.
 */
export const PROVIDER_THINKING_CAPABILITY: Record<ProviderName, ThinkingCapability> = {
  'openai-compatible': { effort: true },
  'grok': { effort: true },
  'chatgpt': { effort: true },
  'anthropic': { budget: true },
  'glm': { budget: true },
  'deepseek': { effort: true },
  'minimax': { effort: true },
  'custom': { effort: true },
};

export function thinkingCapabilityFor(id: ProviderName): ThinkingCapability {
  return PROVIDER_THINKING_CAPABILITY[id] ?? {};
}

/** Canonical string form used for persistence + CLI/slash surfaces. */
export function stringifyThinkingSpec(spec: ThinkingSpec): string {
  if (spec === 'auto') return 'auto';
  if (spec.kind === 'off') return 'off';
  if (spec.kind === 'effort') return spec.effort;
  return `budget:${spec.budgetTokens}`;
}

/** Parse a user/config string into a ThinkingSpec. Unknown input → 'auto' (never throws). */
export function parseThinkingSpec(raw: string | null | undefined): ThinkingSpec {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s || s === 'auto') return 'auto';
  if (s === 'off') return { kind: 'off' };
  if (s === 'low' || s === 'medium' || s === 'high') return { kind: 'effort', effort: s };
  const m = /^budget:(\d+)$/.exec(s);
  if (m) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return { kind: 'budget', budgetTokens: n };
  }
  return 'auto';
}

/** Strict validity check for interactive surfaces (distinguishes 'auto' from garbage). */
export function isValidThinkingInput(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  if (s === 'auto' || s === 'off' || s === 'low' || s === 'medium' || s === 'high') return true;
  return /^budget:\d+$/.test(s) && Number.parseInt(s.slice(7), 10) > 0;
}

export interface ThinkingTranslateResult {
  /** Request-body fields to merge (e.g. { reasoning_effort: 'high' } or { thinking: {...} }). */
  patch: Record<string, unknown>;
  /** True when the requested kind was unsupported and we degraded to 'auto'. */
  degraded: boolean;
  /** Human-readable reason for degradation (for warnings). */
  note?: string;
}

function degrade(note: string): ThinkingTranslateResult {
  return { patch: {}, degraded: true, note };
}

/**
 * OpenAI chat.completions adapter (grok, glm, minimax, deepseek,
 * openai-compatible, custom). Maps a ThinkingSpec to the fields the
 * chat.completions body accepts.
 */
export function translateOpenAiCompatibleThinking(
  providerId: ProviderName,
  spec: ThinkingSpec,
): ThinkingTranslateResult {
  if (spec === 'auto') return { patch: {}, degraded: false };
  const cap = thinkingCapabilityFor(providerId);
  switch (spec.kind) {
    case 'off':
      // Providers with a thinking toggle disable it; effort-enum providers
      // have no true "off" — degrade to the cheapest effort instead.
      if (providerId === 'deepseek' || providerId === 'glm') {
        return { patch: { thinking: { type: 'disabled' } }, degraded: false };
      }
      if (cap.effort) return { patch: { reasoning_effort: 'low' }, degraded: false };
      return degrade(`thinking 'off' is not supported for provider "${providerId}"`);
    case 'effort':
      if (!cap.effort) {
        return degrade(`thinking 'effort' is not supported for provider "${providerId}"`);
      }
      if (providerId === 'deepseek') {
        // DeepSeek only distinguishes high/max; collapse low/medium → high.
        return {
          patch: {
            thinking: { type: 'enabled' },
            reasoning_effort: spec.effort === 'high' ? 'max' : 'high',
          },
          degraded: false,
        };
      }
      return { patch: { reasoning_effort: spec.effort }, degraded: false };
    case 'budget':
      if (!cap.budget) {
        return degrade(`thinking 'budget' is not supported for provider "${providerId}"`);
      }
      return {
        patch: { thinking: { type: 'enabled', budget_tokens: spec.budgetTokens } },
        degraded: false,
      };
  }
}

/** OpenAI Responses adapter (chatgpt). */
export function translateResponsesThinking(spec: ThinkingSpec): ThinkingTranslateResult {
  if (spec === 'auto') return { patch: {}, degraded: false };
  switch (spec.kind) {
    case 'off':
      // Responses API has no hard off; 'minimal' is the cheapest effort.
      return { patch: { reasoning: { effort: 'minimal' } }, degraded: false };
    case 'effort':
      return { patch: { reasoning: { effort: spec.effort } }, degraded: false };
    case 'budget':
      return degrade('thinking "budget" is not supported for chatgpt — use low/medium/high');
  }
}

/** Anthropic Messages adapter. */
export function translateAnthropicThinking(spec: ThinkingSpec): ThinkingTranslateResult {
  if (spec === 'auto') return { patch: {}, degraded: false };
  switch (spec.kind) {
    case 'off':
      return { patch: { thinking: { type: 'disabled' } }, degraded: false };
    case 'budget':
      return {
        patch: { thinking: { type: 'enabled', budget_tokens: spec.budgetTokens } },
        degraded: false,
      };
    case 'effort':
      return degrade('thinking "effort" is not supported for anthropic — use budget:N');
  }
}
