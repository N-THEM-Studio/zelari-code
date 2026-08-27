/**
 * reputationStore tests — t29 (§15–16). Locks:
 *  - path resolution: `<cwd>/.zelari/reputation.jsonl` default, whole-path
 *    env override via ZELARI_REPUTATION_PATH;
 *  - roundtrip: appendRecord → loadRecords preserves records in order;
 *  - tolerant replay: malformed / truncated / foreign lines are skipped,
 *    a missing store loads as [], loadRecords NEVER throws;
 *  - prune: keeps the NEWEST maxRecords (ts asc, later line wins ties),
 *    no-op within cap, returns the post-prune count.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendRecord,
  DEFAULT_MAX_RECORDS,
  loadRecords,
  parseRecordLine,
  pruneStore,
  REPUTATION_STORE_ENV,
  resolveReputationStorePath,
} from './reputationStore.js';
import type { ReputationRecord } from './modelReputation.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'zelari-repstore-'));

afterEach(() => {
  rmSync(path.join(TMP, 'case'), { recursive: true, force: true });
});

function rec(over: Partial<ReputationRecord> = {}): ReputationRecord {
  const outcome = over.outcome ?? 'verified';
  const base: ReputationRecord = {
    ts: 1_000,
    repo: 'zelari-code',
    model: 'm',
    provider: null,
    role: 'verify',
    language: null,
    outcome,
    firstPass: outcome === 'verified',
    repairCount: 0,
    costUsd: null,
    latencyMs: null,
  };
  return { ...base, ...over, outcome };
}

describe('resolveReputationStorePath', () => {
  it('derives .zelari/reputation.jsonl from the given cwd', () => {
    expect(resolveReputationStorePath('/ws', {})).toBe(path.join('/ws', '.zelari', 'reputation.jsonl'));
  });

  it(`honors the ${REPUTATION_STORE_ENV} override verbatim`, () => {
    expect(resolveReputationStorePath('/ws', { [REPUTATION_STORE_ENV]: '/custom/rep.jsonl' })).toBe(
      '/custom/rep.jsonl',
    );
  });

  it('ignores a blank override', () => {
    expect(resolveReputationStorePath('/ws', { [REPUTATION_STORE_ENV]: '   ' })).toBe(
      path.join('/ws', '.zelari', 'reputation.jsonl'),
    );
  });
});

describe('appendRecord + loadRecords roundtrip', () => {
  it('appends one JSON line per record and reads them back in order', async () => {
    const store = path.join(TMP, 'case', 'roundtrip', 'reputation.jsonl'); // parents don't exist yet
    await appendRecord(store, rec({ ts: 1, model: 'a', outcome: 'verified' }));
    await appendRecord(store, rec({ ts: 2, model: 'b', outcome: 'failed', firstPass: false, repairCount: 1 }));
    expect(existsSync(store)).toBe(true);
    const loaded = await loadRecords(store);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.model).toBe('a');
    expect(loaded[1]!.model).toBe('b');
    expect(loaded[1]!.outcome).toBe('failed');
    expect(loaded[1]!.repairCount).toBe(1);
  });
});

describe('tolerant replay', () => {
  it('loads a missing store as []', async () => {
    expect(await loadRecords(path.join(TMP, 'does-not-exist.jsonl'))).toEqual([]);
  });

  it('skips malformed lines without throwing', async () => {
    const store = path.join(TMP, 'case', 'tolerant.jsonl');
    const garbage = [
      'not json at all',
      '{"ts": 2, "repo": "half-writ', // truncated JSON
      '{"repo": "no-ts", "role": "verify", "outcome": "verified", "firstPass": true, "repairCount": 0}', // missing ts
      JSON.stringify({ ts: 3, repo: 'bad-outcome', role: 'verify', outcome: 'exploded', firstPass: true, repairCount: 0 }),
      '',
    ].join('\n');
    mkdirSync(path.dirname(store), { recursive: true });
    writeFileSync(store, garbage + '\n', 'utf8');
    await appendRecord(store, rec({ ts: 1, model: 'good-1' }));
    await appendRecord(store, rec({ ts: 4, model: 'good-2' }));
    const loaded = await loadRecords(store);
    expect(loaded.map((r) => r.model)).toEqual(['good-1', 'good-2']);
  });
});

describe('parseRecordLine', () => {
  it('accepts null-able optional fields and rejects wrong types', () => {
    const ok = parseRecordLine(JSON.stringify(rec({ model: null, costUsd: null, latencyMs: null })));
    expect(ok?.model).toBeNull();
    expect(parseRecordLine(JSON.stringify({ ...rec(), repairCount: -1 }))).toBeNull();
    expect(parseRecordLine(JSON.stringify({ ...rec(), ts: 'oops' }))).toBeNull();
    expect(parseRecordLine('[]')).toBeNull();
  });
});

describe('pruneStore', () => {
  it('keeps the newest maxRecords records (ts desc, later line wins ties)', async () => {
    const store = path.join(TMP, 'case', 'prune.jsonl');
    for (const r of [
      rec({ ts: 10, model: 'old-1' }),
      rec({ ts: 30, model: 'new-30' }),
      rec({ ts: 20, model: 'mid' }),
      rec({ ts: 40, model: 'new-40' }),
      rec({ ts: 40, model: 'new-40-later-line' }),
    ]) {
      await appendRecord(store, r);
    }
    const kept = await pruneStore(store, 3);
    expect(kept).toBe(3);
    const loaded = await loadRecords(store);
    expect(loaded.map((r) => r.model)).toEqual(['new-30', 'new-40', 'new-40-later-line']);
  });

  it('is a no-op within cap and reports the store size', async () => {
    const store = path.join(TMP, 'case', 'within-cap.jsonl');
    await appendRecord(store, rec({ ts: 1 }));
    await appendRecord(store, rec({ ts: 2 }));
    expect(await pruneStore(store, DEFAULT_MAX_RECORDS)).toBe(2);
    const after = await loadRecords(store);
    expect(after).toHaveLength(2);
    expect(await pruneStore(path.join(TMP, 'missing.jsonl'))).toBe(0);
  });
});
