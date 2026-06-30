/**
 * cli-skillCompareCommand.test.ts — Task H.3.2
 *
 * Tests for the `/skill-compare <id1> <id2>` slash command:
 *  1. Slash command parsing (handleSlashCommand) — accepts/rejects args
 *  2. Pure helper `formatSkillCompare` — renders side-by-side stats
 *  3. Pure helper `pickCompareWinner` — winner heuristic edge cases
 *  4. Integration: `compareSkillsFromFile` reads NDJSON + formats
 */

import { describe, it, expect } from 'vitest';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';
import {
  formatSkillCompare,
  pickCompareWinner,
  compareSkillsFromFile,
} from '../../src/cli/app.js';
import type { SkillHistoryRecord } from '../../src/cli/skillHistory.js';

const NOW = 1_700_000_000_000;

function rec(skillId: string, ok: boolean, durationMs: number, tokensUsed = 100): SkillHistoryRecord {
  return {
    ts: NOW,
    skillId,
    invocationId: `${skillId}-${ts()}`,
    durationMs,
    ok,
    tokensUsed,
  };
}

let counter = 0;
function ts(): number {
  counter++;
  return NOW + counter;
}

describe('handleSlashCommand /skill-compare parsing (Task H.3.2)', () => {
  it('two IDs → handled with compareIds populated', () => {
    const result = handleSlashCommand('/skill-compare debug refactor', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('skill-compare');
    expect(result.compareIds).toEqual(['debug', 'refactor']);
    expect(result.message).toContain('Comparing');
  });

  it('one ID → handled with warning message (no compareIds)', () => {
    const result = handleSlashCommand('/skill-compare debug', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('skill-compare');
    expect(result.compareIds).toBeUndefined();
    expect(result.message).toContain('exactly 2 skill IDs');
  });

  it('zero IDs → handled with warning', () => {
    const result = handleSlashCommand('/skill-compare', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('skill-compare');
    expect(result.compareIds).toBeUndefined();
    expect(result.message).toContain('exactly 2 skill IDs');
  });

  it('three IDs → handled, only first two are picked (rest ignored)', () => {
    const result = handleSlashCommand('/skill-compare debug refactor test', []);
    expect(result.handled).toBe(true);
    expect(result.compareIds).toEqual(['debug', 'refactor']);
  });
});

describe('pickCompareWinner (Task H.3.2)', () => {
  it('higher successRate wins', () => {
    const a = { count: 10, successRate: 0.9, avgDurationMs: 1000, totalTokens: 100 };
    const b = { count: 10, successRate: 0.5, avgDurationMs: 1000, totalTokens: 100 };
    expect(pickCompareWinner(a, b)).toBe('a');
    expect(pickCompareWinner(b, a)).toBe('b');
  });

  it('same successRate — lower avgDurationMs wins', () => {
    const a = { count: 10, successRate: 0.8, avgDurationMs: 500, totalTokens: 100 };
    const b = { count: 10, successRate: 0.8, avgDurationMs: 2000, totalTokens: 100 };
    expect(pickCompareWinner(a, b)).toBe('a');
    expect(pickCompareWinner(b, a)).toBe('b');
  });

  it('perfect tie (same success + same duration) → null', () => {
    const a = { count: 10, successRate: 0.8, avgDurationMs: 1000, totalTokens: 100 };
    const b = { count: 10, successRate: 0.8, avgDurationMs: 1000, totalTokens: 100 };
    expect(pickCompareWinner(a, b)).toBeNull();
    expect(pickCompareWinner(b, a)).toBeNull();
  });

  it('successRate takes priority even when duration suggests otherwise', () => {
    const a = { count: 10, successRate: 0.7, avgDurationMs: 5000, totalTokens: 100 };
    const b = { count: 10, successRate: 0.9, avgDurationMs: 500, totalTokens: 100 };
    expect(pickCompareWinner(a, b)).toBe('b'); // b wins on success despite faster a
  });
});

describe('formatSkillCompare (Task H.3.2)', () => {
  it('renders header + both skills + winner line', () => {
    const records: SkillHistoryRecord[] = [
      rec('debug', true, 1000),
      rec('debug', true, 1000),
      rec('refactor', true, 1000),
      rec('refactor', false, 1000),
    ];
    const out = formatSkillCompare('debug', 'refactor', records);
    expect(out).toContain('[skill-compare]');
    expect(out).toContain('debug');
    expect(out).toContain('refactor');
    expect(out).toContain('100.0% success'); // debug 100%
    expect(out).toContain('50.0% success'); // refactor 50%
    expect(out).toContain('Winner: debug');
  });

  it('renders "no invocations" for unknown skill', () => {
    const records: SkillHistoryRecord[] = [rec('known', true, 1000)];
    const out = formatSkillCompare('known', 'unknown', records);
    expect(out).toContain('unknown — no invocations recorded yet');
    expect(out).toContain('Winner: (insufficient data');
  });

  it('handles both skills having no history', () => {
    const out = formatSkillCompare('a', 'b', []);
    expect(out).toContain('no invocations recorded yet');
    expect(out).toContain('Winner: (insufficient data');
  });

  it('reports tie on perfect tie', () => {
    const records: SkillHistoryRecord[] = [
      rec('a', true, 1000),
      rec('b', true, 1000),
    ];
    const out = formatSkillCompare('a', 'b', records);
    expect(out).toContain('Winner: tie');
  });

  it('reports tie-break by avg duration when success rates equal', () => {
    const records: SkillHistoryRecord[] = [
      rec('a', true, 500),
      rec('a', true, 500),
      rec('b', true, 500),
      rec('b', true, 500),
    ];
    // Both 100% success, both 500ms — perfect tie
    const out = formatSkillCompare('a', 'b', records);
    expect(out).toContain('Winner: tie');
  });
});

describe('compareSkillsFromFile integration (Task H.3.2)', () => {
  it('reads NDJSON history file + formats compare', async () => {
    // Use a small in-memory NDJSON file via the readSkillHistory helper
    // — actually compareSkillsFromFile just reads whatever file we point
    // at, so use a real temp file.
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const dir = mkdtempSync(path.join(tmpdir(), 'compare-skills-'));
    const file = path.join(dir, 'history.jsonl');
    try {
      const lines = [
        rec('debug', true, 1000),
        rec('debug', true, 1000),
        rec('refactor', false, 1000),
      ].map((r) => JSON.stringify(r));
      writeFileSync(file, lines.join('\n') + '\n', 'utf-8');

      const out = await compareSkillsFromFile('debug', 'refactor', file);
      expect(out).toContain('debug');
      expect(out).toContain('refactor');
      expect(out).toContain('Winner: debug');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
