import { describe, it, expect } from 'vitest';
import {
  parseThinkingSpec,
  stringifyThinkingSpec,
  isValidThinkingInput,
  thinkingCapabilityFor,
  effortLevelsFor,
  thinkingSelectOptions,
  clampEffort,
  translateOpenAiCompatibleThinking,
  translateResponsesThinking,
  translateAnthropicThinking,
} from './thinking.js';

describe('parseThinkingSpec', () => {
  it('maps canonical strings', () => {
    expect(parseThinkingSpec('auto')).toBe('auto');
    expect(parseThinkingSpec(undefined)).toBe('auto');
    expect(parseThinkingSpec('off')).toEqual({ kind: 'off' });
    expect(parseThinkingSpec('low')).toEqual({ kind: 'effort', effort: 'low' });
    expect(parseThinkingSpec('high')).toEqual({ kind: 'effort', effort: 'high' });
    expect(parseThinkingSpec('xhigh')).toEqual({ kind: 'effort', effort: 'xhigh' });
    expect(parseThinkingSpec('max')).toEqual({ kind: 'effort', effort: 'max' });
    expect(parseThinkingSpec('budget:16000')).toEqual({ kind: 'budget', budgetTokens: 16000 });
  });

  it('degrades unknown input to auto (never throws)', () => {
    expect(parseThinkingSpec('garbage')).toBe('auto');
    expect(parseThinkingSpec('budget:0')).toBe('auto');
    expect(parseThinkingSpec('')).toBe('auto');
  });
});

describe('stringifyThinkingSpec / isValidThinkingInput', () => {
  it('round-trips', () => {
    expect(stringifyThinkingSpec(parseThinkingSpec('high'))).toBe('high');
    expect(stringifyThinkingSpec(parseThinkingSpec('xhigh'))).toBe('xhigh');
    expect(stringifyThinkingSpec(parseThinkingSpec('max'))).toBe('max');
    expect(stringifyThinkingSpec(parseThinkingSpec('budget:16000'))).toBe('budget:16000');
    expect(stringifyThinkingSpec('auto')).toBe('auto');
  });

  it('validates strictly', () => {
    expect(isValidThinkingInput('auto')).toBe(true);
    expect(isValidThinkingInput('off')).toBe(true);
    expect(isValidThinkingInput('medium')).toBe(true);
    expect(isValidThinkingInput('xhigh')).toBe(true);
    expect(isValidThinkingInput('max')).toBe(true);
    expect(isValidThinkingInput('budget:16000')).toBe(true);
    expect(isValidThinkingInput('garbage')).toBe(false);
    expect(isValidThinkingInput('budget:0')).toBe(false);
  });
});

describe('thinkingCapabilityFor / effortLevelsFor', () => {
  it('flags effort vs budget providers', () => {
    expect(thinkingCapabilityFor('grok').effort).toBe(true);
    expect(thinkingCapabilityFor('anthropic').budget).toBe(true);
    expect(thinkingCapabilityFor('glm').budget).toBe(true);
    expect(thinkingCapabilityFor('deepseek').effort).toBe(true);
  });

  it('gates xhigh/max on the model family', () => {
    expect(effortLevelsFor('grok', 'grok-4.5')).toEqual(['low', 'medium', 'high']);
    expect(effortLevelsFor('grok', 'grok-4.6')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(effortLevelsFor('chatgpt', 'gpt-5.2-codex')).toEqual(['low', 'medium', 'high']);
    expect(effortLevelsFor('chatgpt', 'gpt-5.4')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(effortLevelsFor('chatgpt', 'gpt-5.6-codex')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortLevelsFor('deepseek', 'deepseek-v4-pro')).toEqual(['high', 'max']);
    expect(effortLevelsFor('anthropic', 'claude-sonnet-4-5')).toEqual([]);
    expect(effortLevelsFor('anthropic', 'claude-sonnet-4-6')).toEqual(['high', 'max']);
    expect(effortLevelsFor('anthropic', 'claude-opus-4-7')).toEqual(['high', 'xhigh', 'max']);
    expect(effortLevelsFor('glm', 'glm-4.6')).toEqual([]);
    expect(effortLevelsFor('glm', 'glm-5.3')).toEqual(['low', 'high', 'max']);
    expect(effortLevelsFor('minimax', 'MiniMax-M2.5')).toEqual(['low', 'medium', 'high']);
  });

  it('exposes native efforts on the capability snapshot', () => {
    expect(thinkingCapabilityFor('grok', 'grok-4.6').efforts).toContain('xhigh');
    expect(thinkingCapabilityFor('chatgpt', 'gpt-5.6').efforts).toContain('max');
    expect(thinkingCapabilityFor('anthropic', 'claude-sonnet-4-6').effort).toBe(true);
    expect(thinkingCapabilityFor('anthropic', 'claude-sonnet-4-6').budget).toBe(true);
    expect(thinkingCapabilityFor('glm', 'glm-5.3').budget).toBe(false);
    expect(thinkingCapabilityFor('glm', 'glm-5.3').effort).toBe(true);
  });
});

describe('thinkingSelectOptions', () => {
  it('shows xHigh for grok-4.6 and not grok-4.5', () => {
    const v46 = thinkingSelectOptions('grok', 'grok-4.6').map((o) => o.value);
    const v45 = thinkingSelectOptions('grok', 'grok-4.5').map((o) => o.value);
    expect(v46).toEqual(['auto', 'off', 'low', 'medium', 'high', 'xhigh']);
    expect(v45).toEqual(['auto', 'off', 'low', 'medium', 'high']);
  });

  it('shows Max (not Low/Medium) for DeepSeek regardless of model id', () => {
    const v = thinkingSelectOptions('deepseek', 'deepseek-v4-flash').map((o) => o.value);
    expect(v).toEqual(['auto', 'off', 'high', 'max']);
    expect(v).not.toContain('low');
    expect(v).not.toContain('medium');
  });

  it('shows xHigh+Max for gpt-5.6-codex', () => {
    const v = thinkingSelectOptions('chatgpt', 'gpt-5.6-codex').map((o) => o.value);
    expect(v).toContain('xhigh');
    expect(v).toContain('max');
  });
});

describe('clampEffort', () => {
  it('keeps native levels', () => {
    expect(clampEffort('grok', 'grok-4.6', 'xhigh')).toEqual({
      effort: 'xhigh',
      clamped: false,
    });
  });

  it('clamps xhigh on grok-4.5 to high', () => {
    const r = clampEffort('grok', 'grok-4.5', 'xhigh');
    expect(r.effort).toBe('high');
    expect(r.clamped).toBe(true);
  });

  it('clamps xhigh on glm-5.3 to max', () => {
    const r = clampEffort('glm', 'glm-5.3', 'xhigh');
    expect(r.effort).toBe('max');
    expect(r.clamped).toBe(true);
  });

  it('clamps low on deepseek to high', () => {
    const r = clampEffort('deepseek', 'deepseek-v4-pro', 'low');
    expect(r.effort).toBe('high');
    expect(r.clamped).toBe(true);
  });
});

describe('translateOpenAiCompatibleThinking', () => {
  it('auto → empty patch', () => {
    expect(translateOpenAiCompatibleThinking('grok', 'auto')).toEqual({ patch: {}, degraded: false });
  });

  it('off on effort providers → reasoning_effort low', () => {
    expect(translateOpenAiCompatibleThinking('grok', { kind: 'off' }))
      .toEqual({ patch: { reasoning_effort: 'low' }, degraded: false });
  });

  it('effort on effort providers → reasoning_effort', () => {
    expect(translateOpenAiCompatibleThinking('grok', { kind: 'effort', effort: 'high' }))
      .toEqual({ patch: { reasoning_effort: 'high' }, degraded: false });
  });

  it('xhigh on grok-4.6 is sent native', () => {
    expect(translateOpenAiCompatibleThinking('grok', { kind: 'effort', effort: 'xhigh' }, 'grok-4.6'))
      .toEqual({ patch: { reasoning_effort: 'xhigh' }, degraded: false });
  });

  it('xhigh on grok-4.5 clamps to high (still sent)', () => {
    const r = translateOpenAiCompatibleThinking('grok', { kind: 'effort', effort: 'xhigh' }, 'grok-4.5');
    expect(r.patch).toEqual({ reasoning_effort: 'high' });
    expect(r.degraded).toBe(false);
    expect(r.note).toMatch(/xhigh/);
  });

  it('max on deepseek is sent native', () => {
    expect(translateOpenAiCompatibleThinking('deepseek', { kind: 'effort', effort: 'max' }, 'deepseek-v4-pro'))
      .toEqual({
        patch: { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
        degraded: false,
      });
  });

  it('high on deepseek stays high (max is a separate level)', () => {
    expect(translateOpenAiCompatibleThinking('deepseek', { kind: 'effort', effort: 'high' }))
      .toEqual({
        patch: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
        degraded: false,
      });
  });

  it('glm-5.3 effort uses reasoning_effort + thinking toggle', () => {
    expect(translateOpenAiCompatibleThinking('glm', { kind: 'effort', effort: 'max' }, 'glm-5.3'))
      .toEqual({
        patch: { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
        degraded: false,
      });
  });

  it('budget on effort-only providers degrades to auto', () => {
    const r = translateOpenAiCompatibleThinking('grok', { kind: 'budget', budgetTokens: 1000 });
    expect(r.degraded).toBe(true);
    expect(r.patch).toEqual({});
  });

  it('off on deepseek → thinking disabled', () => {
    expect(translateOpenAiCompatibleThinking('deepseek', { kind: 'off' }))
      .toEqual({ patch: { thinking: { type: 'disabled' } }, degraded: false });
  });

  it('budget on glm → thinking budget block', () => {
    expect(translateOpenAiCompatibleThinking('glm', { kind: 'budget', budgetTokens: 16000 }))
      .toEqual({ patch: { thinking: { type: 'enabled', budget_tokens: 16000 } }, degraded: false });
  });
});

describe('translateResponsesThinking', () => {
  it('off → reasoning minimal', () => {
    expect(translateResponsesThinking({ kind: 'off' }))
      .toEqual({ patch: { reasoning: { effort: 'minimal' } }, degraded: false });
  });
  it('effort → reasoning effort', () => {
    expect(translateResponsesThinking({ kind: 'effort', effort: 'high' }))
      .toEqual({ patch: { reasoning: { effort: 'high' } }, degraded: false });
  });
  it('xhigh/max on gpt-5.6 are sent native', () => {
    expect(translateResponsesThinking({ kind: 'effort', effort: 'xhigh' }, 'gpt-5.6'))
      .toEqual({ patch: { reasoning: { effort: 'xhigh' } }, degraded: false });
    expect(translateResponsesThinking({ kind: 'effort', effort: 'max' }, 'gpt-5.6-codex'))
      .toEqual({ patch: { reasoning: { effort: 'max' } }, degraded: false });
  });
  it('max on gpt-5.2 clamps to high', () => {
    const r = translateResponsesThinking({ kind: 'effort', effort: 'max' }, 'gpt-5.2-codex');
    expect(r.patch).toEqual({ reasoning: { effort: 'high' } });
    expect(r.degraded).toBe(false);
    expect(r.note).toMatch(/max/);
  });
  it('budget → degraded', () => {
    expect(translateResponsesThinking({ kind: 'budget', budgetTokens: 1000 }).degraded).toBe(true);
  });
});

describe('translateAnthropicThinking', () => {
  it('off → thinking disabled', () => {
    expect(translateAnthropicThinking({ kind: 'off' }))
      .toEqual({ patch: { thinking: { type: 'disabled' } }, degraded: false });
  });
  it('budget → enabled + budget_tokens', () => {
    expect(translateAnthropicThinking({ kind: 'budget', budgetTokens: 32000 }))
      .toEqual({ patch: { thinking: { type: 'enabled', budget_tokens: 32000 } }, degraded: false });
  });
  it('effort on sonnet 4.5 → degraded', () => {
    expect(translateAnthropicThinking({ kind: 'effort', effort: 'high' }, 'claude-sonnet-4-5').degraded).toBe(true);
  });
  it('effort on sonnet 4.6 → output_config.effort', () => {
    expect(translateAnthropicThinking({ kind: 'effort', effort: 'max' }, 'claude-sonnet-4-6'))
      .toEqual({ patch: { output_config: { effort: 'max' } }, degraded: false });
  });
  it('xhigh on opus 4.7 is native', () => {
    expect(translateAnthropicThinking({ kind: 'effort', effort: 'xhigh' }, 'claude-opus-4-7'))
      .toEqual({ patch: { output_config: { effort: 'xhigh' } }, degraded: false });
  });
});
