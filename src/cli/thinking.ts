/**
 * thinking — unified "thinking effort" selection for all providers.
 *
 * ADR-0017. A single `ThinkingSpec` abstraction is translated, per provider
 * (and, when known, per model), into the vendor-specific request parameters
 * that control how much the model reasons before answering:
 *
 *   - OpenAI / xAI → `reasoning_effort` enum (low/medium/high/xhigh).
 *   - ChatGPT Responses → `reasoning.effort` (low/medium/high/xhigh/max).
 *   - Anthropic → `thinking` budget block, or `output_config.effort` on 4.6+.
 *   - GLM-4.x → `thinking` budget block; GLM-5.x → `reasoning_effort` + toggle.
 *   - DeepSeek → `thinking` toggle + `reasoning_effort` (high/max).
 *
 * Any unsupported combination degrades to `'auto'` (no parameter sent → the
 * provider default) with a `degraded: true` flag + a human-readable `note`,
 * never an error. Levels that exist on the family but not on this model are
 * *clamped* to the nearest native value (still sent) instead of dropped.
 */

import type { ProviderName } from './keyStore.js';
import {
  type ThinkingEffort,
  type ThinkingCapability,
  THINKING_EFFORTS,
  thinkingCapabilityFor,
  effortLevelsFor,
  grokHasXhigh,
  gptHasXhigh,
  gptHasMax,
  claudeHasMax,
  claudeHasXhigh,
  glmHasEffortScale,
  thinkingSelectOptions,
} from './thinkingCapability.js';

export type { ThinkingEffort, ThinkingCapability };
export {
  THINKING_EFFORTS,
  thinkingCapabilityFor,
  effortLevelsFor,
  grokHasXhigh,
  gptHasXhigh,
  gptHasMax,
  claudeHasMax,
  claudeHasXhigh,
  glmHasEffortScale,
  thinkingSelectOptions,
};

export type ThinkingSpec =
  | 'auto'
  | { kind: 'off' }
  | { kind: 'effort'; effort: ThinkingEffort }
  | { kind: 'budget'; budgetTokens: number };

/**
 * Capability table (per ADR-0017). Effort = reasoning_effort enum; budget =
 * budget_tokens block. Extra native levels (xhigh/max) are model-gated via
 * `effortLevelsFor`.
 */
export const PROVIDER_THINKING_CAPABILITY: Record<ProviderName, ThinkingCapability> = {
  'openai-compatible': { effort: true },
  grok: { effort: true },
  chatgpt: { effort: true },
  anthropic: { budget: true },
  glm: { budget: true },
  deepseek: { effort: true },
  minimax: { effort: true },
  custom: { effort: true },
};

const EFFORT_RANK: Record<ThinkingEffort, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/**
 * Clamp a requested effort to the nearest native level for this model.
 * Returns the original value when it is already native.
 */
export function clampEffort(
  id: ProviderName,
  model: string | undefined,
  requested: ThinkingEffort,
): { effort: ThinkingEffort; clamped: boolean; note?: string } {
  const native = effortLevelsFor(id, model);
  if (native.includes(requested)) {
    return { effort: requested, clamped: false };
  }
  if (native.length === 0) {
    return {
      effort: requested,
      clamped: true,
      note: `thinking '${requested}' is not supported for provider "${id}"`,
    };
  }
  const want = EFFORT_RANK[requested];
  let best = native[0];
  let bestDist = Math.abs(EFFORT_RANK[best] - want);
  for (const level of native) {
    const dist = Math.abs(EFFORT_RANK[level] - want);
    if (dist < bestDist || (dist === bestDist && EFFORT_RANK[level] > EFFORT_RANK[best])) {
      best = level;
      bestDist = dist;
    }
  }
  const label = model ? `${id}/${model}` : id;
  return {
    effort: best,
    clamped: true,
    note: `'${requested}' is not native on ${label} — using '${best}'`,
  };
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
  if ((THINKING_EFFORTS as readonly string[]).includes(s)) {
    return { kind: 'effort', effort: s as ThinkingEffort };
  }
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
  if (s === 'auto' || s === 'off') return true;
  if ((THINKING_EFFORTS as readonly string[]).includes(s)) return true;
  return /^budget:\d+$/.test(s) && Number.parseInt(s.slice(7), 10) > 0;
}

export interface ThinkingTranslateResult {
  /** Request-body fields to merge (e.g. { reasoning_effort: 'high' } or { thinking: {...} }). */
  patch: Record<string, unknown>;
  /** True when the requested kind was unsupported and we degraded to 'auto'. */
  degraded: boolean;
  /** Human-readable reason for degradation / clamp (for warnings). */
  note?: string;
}

function degrade(note: string): ThinkingTranslateResult {
  return { patch: {}, degraded: true, note };
}

function withClampNote(
  patch: Record<string, unknown>,
  clamped: boolean,
  note?: string,
): ThinkingTranslateResult {
  return { patch, degraded: false, note: clamped ? note : undefined };
}

/**
 * OpenAI chat.completions adapter (grok, glm, minimax, deepseek,
 * openai-compatible, custom). Maps a ThinkingSpec to the fields the
 * chat.completions body accepts.
 */
export function translateOpenAiCompatibleThinking(
  providerId: ProviderName,
  spec: ThinkingSpec,
  model?: string,
): ThinkingTranslateResult {
  if (spec === 'auto') return { patch: {}, degraded: false };
  const cap = thinkingCapabilityFor(providerId, model);
  switch (spec.kind) {
    case 'off':
      if (providerId === 'deepseek' || providerId === 'glm') {
        return { patch: { thinking: { type: 'disabled' } }, degraded: false };
      }
      if (cap.effort) return { patch: { reasoning_effort: 'low' }, degraded: false };
      return degrade(`thinking 'off' is not supported for provider "${providerId}"`);
    case 'effort': {
      if (!cap.effort && !cap.efforts?.length) {
        return degrade(`thinking 'effort' is not supported for provider "${providerId}"`);
      }
      const resolved = clampEffort(providerId, model, spec.effort);
      if (providerId === 'deepseek') {
        return withClampNote(
          {
            thinking: { type: 'enabled' },
            reasoning_effort: resolved.effort === 'max' ? 'max' : 'high',
          },
          resolved.clamped,
          resolved.note,
        );
      }
      if (providerId === 'glm') {
        if (!glmHasEffortScale(model)) {
          return degrade(`thinking 'effort' is not supported for GLM ${model || '4.x'} — use budget:N`);
        }
        return withClampNote(
          {
            thinking: { type: 'enabled' },
            reasoning_effort: resolved.effort,
          },
          resolved.clamped,
          resolved.note,
        );
      }
      return withClampNote(
        { reasoning_effort: resolved.effort },
        resolved.clamped,
        resolved.note,
      );
    }
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
export function translateResponsesThinking(
  spec: ThinkingSpec,
  model?: string,
): ThinkingTranslateResult {
  if (spec === 'auto') return { patch: {}, degraded: false };
  switch (spec.kind) {
    case 'off':
      // Responses API has no hard off; 'minimal' is the cheapest effort.
      return { patch: { reasoning: { effort: 'minimal' } }, degraded: false };
    case 'effort': {
      const resolved = clampEffort('chatgpt', model, spec.effort);
      return withClampNote(
        { reasoning: { effort: resolved.effort } },
        resolved.clamped,
        resolved.note,
      );
    }
    case 'budget':
      return degrade('thinking "budget" is not supported for chatgpt — use low/medium/high/xhigh/max');
  }
}

/** Anthropic Messages adapter. */
export function translateAnthropicThinking(
  spec: ThinkingSpec,
  model?: string,
): ThinkingTranslateResult {
  if (spec === 'auto') return { patch: {}, degraded: false };
  switch (spec.kind) {
    case 'off':
      return { patch: { thinking: { type: 'disabled' } }, degraded: false };
    case 'budget':
      return {
        patch: { thinking: { type: 'enabled', budget_tokens: spec.budgetTokens } },
        degraded: false,
      };
    case 'effort': {
      const levels = effortLevelsFor('anthropic', model);
      if (levels.length === 0) {
        return degrade('thinking "effort" is not supported for this Claude model — use budget:N');
      }
      const resolved = clampEffort('anthropic', model, spec.effort);
      return withClampNote(
        { output_config: { effort: resolved.effort } },
        resolved.clamped,
        resolved.note,
      );
    }
  }
}
