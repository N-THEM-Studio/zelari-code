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
    expect(resolveHarnessProfile('deepseek-chat', 'deepseek')).toBe('deepseek-v4');
  });

  it('maps Grok, MiniMax and GLM to separate profiles', () => {
    expect(resolveHarnessProfile('grok-4.6')).toBe('grok');
    expect(resolveHarnessProfile('MiniMax-M3')).toBe('minimax');
    expect(resolveHarnessProfile('glm-4.7')).toBe('glm');
    expect(resolveHarnessProfile('custom-model', 'grok')).toBe('grok');
    expect(resolveHarnessProfile('deepseek-chat')).toBe('deepseek-v4');
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
    expect(cap.buildRecovery.forceToolChoice).toBe(false);
    expect(cap.sampling.temperature).toBe(0.7);
    expect(cap.compaction).toEqual({ warnAt: 0.7, compactAt: 0.85, hardAt: 0.95 });
  });

  it('grok: 500k ctx, priced cache affinity and one forced recovery', () => {
    const cap = capabilitiesFor('grok-4.6');
    expect(cap.profile).toBe('grok');
    expect(cap.contextWindow).toBe(500_000);
    expect(cap.promptCache.pricedCacheRead).toBe(true);
    expect(cap.promptCache.conversationAffinityHeader).toBe('x-grok-conv-id');
    expect(cap.buildRecovery).toEqual({ forceToolChoice: true, maxForcedTurns: 1 });
    expect(cap.reasoning.levels).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('MiniMax and GLM keep their own context/replay profiles', () => {
    expect(capabilitiesFor('MiniMax-M3')).toMatchObject({
      profile: 'minimax',
      contextWindow: 1_000_000,
    });
    expect(capabilitiesFor('MiniMax-M2.7')).toMatchObject({
      profile: 'minimax',
      contextWindow: 204_800,
    });
    expect(capabilitiesFor('glm-4.7')).toMatchObject({
      profile: 'glm',
      contextWindow: 200_000,
    });
    expect(capabilitiesFor('glm-4.7').reasoning.replayReasoning).toBe(true);
  });

  it('default: 400k ctx, unpriced cache, no forced recovery', () => {
    const cap = capabilitiesFor('custom-model');
    expect(cap.profile).toBe('default');
    expect(cap.contextWindow).toBe(400_000);
    expect(cap.promptCache.pricedCacheRead).toBe(false);
    expect(cap.buildRecovery.forceToolChoice).toBe(false);
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
