/**
 * cli-skillSuggest.test.ts — Task H.2.2
 *
 * Tests for the skill suggestion engine. Verifies:
 *  - Tag match (exact + substring, case-insensitive) wins over name match
 *  - Name match used as fallback when no tag match
 *  - No-match scenario returns top-5 by global success rate (fallback)
 *  - Score is monotonically increasing with success rate when other
 *    factors are held constant
 *  - limit cap respected
 *  - formatSuggestions renders a readable CLI string
 */

import { describe, it, expect } from 'vitest';
import {
  suggestSkills,
  formatSuggestions,
  computeSuggestionScore,
} from '../../src/cli/skillSuggest.js';
import type { SkillMetadata } from '../../src/agents/skills.js';
import type { SkillHistoryRecord } from '../../src/cli/skillHistory.js';

const NOW = 1_700_000_000_000;

function makeSkill(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    id: 'test-skill',
    version: '1.0.0',
    tags: ['test'],
    relatedSkills: [],
    name: 'Test Skill',
    description: 'desc',
    category: 'utility',
    color: '#000',
    enabledByDefault: true,
    builtin: true,
    requiredTools: [],
    systemPromptFragment: '',
    ...overrides,
  };
}

function record(skillId: string, ok: boolean, durationMs: number, ts = NOW): SkillHistoryRecord {
  return {
    ts,
    skillId,
    invocationId: `${skillId}-${ts}`,
    durationMs,
    ok,
  };
}

describe('computeSuggestionScore (Task H.2.2)', () => {
  it('tag match boosts score over name match', () => {
    const stats = { count: 10, successRate: 0.8, avgDurationMs: 1500, totalTokens: 100 };
    expect(computeSuggestionScore(stats, 'tag'))
      .toBeGreaterThan(computeSuggestionScore(stats, 'name'));
  });

  it('name match boosts score over fallback', () => {
    const stats = { count: 10, successRate: 0.8, avgDurationMs: 1500, totalTokens: 100 };
    expect(computeSuggestionScore(stats, 'name'))
      .toBeGreaterThan(computeSuggestionScore(stats, 'fallback-popular'));
  });

  it('success rate is monotonic', () => {
    const low = { count: 10, successRate: 0.3, avgDurationMs: 1500, totalTokens: 100 };
    const high = { count: 10, successRate: 0.9, avgDurationMs: 1500, totalTokens: 100 };
    expect(computeSuggestionScore(high, 'tag'))
      .toBeGreaterThan(computeSuggestionScore(low, 'tag'));
  });

  it('count=0 (no history) gives a neutral speed score, not zero', () => {
    const noHistory = { count: 0, successRate: 0, avgDurationMs: 0, totalTokens: 0 };
    const score = computeSuggestionScore(noHistory, 'tag');
    expect(score).toBeGreaterThan(0); // not penalized for unknown skill
    expect(score).toBeLessThanOrEqual(1);
  });

  it('avgDuration above 30s clamps the speed contribution', () => {
    const slow = { count: 10, successRate: 0.9, avgDurationMs: 60_000, totalTokens: 100 };
    const verySlow = { count: 10, successRate: 0.9, avgDurationMs: 600_000, totalTokens: 100 };
    expect(computeSuggestionScore(slow, 'tag'))
      .toBe(computeSuggestionScore(verySlow, 'tag'));
  });

  it('score always in [0, 1]', () => {
    const cases = [
      { count: 0, successRate: 0, avgDurationMs: 0, totalTokens: 0 },
      { count: 100, successRate: 1, avgDurationMs: 0, totalTokens: 9999 },
      { count: 100, successRate: 0, avgDurationMs: 1_000_000, totalTokens: 9999 },
    ];
    for (const stats of cases) {
      for (const reason of ['tag', 'name', 'fallback-popular'] as const) {
        const score = computeSuggestionScore(stats, reason);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('suggestSkills — tag matching (Task H.2.2)', () => {
  const catalog: SkillMetadata[] = [
    makeSkill({ id: 'skill-debug', name: 'Debugger', tags: ['debug', 'bug', 'fix'] }),
    makeSkill({ id: 'skill-refactor', name: 'Refactor', tags: ['refactor', 'cleanup'] }),
    makeSkill({ id: 'skill-test', name: 'Tester', tags: ['test', 'verify'] }),
    makeSkill({ id: 'skill-wiki', name: 'Wiki Helper', tags: ['docs', 'wiki'] }),
  ];

  it('exact tag substring match returns that skill', async () => {
    const results = await suggestSkills('debug', { catalog, records: [] });
    expect(results.length).toBe(1);
    expect(results[0]?.skill.id).toBe('skill-debug');
    expect(results[0]?.matchReason).toBe('tag');
  });

  it('case-insensitive tag match works', async () => {
    const results = await suggestSkills('DEBUG', { catalog, records: [] });
    expect(results.some((r) => r.skill.id === 'skill-debug')).toBe(true);
  });

  it('partial tag substring match works', async () => {
    const results = await suggestSkills('fix', { catalog, records: [] });
    expect(results.some((r) => r.skill.id === 'skill-debug')).toBe(true);
  });

  it('multiple matching skills are returned, ordered by score', async () => {
    const localCatalog: SkillMetadata[] = [
      makeSkill({ id: 'skill-debug', name: 'Debugger', tags: ['debug', 'fix'] }),
      makeSkill({ id: 'skill-refactor', name: 'Refactor', tags: ['refactor', 'fix'] }),
      makeSkill({ id: 'skill-test', name: 'Tester', tags: ['test', 'verify'] }),
    ];
    const records: SkillHistoryRecord[] = [
      record('skill-debug', true, 1000),
      record('skill-debug', true, 1000),
      record('skill-refactor', true, 1000),
      record('skill-refactor', false, 1000), // 50% success
    ];
    const results = await suggestSkills('fix', { catalog: localCatalog, records });
    expect(results.length).toBeGreaterThanOrEqual(2);
    // debug should score higher (100% success vs 50%)
    expect(results[0]?.skill.id).toBe('skill-debug');
    expect(results[1]?.skill.id).toBe('skill-refactor');
  });
});

describe('suggestSkills — name fallback (Task H.2.2)', () => {
  const catalog: SkillMetadata[] = [
    makeSkill({ id: 'skill-debug', name: 'Debugger', tags: ['debug'] }),
    makeSkill({ id: 'skill-x', name: 'X-ray Vision', tags: [] }),
  ];

  it('falls back to name match when no tag match exists', async () => {
    const results = await suggestSkills('x-ray', { catalog, records: [] });
    expect(results.length).toBe(1);
    expect(results[0]?.skill.id).toBe('skill-x');
    expect(results[0]?.matchReason).toBe('name');
  });

  it('id substring also matches as name-fallback', async () => {
    const results = await suggestSkills('skill-x', { catalog, records: [] });
    expect(results.some((r) => r.skill.id === 'skill-x')).toBe(true);
  });
});

describe('suggestSkills — popular fallback (Task H.2.2)', () => {
  it('no-match query returns top-5 by global success rate', async () => {
    const catalog: SkillMetadata[] = [
      makeSkill({ id: 'a', name: 'A', tags: ['x'] }),
      makeSkill({ id: 'b', name: 'B', tags: ['y'] }),
      makeSkill({ id: 'c', name: 'C', tags: ['z'] }),
      makeSkill({ id: 'd', name: 'D', tags: ['w'] }),
      makeSkill({ id: 'e', name: 'E', tags: ['v'] }),
      makeSkill({ id: 'f', name: 'F', tags: ['u'] }),
    ];
    const records: SkillHistoryRecord[] = [
      record('a', true, 100), record('a', true, 100), // 100% × 2
      record('b', true, 100), // 100% × 1
      record('c', false, 100), // 0% × 1
    ];
    const results = await suggestSkills('nonexistent-query', { catalog, records });
    expect(results.length).toBe(5); // top-5 cap
    expect(results.every((r) => r.matchReason === 'fallback-popular')).toBe(true);
    // a (100% × 2 runs) should rank above b (100% × 1) should rank above c (0%)
    const ids = results.map((r) => r.skill.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });

  it('empty query returns fallback (no matches)', async () => {
    const catalog: SkillMetadata[] = [
      makeSkill({ id: 'a', name: 'A', tags: ['x'] }),
    ];
    const results = await suggestSkills('', { catalog, records: [] });
    expect(results.every((r) => r.matchReason === 'fallback-popular')).toBe(true);
  });
});

describe('suggestSkills — limit cap (Task H.2.2)', () => {
  it('respects the limit parameter', async () => {
    const catalog: SkillMetadata[] = Array.from({ length: 10 }, (_, i) =>
      makeSkill({ id: `s-${i}`, name: `S${i}`, tags: ['test'] }),
    );
    const results = await suggestSkills('test', { catalog, records: [], limit: 3 });
    expect(results.length).toBe(3);
  });
});

describe('formatSuggestions (Task H.2.2)', () => {
  it('renders empty case', () => {
    expect(formatSuggestions([])).toContain('no skills available');
  });

  it('renders entries with id, name, score, stats, reason', async () => {
    const catalog: SkillMetadata[] = [
      makeSkill({ id: 'my-skill', name: 'My Skill', tags: ['foo'] }),
    ];
    const records: SkillHistoryRecord[] = [
      record('my-skill', true, 500),
      record('my-skill', true, 500),
    ];
    const results = await suggestSkills('foo', { catalog, records });
    const formatted = formatSuggestions(results);
    expect(formatted).toContain('my-skill');
    expect(formatted).toContain('My Skill');
    expect(formatted).toContain('tag match');
    expect(formatted).toContain('100% ok');
    expect(formatted).toContain('2 runs');
    expect(formatted).toMatch(/score \d\.\d+/);
  });
});
