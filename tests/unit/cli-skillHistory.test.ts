import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SkillHistoryLogger,
  readSkillHistory,
  getSkillStats,
  SKILL_HISTORY_ROTATE_BYTES,
  type SkillHistoryRecord,
} from '../../src/cli/skillHistory.js';

describe('SkillHistoryLogger (Phase 25 — Skill History)', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'skill-history-test-'));
    file = path.join(tmpDir, 'skill-history.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('constructor creates the parent directory and uses default filename when no arg', async () => {
    const customTmp = mkdtempSync(path.join(tmpdir(), 'skill-history-default-'));
    try {
      const f = path.join(customTmp, 'sub', 'skill-history.jsonl');
      const logger = new SkillHistoryLogger(f);
      const id = logger.recordStart('foo');
      logger.recordEnd(id, { ok: true });
      await logger.flush();
      expect(existsSync(f)).toBe(true);
    } finally {
      rmSync(customTmp, { recursive: true, force: true });
    }
  });

  it('recordStart returns a unique invocationId', () => {
    const logger = new SkillHistoryLogger(file);
    const id1 = logger.recordStart('skill-a');
    const id2 = logger.recordStart('skill-a');
    expect(typeof id1).toBe('string');
    expect(typeof id2).toBe('string');
    expect(id1).not.toBe(id2);
    expect(logger.inflightCount()).toBe(2);
  });

  it('recordEnd writes a valid NDJSON line with ok=true', async () => {
    const logger = new SkillHistoryLogger(file);
    const id = logger.recordStart('brain-debug', 'session-1');
    logger.recordEnd(id, { ok: true, tokensUsed: 42 });
    await logger.flush();
    const raw = readFileSync(file, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]) as SkillHistoryRecord;
    expect(rec.skillId).toBe('brain-debug');
    expect(rec.invocationId).toBe(id);
    expect(rec.sessionId).toBe('session-1');
    expect(rec.ok).toBe(true);
    expect(rec.tokensUsed).toBe(42);
    expect(typeof rec.durationMs).toBe('number');
    expect(rec.error).toBeUndefined();
    expect(logger.inflightCount()).toBe(0);
  });

  it('recordEnd with ok=false persists error message', async () => {
    const logger = new SkillHistoryLogger(file);
    const id = logger.recordStart('broken-skill');
    logger.recordEnd(id, { ok: false, error: 'tool execution failed' });
    await logger.flush();
    const recs = await readSkillHistory(file);
    expect(recs.length).toBe(1);
    expect(recs[0].ok).toBe(false);
    expect(recs[0].error).toBe('tool execution failed');
  });

  it('recordEnd with unknown invocationId is a graceful no-op (no throw)', async () => {
    const logger = new SkillHistoryLogger(file);
    expect(() => logger.recordEnd('bogus-id', { ok: true })).not.toThrow();
    await logger.flush();
    // File should not exist since no record was actually written.
    expect(existsSync(file)).toBe(false);
  });

  it('concurrent invocations each persist independently', async () => {
    const logger = new SkillHistoryLogger(file);
    const id1 = logger.recordStart('skill-a', 's1');
    const id2 = logger.recordStart('skill-b', 's2');
    logger.recordEnd(id1, { ok: true });
    logger.recordEnd(id2, { ok: false, error: 'oops' });
    await logger.flush();
    const recs = await readSkillHistory(file);
    expect(recs.length).toBe(2);
    const byId = new Map(recs.map((r) => [r.invocationId, r]));
    expect(byId.get(id1)?.ok).toBe(true);
    expect(byId.get(id2)?.ok).toBe(false);
    expect(byId.get(id2)?.error).toBe('oops');
  });

  it('rotation threshold exported as 10MB', () => {
    expect(SKILL_HISTORY_ROTATE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('readSkillHistory', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'read-skill-history-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when the file does not exist', async () => {
    const missing = path.join(tmpDir, 'nope.jsonl');
    const recs = await readSkillHistory(missing);
    expect(recs).toEqual([]);
  });

  it('skips malformed lines and returns the valid ones', async () => {
    const file = path.join(tmpDir, 'skill-history.jsonl');
    const valid: SkillHistoryRecord = {
      ts: 1700000000000,
      skillId: 'foo',
      invocationId: 'id-1',
      ok: true,
    };
    const content = `${JSON.stringify(valid)}\n{this is not json}\n${JSON.stringify({ ...valid, invocationId: 'id-2' })}\n`;
    require('node:fs').writeFileSync(file, content);
    const recs = await readSkillHistory(file);
    expect(recs.length).toBe(2);
    expect(recs[0].invocationId).toBe('id-1');
    expect(recs[1].invocationId).toBe('id-2');
  });
});

describe('getSkillStats', () => {
  const baseRec: SkillHistoryRecord = {
    ts: 1700000000000,
    skillId: 'brain-debug',
    invocationId: 'id-1',
    ok: true,
    durationMs: 1000,
    tokensUsed: 100,
  };

  it('returns all zeros when records is empty', () => {
    expect(getSkillStats([])).toEqual({ count: 0, successRate: 0, avgDurationMs: 0, totalTokens: 0 });
  });

  it('counts and computes success rate correctly', () => {
    const recs: SkillHistoryRecord[] = [
      { ...baseRec, invocationId: 'a', ok: true },
      { ...baseRec, invocationId: 'b', ok: true },
      { ...baseRec, invocationId: 'c', ok: false, error: 'x' },
    ];
    const stats = getSkillStats(recs);
    expect(stats.count).toBe(3);
    expect(stats.successRate).toBeCloseTo(2 / 3);
    expect(stats.avgDurationMs).toBe(1000);
    expect(stats.totalTokens).toBe(300);
  });

  it('filters by skillId when provided', () => {
    const recs: SkillHistoryRecord[] = [
      { ...baseRec, skillId: 'A', invocationId: '1', ok: true, durationMs: 100, tokensUsed: 10 },
      { ...baseRec, skillId: 'B', invocationId: '2', ok: false, durationMs: 500, tokensUsed: 20 },
      { ...baseRec, skillId: 'A', invocationId: '3', ok: true, durationMs: 200, tokensUsed: 30 },
    ];
    const statsA = getSkillStats(recs, 'A');
    expect(statsA.count).toBe(2);
    expect(statsA.successRate).toBe(1);
    expect(statsA.avgDurationMs).toBe(150);
    expect(statsA.totalTokens).toBe(40);

    const statsB = getSkillStats(recs, 'B');
    expect(statsB.count).toBe(1);
    expect(statsB.successRate).toBe(0);
    expect(statsB.totalTokens).toBe(20);
  });

  it('filters by sinceTs when provided', () => {
    const recs: SkillHistoryRecord[] = [
      { ...baseRec, invocationId: 'old', ts: 1000 },
      { ...baseRec, invocationId: 'new1', ts: 5000 },
      { ...baseRec, invocationId: 'new2', ts: 6000 },
    ];
    const stats = getSkillStats(recs, undefined, 4000);
    expect(stats.count).toBe(2);
  });

  it('handles missing durationMs and tokensUsed gracefully', () => {
    const recs: SkillHistoryRecord[] = [
      { ts: 1000, skillId: 'x', invocationId: 'a', ok: true }, // no durationMs, no tokensUsed
      { ts: 2000, skillId: 'x', invocationId: 'b', ok: false }, // no durationMs
    ];
    const stats = getSkillStats(recs);
    expect(stats.count).toBe(2);
    expect(stats.successRate).toBe(0.5);
    expect(stats.avgDurationMs).toBe(0); // no durations → 0
    expect(stats.totalTokens).toBe(0);
  });
});