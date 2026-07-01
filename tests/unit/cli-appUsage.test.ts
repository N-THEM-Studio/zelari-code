/**
 * cli-appUsage.test.ts — Task G.4.5
 *
 * Verifies the session-stats helper `computeSessionStatsDelta` extracted
 * from `app.tsx` dispatchPrompt. It must prefer provider-reported usage
 * when present (Task G.4) and fall back to the v3-B ~4-char/token
 * approximation when usage is missing.
 */

import { describe, it, expect } from 'vitest';
import { computeSessionStatsDelta } from '../../src/cli/hooks/chatStats.js';

describe('computeSessionStatsDelta (Task G.4.5)', () => {
  it('uses real provider usage when present — no approximation', () => {
    const result = computeSessionStatsDelta(
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      'user text that would otherwise estimate to 4 tokens',
      'assistant content that would otherwise estimate to 6 tokens',
      'grok-4',
      { totalTokens: 0, totalCostUsd: 0 },
    );
    // 100 + 50 = 150 — NOT 4+6=10 (which would be the fallback).
    expect(result.totalTokens).toBe(150);
    // Cost is computed via modelPricing. grok-4 has input=$3/M, output=$15/M
    // → 100/1e6 * 3 + 50/1e6 * 15 = 0.0003 + 0.00075 = 0.00105
    expect(result.totalCostUsd).toBeCloseTo(0.00105, 6);
  });

  it('falls back to ~4-char/token estimate when usage is null', () => {
    const result = computeSessionStatsDelta(
      null,
      'a'.repeat(40), // 40 chars → ceil(40/4) = 10 tokens
      'b'.repeat(80), // 80 chars → ceil(80/4) = 20 tokens
      'grok-4',
      { totalTokens: 0, totalCostUsd: 0 },
    );
    // 10 + 20 = 30 tokens (fallback estimate)
    expect(result.totalTokens).toBe(30);
    // Cost: 10/1e6 * 3 + 20/1e6 * 15 = 0.00003 + 0.0003 = 0.00033
    expect(result.totalCostUsd).toBeCloseTo(0.00033, 6);
  });

  it('accumulates onto prev stats (caller merges via setSessionStats)', () => {
    const result = computeSessionStatsDelta(
      { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      'x',
      'y',
      'grok-4',
      { totalTokens: 1000, totalCostUsd: 0.5 },
    );
    expect(result.totalTokens).toBe(1015);
    expect(result.totalCostUsd).toBeGreaterThan(0.5);
  });

  it('handles zero-length inputs gracefully', () => {
    const result = computeSessionStatsDelta(
      null,
      '',
      '',
      'grok-4',
      { totalTokens: 0, totalCostUsd: 0 },
    );
    // ceil(0/4) = 0 tokens, cost = 0
    expect(result.totalTokens).toBe(0);
    expect(result.totalCostUsd).toBe(0);
  });
});
