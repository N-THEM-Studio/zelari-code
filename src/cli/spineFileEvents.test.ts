/**
 * spineFileEvents.test.ts — ADR-0033 (t75): pure derivation of compact
 * file-lifecycle spine events from tool result payloads.
 *
 * Covered: read → file.read, edit ok → file.applied, edit reject (structured
 * + prose) → file.rejected, non-file tools → nothing, unparsable payloads →
 * nothing (never a crash).
 */
import { describe, expect, it } from 'vitest';
import { deriveFileEvents } from './spineFileEvents.js';

const READ_OK = {
  path: '/repo/src/a.ts',
  content: 'export const a = 1;\n',
  totalLines: 1,
  readLines: { start: 0, end: 0 },
  sizeBytes: 20,
  snapshotId: 'abcd1234abcd1234',
};

const EDIT_OK = {
  path: '/repo/src/a.ts',
  applied: true,
  occurrencesReplaced: 2,
  snapshotId: 'eeee5678eeee5678',
  bytesWritten: 21,
};

describe('deriveFileEvents', () => {
  it('read_file ok (JSON string channel) → file.read with path + snapshotId', () => {
    const events = deriveFileEvents('read_file', JSON.stringify(READ_OK, null, 2));
    expect(events).toEqual([
      { kind: 'file.read', data: { path: '/repo/src/a.ts', snapshotId: 'abcd1234abcd1234' } },
    ]);
  });

  it('read_file ok (object channel) → file.read', () => {
    expect(deriveFileEvents('read_file', READ_OK)).toEqual([
      { kind: 'file.read', data: { path: '/repo/src/a.ts', snapshotId: 'abcd1234abcd1234' } },
    ]);
  });

  it('edit ok → file.applied with occurrencesReplaced + snapshotId', () => {
    expect(deriveFileEvents('edit', JSON.stringify(EDIT_OK))).toEqual([
      {
        kind: 'file.applied',
        data: { path: '/repo/src/a.ts', snapshotId: 'eeee5678eeee5678', occurrencesReplaced: 2 },
      },
    ]);
  });

  it('edit reject (TypedResult with meta.reject) → file.rejected with path + status, NO minimalDiff', () => {
    const rejectPayload = {
      ok: false,
      error: 'edit: hunk_mismatch: /repo/src/a.ts (oldString not found — no relocation attempted)',
      meta: {
        status: 'failed',
        warnings: ['HUNK_MISMATCH'],
        reject: {
          ok: false,
          status: 'hunk_mismatch',
          path: '/repo/src/a.ts',
          minimalDiff: '--- a\n+++ a\n-sentinel-noise',
          next: { action: 're-read', path: '/repo/src/a.ts' },
        },
      },
    };
    const events = deriveFileEvents('edit', rejectPayload);
    expect(events).toEqual([
      { kind: 'file.rejected', data: { path: '/repo/src/a.ts', status: 'hunk_mismatch' } },
    ]);
    // The spine event stays compact: the diff never leaks into data.
    expect(JSON.stringify(events)).not.toContain('sentinel-noise');
  });

  it('edit reject (prose channel — harness stringifies rejects as the error message) → file.rejected', () => {
    const prose =
      'edit: stale_snapshot: /repo/src/b.ts (expected aaaabbbb11112222, actual ccccdddd33334444)' +
      '\nstatus=failed warnings=STALE_SNAPSHOT';
    expect(deriveFileEvents('edit', prose)).toEqual([
      { kind: 'file.rejected', data: { path: '/repo/src/b.ts', status: 'stale_snapshot' } },
    ]);
  });

  it('non-file tool → no events (even with file-ish payloads)', () => {
    expect(deriveFileEvents('bash', JSON.stringify(READ_OK))).toEqual([]);
    expect(deriveFileEvents('grep_content', JSON.stringify(EDIT_OK))).toEqual([]);
    expect(deriveFileEvents(undefined, JSON.stringify(EDIT_OK))).toEqual([]);
  });

  it('unparsable payload → no events, no crash (prose for read_file, garbage JSON, non-objects)', () => {
    expect(deriveFileEvents('read_file', 'totally not json {{{')).toEqual([]);
    expect(deriveFileEvents('edit', 'random failure without the prefix')).toEqual([]);
    expect(deriveFileEvents('write_file', '{"path": 42}')).toEqual([]);
    expect(deriveFileEvents('read_file', null)).toEqual([]);
    expect(deriveFileEvents('edit', ['not', 'an', 'object'])).toEqual([]);
  });

  it('write_file ok → file.applied {path} (created only when the payload exposes it)', () => {
    expect(deriveFileEvents('write_file', JSON.stringify({ path: '/repo/new.ts', bytesWritten: 5 }))).toEqual([
      { kind: 'file.applied', data: { path: '/repo/new.ts' } },
    ]);
    expect(
      deriveFileEvents('write_file', { path: '/repo/new.ts', bytesWritten: 5, created: true }),
    ).toEqual([{ kind: 'file.applied', data: { path: '/repo/new.ts', created: true } }]);
    // A write_file REJECT payload (error prose) derives nothing (spec t75:
    // only edit rejects map to file.rejected).
    expect(
      deriveFileEvents('write_file', 'write_file: /repo/x.ts already exists (FILE_EXISTS).'),
    ).toEqual([]);
  });
});
