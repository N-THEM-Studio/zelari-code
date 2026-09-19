import { describe, it, expect } from 'vitest';
import {
  formatCacheHitSummary,
  summarizeCacheHits,
  type CacheHitMessageRecord,
} from './cacheHitReport.js';

/**
 * M1.2 (cache-hit-rate plan): offline aggregation feeding the `--doctor`
 * "Prompt cache" section. The contract that matters: no data must stay
 * "no data" (null) instead of collapsing into a fake 0%.
 */

const DEEPSEEK_HIT: CacheHitMessageRecord = {
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  promptTokens: 10_000,
  cachedPromptTokens: 6_500,
};
const DEEPSEEK_MISS: CacheHitMessageRecord = {
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  promptTokens: 10_000,
  cachedPromptTokens: 0,
};
const GROK_ROW: CacheHitMessageRecord = {
  provider: 'grok',
  model: 'grok-4.5',
  promptTokens: 30_000,
  cachedPromptTokens: 3_000,
};

describe('summarizeCacheHits', () => {
  it('returns null when there is no usable row (fresh install / pre-M1.1 sessions)', () => {
    expect(summarizeCacheHits([])).toBeNull();
    // Rows without a prompt-token count carry no measurable cache signal.
    expect(summarizeCacheHits([{ provider: 'grok' }, { promptTokens: 0 }])).toBeNull();
  });

  it('folds tokens into an overall hit rate and a per-model breakdown', () => {
    const summary = summarizeCacheHits([DEEPSEEK_HIT, DEEPSEEK_MISS, GROK_ROW]);
    expect(summary).not.toBeNull();
    expect(summary!.messages).toBe(3);
    expect(summary!.promptTokens).toBe(50_000);
    expect(summary!.cachedPromptTokens).toBe(9_500);
    expect(summary!.hitRate).toBeCloseTo(9_500 / 50_000, 10);

    // Heaviest prompt volume first: grok (30k) before deepseek (20k).
    expect(summary!.byModel.map((r) => `${r.provider}/${r.model}`)).toEqual([
      'grok/grok-4.5',
      'deepseek/deepseek-v4-pro',
    ]);
    expect(summary!.byModel[0]).toMatchObject({
      messages: 1,
      promptTokens: 30_000,
      cachedPromptTokens: 3_000,
    });
    expect(summary!.byModel[1]).toMatchObject({
      messages: 2,
      promptTokens: 20_000,
      cachedPromptTokens: 6_500,
      hitRate: 6_500 / 20_000,
    });
  });

  it('clamps a cached count above the prompt count (no hit rate above 100%)', () => {
    const summary = summarizeCacheHits([
      { provider: 'glm', model: 'glm-4.6', promptTokens: 1_000, cachedPromptTokens: 5_000 },
    ]);
    expect(summary!.cachedPromptTokens).toBe(1_000);
    expect(summary!.hitRate).toBe(1);
  });

  it('falls back to "unknown" identity instead of dropping anonymous rows', () => {
    const summary = summarizeCacheHits([{ promptTokens: 100, cachedPromptTokens: 25 }]);
    expect(summary!.byModel[0]).toMatchObject({ provider: 'unknown', model: 'unknown' });
    expect(summary!.hitRate).toBeCloseTo(0.25, 10);
  });

  it('keeps only the most recent `window` calls', () => {
    const rows: CacheHitMessageRecord[] = Array.from({ length: 6 }, () => ({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      promptTokens: 100,
      cachedPromptTokens: 50,
    }));
    const summary = summarizeCacheHits(rows, 2);
    expect(summary!.messages).toBe(2);
    expect(summary!.promptTokens).toBe(200);
  });
});

describe('formatCacheHitSummary', () => {
  it('renders the hit rate, totals and top models as doctor lines', () => {
    const lines = formatCacheHitSummary(summarizeCacheHits([DEEPSEEK_HIT, DEEPSEEK_MISS, GROK_ROW])!);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('messages 3 · prompt 50,000 tokens · cached 9,500 · hit 19.0%');
    expect(lines[1]).toContain('grok/grok-4.5 10.0% (1 msg · 30,000 prompt)');
    expect(lines[1]).toContain('deepseek/deepseek-v4-pro 32.5% (2 msg · 20,000 prompt)');
  });

  it('renders a 0.0% line for a model that reported no cache hit', () => {
    const lines = formatCacheHitSummary(summarizeCacheHits([DEEPSEEK_MISS])!);
    expect(lines[0]).toBe('messages 1 · prompt 10,000 tokens · cached 0 · hit 0.0%');
    expect(lines[1]).toContain('deepseek/deepseek-v4-pro 0.0%');
  });
});
