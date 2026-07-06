import { describe, it, expect } from 'vitest';
import { parseCachedPromptTokens } from '../../src/cli/provider/openai-compatible.js';
import { computeSessionStatsDelta } from '../../src/cli/hooks/chatStats.js';

/**
 * Prompt caching (v1.2) — the OpenAI-compatible providers cache the stable
 * prompt prefix server-side and report the hit count two different ways.
 * These tests pin the normalization + the cache-aware cost/stat aggregation.
 */
describe('parseCachedPromptTokens', () => {
  it('reads the OpenAI / xAI / GLM shape (prompt_tokens_details.cached_tokens)', () => {
    expect(parseCachedPromptTokens({ prompt_tokens_details: { cached_tokens: 1234 } })).toBe(1234);
  });

  it('reads the DeepSeek shape (prompt_cache_hit_tokens)', () => {
    expect(parseCachedPromptTokens({ prompt_cache_hit_tokens: 987 })).toBe(987);
  });

  it('returns 0 when no cache field is present', () => {
    expect(parseCachedPromptTokens({})).toBe(0);
    expect(parseCachedPromptTokens(undefined)).toBe(0);
    expect(parseCachedPromptTokens(null)).toBe(0);
  });

  it('ignores non-finite / negative values', () => {
    expect(parseCachedPromptTokens({ prompt_cache_hit_tokens: -5 })).toBe(0);
    expect(parseCachedPromptTokens({ prompt_tokens_details: { cached_tokens: Number.NaN } })).toBe(0);
  });
});

describe('computeSessionStatsDelta — cache accounting', () => {
  const prev = { totalTokens: 0, totalCostUsd: 0, cachedTokens: 0 };

  it('accumulates cached tokens from real usage', () => {
    const next = computeSessionStatsDelta(
      { promptTokens: 10_000, completionTokens: 500, totalTokens: 10_500, cachedPromptTokens: 8_000 },
      'hi',
      'there',
      'deepseek-v4-pro',
      prev,
    );
    expect(next.cachedTokens).toBe(8_000);
    expect(next.totalTokens).toBe(10_500);
  });

  it('charges less when part of the prompt was cached', () => {
    const usage = { promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000 };
    const noCache = computeSessionStatsDelta({ ...usage }, '', '', 'deepseek-v4-pro', prev);
    const withCache = computeSessionStatsDelta(
      { ...usage, cachedPromptTokens: 90_000 },
      '', '', 'deepseek-v4-pro', prev,
    );
    expect(withCache.totalCostUsd).toBeLessThan(noCache.totalCostUsd);
  });

  it('assumes 0 cached tokens on the char/4 fallback (no real usage)', () => {
    const next = computeSessionStatsDelta(null, 'some prompt', 'some reply', 'grok-4', prev);
    expect(next.cachedTokens).toBe(0);
  });

  it('carries a missing prev.cachedTokens as 0', () => {
    const next = computeSessionStatsDelta(
      { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedPromptTokens: 40 },
      '', '', 'grok-4',
      { totalTokens: 5, totalCostUsd: 0.001 },
    );
    expect(next.cachedTokens).toBe(40);
  });
});
