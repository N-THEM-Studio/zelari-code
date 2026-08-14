import { describe, it, expect } from 'vitest';
import {
  parseThinkingSpec,
  stringifyThinkingSpec,
  isValidThinkingInput,
  thinkingCapabilityFor,
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
    expect(stringifyThinkingSpec(parseThinkingSpec('budget:16000'))).toBe('budget:16000');
    expect(stringifyThinkingSpec('auto')).toBe('auto');
  });

  it('validates strictly', () => {
    expect(isValidThinkingInput('auto')).toBe(true);
    expect(isValidThinkingInput('off')).toBe(true);
    expect(isValidThinkingInput('medium')).toBe(true);
    expect(isValidThinkingInput('budget:16000')).toBe(true);
    expect(isValidThinkingInput('garbage')).toBe(false);
    expect(isValidThinkingInput('budget:0')).toBe(false);
  });
});

describe('thinkingCapabilityFor', () => {
  it('flags effort vs budget providers', () => {
    expect(thinkingCapabilityFor('grok').effort).toBe(true);
    expect(thinkingCapabilityFor('anthropic').budget).toBe(true);
    expect(thinkingCapabilityFor('glm').budget).toBe(true);
    expect(thinkingCapabilityFor('deepseek').effort).toBe(true);
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
  it('effort → degraded', () => {
    expect(translateAnthropicThinking({ kind: 'effort', effort: 'high' }).degraded).toBe(true);
  });
});
