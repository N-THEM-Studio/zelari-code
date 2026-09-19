/**
 * verdictFeed.test.ts — the `verdict` statusline item's projection (derive-only).
 *
 * Red-if-reopens: every assertion is about fields the spine events ACTUALLY
 * carry. If the derivation ever invents a denominator, a phase, or a PASS that
 * no `verification.run` recorded, these tests fail — that is the ADR-0023
 * "unknown ≠ pass" contract for a UI chip.
 *
 * Fixtures are written as REAL v1 envelopes (gap-free seq, parsed by the core
 * reader), never hand-parsed, so the disk path exercises the same reader the
 * TUI uses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deriveVerdictFeed,
  emptyVerdictFeed,
  readVerdictFeed,
  readVerdictFeedText,
  verdictFeedEnabled,
  verdictFeedText,
  verdictPhaseName,
  type VerdictEventLike,
} from './verdictFeed.js';

const SID = 's-verdict';
const BASE_TS = 1_755_000_000_000;

let dir: string;
let sessionsDir: string;

const envelope = (seq: number, kind: string, data: Record<string, unknown>): string =>
  JSON.stringify({
    schemaVersion: 1,
    sessionId: SID,
    seq,
    ts: BASE_TS + seq * 1000,
    kind,
    actor: { type: 'system' },
    data,
  });

/** Write `<sessionsDir>/<sessionId>/events.jsonl` (raw lines, corrupt ones included). */
function writeSpine(sessionId: string, lines: readonly string[]): void {
  const target = path.join(sessionsDir, sessionId);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'events.jsonl'), `${lines.join('\n')}\n`, 'utf-8');
}

/** Pure event helper (no disk): the projection only needs kind/seq/ts/data. */
const ev = (seq: number, kind: string, data?: Record<string, unknown>): VerdictEventLike => ({
  kind,
  seq,
  ts: BASE_TS + seq * 1000,
  ...(data ? { data } : {}),
});

const evidence = (seq: number) => ev(seq, 'verification.evidence', { observation: 'command', command: 'npm test' });

/** A `verification.run` shaped like strictGateEventPayload's real output. */
const runRecord = (seq: number, extra: Record<string, unknown> = {}) =>
  ev(seq, 'verification.run', { engine: 'kraken-legacy+completion-policy', strict: true, ...extra });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zelari-verdict-'));
  sessionsDir = path.join(dir, '.zelari', 'sessions');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deriveVerdictFeed — partial (in-flight) run', () => {
  it('counts observations and reports NO verdict before any run record exists', () => {
    const feed = deriveVerdictFeed([evidence(1), evidence(2), evidence(3)]);
    expect(feed.seq).toBeNull();
    expect(feed.ready).toBeNull(); // a record-less run is unknown, never pass
    expect(feed.verdict).toBeNull();
    expect(feed.observations).toBe(3);
    expect(feed.total).toBe(0);
    expect(feed.phases).toEqual([]);
    expect(verdictFeedText(feed)).toBe('verify… 3 obs');
  });

  it('drops the observations that belong to the run record that follows them', () => {
    const feed = deriveVerdictFeed([evidence(1), runRecord(2, { verdict: 'PASS' })]);
    expect(feed.observations).toBe(0);
    expect(feed.verdict).toBe('PASS');
  });
});

describe('deriveVerdictFeed — complete PASS with per-criterion pack evidence', () => {
  const complete = (): VerdictEventLike[] => [
    evidence(1),
    runRecord(2, {
      verdict: 'PASS',
      summary: 'all criteria satisfied',
      native: {
        packId: 'zelari-coding/v1',
        criteria: [
          { id: 'correctness.error-signals', required: true },
          { id: 'correctness.specification', required: true },
          { id: 'quality.scope-discipline', required: false },
        ],
        results: [
          { criterionId: 'correctness.error-signals', status: 'pass' },
          { criterionId: 'correctness.specification', status: 'pass' },
          { criterionId: 'quality.scope-discipline', status: 'pass' },
        ],
      },
      evidence: { satisfied: ['correctness.error-signals'], unsatisfied: [], complete: true },
    }),
  ];

  it('becomes ready only on a recorded PASS, with counts taken from the record', () => {
    const feed = deriveVerdictFeed(complete());
    expect(feed.ready).toBe(true);
    expect(feed.verdict).toBe('PASS');
    expect(feed.strict).toBe(true);
    expect(feed.passed).toBe(3);
    expect(feed.total).toBe(3);
    expect(feed.summary).toBe('all criteria satisfied');
    expect(feed.seq).toBe(2);
    expect(verdictFeedText(feed)).toBe('PASS 3/3 · checks');
  });

  it('groups criteria into phases by id prefix, in first-seen order', () => {
    expect(deriveVerdictFeed(complete()).phases).toEqual([
      { name: 'correctness', passed: 2, total: 2, status: 'pass' },
      { name: 'quality', passed: 1, total: 1, status: 'pass' },
    ]);
  });

  it('lists a criterion with no result as unknown — never as a pass', () => {
    const feed = deriveVerdictFeed([
      runRecord(1, {
        verdict: 'PASS',
        native: {
          criteria: [{ id: 'correctness.error-signals' }, { id: 'evidence.verification-quality' }],
          results: [{ criterionId: 'correctness.error-signals', status: 'pass' }],
        },
      }),
    ]);
    expect(feed.total).toBe(2);
    expect(feed.passed).toBe(1);
    expect(feed.phases).toEqual([
      { name: 'correctness', passed: 1, total: 1, status: 'pass' },
      { name: 'evidence', passed: 0, total: 1, status: 'unknown' },
    ]);
  });
});

describe('deriveVerdictFeed — complete FAIL (blocked / repair)', () => {
  it('BLOCKED: not ready, failed phase marked fail, counts exact', () => {
    const feed = deriveVerdictFeed([
      runRecord(1, {
        verdict: 'BLOCKED',
        evidence: {
          satisfied: ['correctness.error-signals'],
          unsatisfied: [
            { id: 'correctness.specification', status: 'fail', reason: '3 tests failed' },
            { id: 'evidence.verification-quality', status: 'unknown', reason: '' },
          ],
          complete: false,
        },
      }),
    ]);
    expect(feed.ready).toBe(false);
    expect(feed.verdict).toBe('BLOCKED');
    expect(feed.passed).toBe(1);
    expect(feed.total).toBe(3);
    expect(feed.phases).toEqual([
      { name: 'correctness', passed: 1, total: 2, status: 'fail' },
      { name: 'evidence', passed: 0, total: 1, status: 'unknown' },
    ]);
    expect(verdictFeedText(feed)).toBe('BLOCKED 1/3 · checks');
  });

  it('REPAIR_REQUIRED renders its own word (no PASS, no FAIL collapse)', () => {
    const feed = deriveVerdictFeed([runRecord(1, { verdict: 'REPAIR_REQUIRED' })]);
    expect(feed.ready).toBe(false);
    expect(verdictFeedText(feed)).toBe('REPAIR'); // nothing recorded a denominator
  });

  it('an unrecognized verdict stays unknown — ready is null, no word is invented', () => {
    const feed = deriveVerdictFeed([runRecord(1, { verdict: 'MAYBE' })]);
    expect(feed.verdict).toBe('unknown');
    expect(feed.ready).toBeNull();
    expect(verdictFeedText(feed)).toBeNull();
  });
});

describe('deriveVerdictFeed — counts and edge cases', () => {
  it('falls back to the legacy counters when the record carries no criterion ids', () => {
    const feed = deriveVerdictFeed([
      runRecord(1, { verdict: 'BLOCKED', legacy: { total: 5, passed: 2, failed: 1, unknown: 2 } }),
    ]);
    expect(feed.passed).toBe(2);
    expect(feed.total).toBe(5);
    expect(feed.phases).toEqual([]); // no ids recorded ⇒ no phase invented
    expect(verdictFeedText(feed)).toBe('BLOCKED 2/5 · checks');
  });

  it('reads the deterministic engine payload (flat results, no criteria block)', () => {
    const feed = deriveVerdictFeed([
      ev(1, 'verification.run', {
        verdict: 'PASS',
        results: [
          { criterionId: 'correctness.specification', status: 'pass' },
          { criterionId: 'quality.scope-discipline', status: 'unknown' },
        ],
      }),
    ]);
    expect(feed.strict).toBe(false); // the engine payload records no `strict` flag
    expect(feed.total).toBe(2);
    expect(feed.passed).toBe(1);
  });

  it('the LAST record wins, and only evidence after it is in flight', () => {
    const feed = deriveVerdictFeed([
      runRecord(1, { verdict: 'BLOCKED' }),
      evidence(2),
      runRecord(3, { verdict: 'PASS' }),
      evidence(4),
    ]);
    expect(feed.verdict).toBe('PASS');
    expect(feed.ready).toBe(true);
    expect(feed.observations).toBe(1);
    expect(feed.seq).toBe(3);
  });

  it('ignores unrelated kinds, malformed payloads and an empty log', () => {
    expect(deriveVerdictFeed([])).toEqual(emptyVerdictFeed());
    expect(deriveVerdictFeed([ev(1, 'user.message', { text: 'hi' }), ev(2, 'verification.run')])).toEqual(
      emptyVerdictFeed(),
    );
    // No record and nothing recorded ⇒ no chip at all (EMPTY ≠ absent).
    expect(verdictFeedText(deriveVerdictFeed([]))).toBeNull();
    expect(verdictFeedText(null)).toBeNull();
  });

  it('names phases from the first dot, keeping a prefix-less id intact', () => {
    expect(verdictPhaseName('correctness.error-signals')).toBe('correctness');
    expect(verdictPhaseName('eq-1')).toBe('eq-1');
  });
});

describe('verdictFeed kill switch — ZELARI_VERDICT_FEED=0', () => {
  const feed = () => deriveVerdictFeed([runRecord(1, { verdict: 'PASS', legacy: { total: 1, passed: 1 } })]);

  it('is ON by default and OFF only for the exact "0"', () => {
    expect(verdictFeedEnabled({})).toBe(true);
    expect(verdictFeedEnabled({ ZELARI_VERDICT_FEED: '1' })).toBe(true);
    expect(verdictFeedEnabled({ ZELARI_VERDICT_FEED: '0' })).toBe(false);
  });

  it('renders NOTHING (item hidden) and reads nothing from disk when disabled', () => {
    const env = { ZELARI_VERDICT_FEED: '0' };
    expect(verdictFeedText(feed(), env)).toBeNull();
    writeSpine(SID, [envelope(1, 'verification.run', { strict: true, verdict: 'PASS' })]);
    expect(readVerdictFeed({ sessionId: SID, sessionsDir, env })).toEqual(emptyVerdictFeed());
    expect(readVerdictFeedText({ sessionId: SID, sessionsDir, env })).toBeNull();
  });
});

describe('readVerdictFeed — the current run, read back from its spine', () => {
  it('derives the item text of the current session', () => {
    writeSpine(SID, [
      envelope(1, 'session.started', { profile: 'kraken/v1' }),
      envelope(2, 'verification.evidence', { observation: 'command', command: 'npm test' }),
      envelope(3, 'verification.evidence', { observation: 'command', command: 'npm run typecheck' }),
    ]);
    expect(readVerdictFeedText({ sessionId: SID, sessionsDir })).toBe('verify… 2 obs');

    writeSpine(SID, [
      envelope(1, 'session.started', { profile: 'kraken/v1' }),
      envelope(2, 'verification.evidence', { observation: 'command' }),
      envelope(3, 'verification.run', {
        strict: true,
        verdict: 'BLOCKED',
        legacy: { total: 4, passed: 1 },
        native: {
          criteria: [{ id: 'correctness.specification' }, { id: 'quality.scope-discipline' }],
          results: [{ criterionId: 'correctness.specification', status: 'fail' }],
        },
      }),
    ]);
    const feed = readVerdictFeed({ sessionId: SID, sessionsDir });
    expect(verdictFeedText(feed)).toBe('BLOCKED 0/2 · checks');
    expect(feed.phases).toEqual([
      { name: 'correctness', passed: 0, total: 1, status: 'fail' },
      { name: 'quality', passed: 0, total: 1, status: 'unknown' },
    ]);
  });

  it('is fail-soft: no marker, missing file, corrupt log and unreadable dir ⇒ empty feed', () => {
    expect(readVerdictFeed({ sessionsDir })).toEqual(emptyVerdictFeed()); // no current-session marker
    expect(readVerdictFeed({ sessionId: 'nope', sessionsDir })).toEqual(emptyVerdictFeed());
    writeSpine('corrupt', ['not json at all', '{"schemaVersion":1}']);
    expect(readVerdictFeed({ sessionId: 'corrupt', sessionsDir })).toEqual(emptyVerdictFeed());
    expect(readVerdictFeed({ sessionId: SID, sessionsDir: path.join(dir, 'missing') })).toEqual(emptyVerdictFeed());
  });
});
