/**
 * Tests for the planner system prompt builder.
 *
 * Today the only knob is the Bennett's Razor opt-in. Future knobs (e.g.
 * "include the Gauntlet Loop recipe", "include an example plan") belong
 * here as well — keep all prompt-shape decisions in one tested place.
 *
 * @since v1.31.x — Bennett's Razor opt-in
 */

import { describe, expect, it } from 'vitest';
import {
  KRAKEN_PLANNER_SYSTEM_PROMPT,
  buildPlannerSystemPrompt,
  isKrakenPlannerFallbackEnabled,
  plannerFallbackDigest,
} from './planner.js';

describe('buildPlannerSystemPrompt', () => {
  it('returns the base prompt unchanged when the env var is unset', () => {
    expect(buildPlannerSystemPrompt({})).toBe(KRAKEN_PLANNER_SYSTEM_PROMPT);
    expect(buildPlannerSystemPrompt({ ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR: '' })).toBe(
      KRAKEN_PLANNER_SYSTEM_PROMPT,
    );
  });

  it('returns the base prompt for non-truthy env values', () => {
    expect(buildPlannerSystemPrompt({ ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR: '0' })).toBe(
      KRAKEN_PLANNER_SYSTEM_PROMPT,
    );
    expect(buildPlannerSystemPrompt({ ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR: 'false' })).toBe(
      KRAKEN_PLANNER_SYSTEM_PROMPT,
    );
    expect(buildPlannerSystemPrompt({ ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR: 'no' })).toBe(
      KRAKEN_PLANNER_SYSTEM_PROMPT,
    );
  });

  it('appends the Bennett\'s Razor section when ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR=1', () => {
    const prompt = buildPlannerSystemPrompt({ ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR: '1' });
    expect(prompt).toContain(KRAKEN_PLANNER_SYSTEM_PROMPT);
    expect(prompt).toMatch(/Bennett/i);
    expect(prompt).toMatch(/assumes? the least/i);
    expect(prompt).toMatch(/tie-breaker/i);
    expect(prompt.length).toBeGreaterThan(KRAKEN_PLANNER_SYSTEM_PROMPT.length + 200);
  });

  it('also accepts "true" (case-insensitive) as truthy', () => {
    const prompt = buildPlannerSystemPrompt({ ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR: 'TRUE' });
    expect(prompt).toMatch(/Bennett/i);
  });

  it('appends the section AFTER the base prompt (not before)', () => {
    const prompt = buildPlannerSystemPrompt({ ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR: '1' });
    const baseIdx = prompt.indexOf(KRAKEN_PLANNER_SYSTEM_PROMPT);
    const razorIdx = prompt.indexOf("Bennett's Razor");
    expect(baseIdx).toBe(0);
    expect(razorIdx).toBeGreaterThan(0);
    expect(razorIdx).toBeGreaterThan(KRAKEN_PLANNER_SYSTEM_PROMPT.length);
  });
});

// K3.4 / F17: the planner-fallback gate is read by CALLERS (planTaskGraph
// keeps throwing). Same env idiom as Bennett's Razor: '1' | 'true' (any case).
describe('isKrakenPlannerFallbackEnabled', () => {
  it('is off by default and for empty/non-truthy values', () => {
    expect(isKrakenPlannerFallbackEnabled({})).toBe(false);
    expect(isKrakenPlannerFallbackEnabled({ ZELARI_KRAKEN_PLANNER_FALLBACK: '' })).toBe(false);
    expect(isKrakenPlannerFallbackEnabled({ ZELARI_KRAKEN_PLANNER_FALLBACK: '0' })).toBe(false);
    expect(isKrakenPlannerFallbackEnabled({ ZELARI_KRAKEN_PLANNER_FALLBACK: 'false' })).toBe(false);
    expect(isKrakenPlannerFallbackEnabled({ ZELARI_KRAKEN_PLANNER_FALLBACK: 'no' })).toBe(false);
  });

  it('is on for 1 and true (case-insensitive)', () => {
    expect(isKrakenPlannerFallbackEnabled({ ZELARI_KRAKEN_PLANNER_FALLBACK: '1' })).toBe(true);
    expect(isKrakenPlannerFallbackEnabled({ ZELARI_KRAKEN_PLANNER_FALLBACK: 'true' })).toBe(true);
    expect(isKrakenPlannerFallbackEnabled({ ZELARI_KRAKEN_PLANNER_FALLBACK: 'TRUE' })).toBe(true);
  });
});

describe('plannerFallbackDigest', () => {
  it('keeps the full message as the reason and the digest for short errors', () => {
    const { reason, digest } = plannerFallbackDigest(new Error('LLM HTTP 500'));
    expect(reason).toBe('LLM HTTP 500');
    expect(digest).toBe('LLM HTTP 500');
  });

  it('stringifies non-Error throws (PlannerTransportError → message, raw throw → String)', () => {
    expect(plannerFallbackDigest('boom').reason).toBe('boom');
    expect(plannerFallbackDigest({ code: 500 }).reason).toBe('[object Object]');
  });

  it('truncates a >240-char message in the digest but not in the reason', () => {
    const long = 'x'.repeat(500);
    const { reason, digest } = plannerFallbackDigest(new Error(long));
    expect(reason).toBe(long);
    expect(digest).toBe(`${'x'.repeat(237)}...`);
    expect(digest.length).toBe(240);
  });
});
