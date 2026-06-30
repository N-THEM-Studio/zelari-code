/**
 * cli-councilFeedback.test.ts — Task I.4 (v3-I)
 *
 * Tests for `FeedbackStore` — the persistent JSON-on-disk store
 * backing `/council-feedback` slash command and the optional
 * `feedbackStore` field on `PureCouncilConfig`.
 *
 * Coverage:
 *   - record() accepts valid input
 *   - record() throws on missing memberId
 *   - record() throws on out-of-range / non-integer score
 *   - getStats() returns defaults for unknown members
 *   - getStats() computes correct avg over multiple entries
 *   - getEntries() returns newest-first
 *   - ranked() sorts by avg desc, ties by count desc, then id asc
 *   - ranked() places unknown members at the end (id asc)
 *   - clear() removes a single member or all
 *   - persistence: write → reload preserves entries
 *   - persistence: corrupt file is recovered gracefully
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FeedbackStore } from '../../src/cli/councilFeedback';

describe('FeedbackStore', () => {
  let dir: string;
  let file: string;
  let now: () => number;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'feedback-test-'));
    file = path.join(dir, 'feedback.json');
    let counter = 1_700_000_000_000;
    now = () => counter++;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('record() accepts valid input (Task I.4.1)', () => {
    const s = new FeedbackStore({ file, now });
    const entry = s.record({ memberId: 'sisyphus', score: 4, note: 'good' });
    expect(entry.memberId).toBe('sisyphus');
    expect(entry.score).toBe(4);
    expect(entry.note).toBe('good');
    expect(entry.ts).toBeGreaterThan(0);
  });

  it('record() throws on empty memberId (Task I.4.2)', () => {
    const s = new FeedbackStore({ file, now });
    expect(() => s.record({ memberId: '', score: 3 })).toThrow(/memberId is required/);
    expect(() => s.record({ memberId: '   ', score: 3 })).toThrow(/memberId is required/);
  });

  it('record() throws on out-of-range or non-integer score (Task I.4.3)', () => {
    const s = new FeedbackStore({ file, now });
    expect(() => s.record({ memberId: 'a', score: 0 })).toThrow(/integer in \[1,5\]/);
    expect(() => s.record({ memberId: 'a', score: 6 })).toThrow(/integer in \[1,5\]/);
    expect(() => s.record({ memberId: 'a', score: 3.5 })).toThrow(/integer in \[1,5\]/);
    expect(() => s.record({ memberId: 'a', score: NaN })).toThrow(/integer in \[1,5\]/);
  });

  it('getStats() returns defaults for unknown members (Task I.4.4)', () => {
    const s = new FeedbackStore({ file, now });
    const stats = s.getStats('nonexistent');
    expect(stats).toEqual({ memberId: 'nonexistent', count: 0, avg: 0, lastTs: 0 });
  });

  it('getStats() computes avg + count + lastTs correctly (Task I.4.5)', () => {
    const s = new FeedbackStore({ file, now });
    s.record({ memberId: 'sisyphus', score: 4, ts: 1 });
    s.record({ memberId: 'sisyphus', score: 5, ts: 2 });
    s.record({ memberId: 'sisyphus', score: 3, ts: 5 });
    const stats = s.getStats('sisyphus');
    expect(stats.count).toBe(3);
    expect(stats.avg).toBeCloseTo(4.0);
    expect(stats.lastTs).toBe(5);
  });

  it('getEntries() returns newest-first (Task I.4.6)', () => {
    const s = new FeedbackStore({ file, now });
    s.record({ memberId: 'a', score: 1, ts: 100 });
    s.record({ memberId: 'a', score: 5, ts: 300 });
    s.record({ memberId: 'a', score: 3, ts: 200 });
    const entries = s.getEntries('a');
    expect(entries.map((e) => e.ts)).toEqual([300, 200, 100]);
    expect(entries.map((e) => e.score)).toEqual([5, 3, 1]);
  });

  it('ranked() sorts by avg desc, ties by count desc, then id asc (Task I.4.7)', () => {
    const s = new FeedbackStore({ file, now });
    s.record({ memberId: 'b', score: 5, ts: 1 });   // avg=5, count=1
    s.record({ memberId: 'a', score: 4, ts: 1 });   // avg=4, count=1
    s.record({ memberId: 'a', score: 4, ts: 2 });   // avg=4, count=2
    s.record({ memberId: 'a', score: 4, ts: 3 });   // avg=4, count=3
    s.record({ memberId: 'c', score: 4, ts: 1 });   // avg=4, count=1
    const items = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const ranked = s.ranked(items);
    // b: avg=5 → first.
    // a: avg=4, count=3 → second.
    // c: avg=4, count=1 → third (a wins on count tie).
    expect(ranked.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('ranked() places unknown members at the end sorted by id asc (Task I.4.8)', () => {
    const s = new FeedbackStore({ file, now });
    s.record({ memberId: 'b', score: 5, ts: 1 });
    const items = [
      { id: 'z' },
      { id: 'a' },
      { id: 'b' },
      { id: 'm' },
    ];
    const ranked = s.ranked(items);
    expect(ranked[0].id).toBe('b');
    // Unknown: a, m, z (id asc).
    expect(ranked.slice(1).map((r) => r.id)).toEqual(['a', 'm', 'z']);
  });

  it('clear() removes a single member or all entries (Task I.4.9)', () => {
    const s = new FeedbackStore({ file, now });
    s.record({ memberId: 'a', score: 1, ts: 1 });
    s.record({ memberId: 'b', score: 2, ts: 2 });
    s.record({ memberId: 'a', score: 3, ts: 3 });
    const removedA = s.clear('a');
    expect(removedA).toBe(2);
    expect(s.getStats('a').count).toBe(0);
    expect(s.getStats('b').count).toBe(1);
    const removedAll = s.clear();
    expect(removedAll).toBe(1);
    expect(s.getStats('b').count).toBe(0);
  });

  it('persistence: write → reload preserves entries (Task I.4.10)', () => {
    const s1 = new FeedbackStore({ file, now });
    s1.record({ memberId: 'a', score: 5, ts: 1 });
    s1.record({ memberId: 'b', score: 3, ts: 2 });
    // Construct a new store pointing at the same file.
    const s2 = new FeedbackStore({ file });
    expect(s2.getStats('a')).toEqual({ memberId: 'a', count: 1, avg: 5, lastTs: 1 });
    expect(s2.getStats('b')).toEqual({ memberId: 'b', count: 1, avg: 3, lastTs: 2 });
  });

  it('persistence: corrupt file is recovered gracefully (Task I.4.11)', () => {
    writeFileSync(file, 'not valid json {');
    const s = new FeedbackStore({ file });
    expect(s.listAll()).toEqual([]);
    // And we can still record after recovery.
    s.record({ memberId: 'a', score: 4 });
    expect(s.getStats('a').count).toBe(1);
  });
});
