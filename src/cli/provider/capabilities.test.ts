import { describe, it, expect } from 'vitest';
import {
  capabilitiesFor,
  resolveHarnessProfile,
  isDeepSeekV4Model,
} from './capabilities.js';

describe('provider capabilities / harness profiles', () => {
  it('maps deepseek-v4* to the dedicated profile', () => {
    expect(resolveHarnessProfile('deepseek-v4-pro')).toBe('deepseek-v4');
    expect(resolveHarnessProfile('deepseek-v4-flash')).toBe('deepseek-v4');
    expect(resolveHarnessProfile('deepseek-v4')).toBe('deepseek-v4');
    expect(isDeepSeekV4Model('deepseek-v4.1')).toBe(true);
  });

  it('maps everything else to default', () => {
    expect(resolveHarnessProfile('grok-4')).toBe('default');
    expect(resolveHarnessProfile('deepseek-chat')).toBe('default');
    expect(resolveHarnessProfile(undefined)).toBe('default');
    expect(isDeepSeekV4Model('glm-4.6')).toBe(false);
  });

  it('deepseek-v4: 1M ctx, priced cache, reasoning replay, same compaction', () => {
    const cap = capabilitiesFor('deepseek-v4-pro');
    expect(cap.profile).toBe('deepseek-v4');
    expect(cap.contextWindow).toBe(1_000_000);
    expect(cap.promptCache.supported).toBe(true);
    expect(cap.promptCache.pricedCacheRead).toBe(true);
    expect(cap.reasoning.supported).toBe(true);
    expect(cap.reasoning.replayReasoning).toBe(true);
    expect(cap.reasoning.levels).toEqual(['high', 'max']);
    expect(cap.toolCalling.parallel).toBe(true);
    expect(cap.sampling.temperature).toBe(0.7);
    expect(cap.compaction).toEqual({ warnAt: 0.7, compactAt: 0.85, hardAt: 0.95 });
  });

  it('default: 400k ctx, unpriced cache, same sampling/compaction', () => {
    const cap = capabilitiesFor('grok-4');
    expect(cap.profile).toBe('default');
    expect(cap.contextWindow).toBe(400_000);
    expect(cap.promptCache.pricedCacheRead).toBe(false);
    expect(cap.sampling.temperature).toBe(0.7);
    expect(cap.compaction.compactAt).toBe(0.85);
    expect(cap.compaction.hardAt).toBe(0.95);
  });

  it('returned objects are frozen (callers cannot mutate shared policy)', () => {
    const cap = capabilitiesFor('deepseek-v4-flash');
    expect(Object.isFrozen(cap)).toBe(true);
    expect(() => {
      (cap as { contextWindow: number }).contextWindow = 1;
    }).toThrow();
  });
});
