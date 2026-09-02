/**
 * fileEvents.test.ts — ADR-0033 (t75) spine emission from the core write path.
 *
 * Locks the fixed wire contract:
 *   file.read     data = {path, snapshotId}
 *   file.applied  data = {path, snapshotId, bytes}
 *   file.rejected data = {path, reason, hint?}  reason = WriteReject.status
 *
 * Emission rides the optional ToolContext.emitSessionEvent seam, wired here to
 * a REAL SessionLogWriter so seq monotonicity, envelope validation and
 * tolerant replay are exercised end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editTool } from './edit.js';
import { readFileTool } from './filesystem.js';
import { SessionLogWriter } from '../../../session/writer.js';
import { readSessionLog, buildProjection } from '../../../session/replay.js';
import type { SessionEventEnvelope, SessionEventInput } from '../../../session/types.js';
import type { ToolContext } from '../toolTypes.js';

const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

let tmpRoot: string;
let writer: SessionLogWriter;
let ctx: ToolContext;

/** Plain ToolContext without the emitter (legacy hosts). */
function ctxWithoutEmitter(): ToolContext {
  return { cwd: tmpRoot, signal: new AbortController().signal, audit: () => {}, sessionId: 't' };
}

async function readEvents(): Promise<SessionEventEnvelope[]> {
  const report = await readSessionLog(writer.path);
  expect(report.issues).toEqual([]);
  return report.events;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-file-events-'));
  writer = await SessionLogWriter.open(path.join(tmpRoot, 'session'), 'file-events-test', 1);
  ctx = {
    cwd: tmpRoot,
    signal: new AbortController().signal,
    audit: () => {},
    sessionId: 'file-events-test',
    // Same wiring the CLI host performs where tool results already pass.
    emitSessionEvent: (input: SessionEventInput) => writer.append(input),
  };
});

afterEach(async () => {
  await writer.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('file.* spine emission (t75)', () => {
  it('read_file emits file.read and a successful edit emits file.applied — monotonic seq', async () => {
    const body = 'const a = 1;\nconst b = 2;\n';
    await fs.writeFile(path.join(tmpRoot, 'f.ts'), body);
    const r1 = await readFileTool.execute({ path: 'f.ts', maxBytes: 1_000_000 }, ctx);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const after = 'const a = 41;\nconst b = 2;\n';
    const r2 = await editTool.execute(
      { path: 'f.ts', oldString: 'const a = 1;', newString: 'const a = 41;', snapshotId: r1.value.snapshotId, replaceAll: false },
      ctx,
    );
    expect(r2.ok).toBe(true);
    const events = await readEvents();
    expect(events.map((e) => e.kind)).toEqual(['file.read', 'file.applied']);
    expect(events.map((e) => e.seq)).toEqual([1, 2]); // writer-assigned, gap-free
    const [read, applied] = events;
    expect(read?.data).toEqual({ path: path.join(tmpRoot, 'f.ts'), snapshotId: sha16(body) });
    expect(applied?.data).toEqual({
      path: path.join(tmpRoot, 'f.ts'),
      snapshotId: sha16(after),
      bytes: after.length,
    });
  });

  it('stale_snapshot edit emits file.rejected with reason + re-read hint, no file.applied', async () => {
    await fs.writeFile(path.join(tmpRoot, 's.txt'), 'original\n');
    const r1 = await readFileTool.execute({ path: 's.txt', maxBytes: 1_000_000 }, ctx);
    expect(r1.ok).toBe(true);
    const snap = r1.ok ? r1.value.snapshotId : '';
    await fs.writeFile(path.join(tmpRoot, 's.txt'), 'mutated by another tentacle\n');
    const r2 = await editTool.execute(
      { path: 's.txt', oldString: 'original', newString: 'x', snapshotId: snap, replaceAll: false },
      ctx,
    );
    expect(r2.ok).toBe(false);
    const events = await readEvents();
    expect(events.map((e) => e.kind)).toEqual(['file.read', 'file.rejected']);
    const rejected = events[1];
    expect(rejected?.data.path).toBe(path.join(tmpRoot, 's.txt'));
    expect(rejected?.data.reason).toBe('stale_snapshot');
    expect(String(rejected?.data.hint)).toContain('re-read');
  });

  it('hunk_mismatch edit emits file.rejected with reason hunk_mismatch', async () => {
    await fs.writeFile(path.join(tmpRoot, 'm.txt'), 'alpha one\nalpha two\n');
    const r1 = await readFileTool.execute({ path: 'm.txt', maxBytes: 1_000_000 }, ctx);
    expect(r1.ok).toBe(true);
    const snap = r1.ok ? r1.value.snapshotId : '';
    const r2 = await editTool.execute(
      { path: 'm.txt', oldString: 'alpha three', newString: 'x', snapshotId: snap, replaceAll: false },
      ctx,
    );
    expect(r2.ok).toBe(false);
    const events = await readEvents();
    expect(events.map((e) => e.kind)).toEqual(['file.read', 'file.rejected']);
    expect(events[1]?.data.reason).toBe('hunk_mismatch');
    expect(events[1]?.data.hint).toBeDefined();
  });

  it('hosts without the emitter run unchanged and emit nothing (backward compat)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'p.txt'), 'plain\n');
    const r = await editTool.execute(
      { path: 'p.txt', oldString: 'plain', newString: 'edited', snapshotId: sha16('plain\n'), replaceAll: false },
      ctxWithoutEmitter(),
    );
    expect(r.ok).toBe(true);
    expect((await readEvents()).map((e) => e.kind)).toEqual([]);
  });

  it('a failing spine never fails the tool (emission is best-effort)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'x.txt'), 'content\n');
    const failing: ToolContext = {
      ...ctxWithoutEmitter(),
      emitSessionEvent: () => Promise.reject(new Error('SESSION_LOG_LOCKED')),
    };
    const r = await editTool.execute(
      { path: 'x.txt', oldString: 'content', newString: 'changed', snapshotId: sha16('content\n'), replaceAll: false },
      failing,
    );
    expect(r.ok).toBe(true);
  });
});

describe('replay tolerance (ADR-0016) with real file.* events', () => {
  it('readSessionLog + buildProjection tolerate file.* — deriveMessages stays empty of them', async () => {
    await fs.writeFile(path.join(tmpRoot, 'r.txt'), 'one\n');
    await readFileTool.execute({ path: 'r.txt', maxBytes: 1_000_000 }, ctx);
    await editTool.execute(
      { path: 'r.txt', oldString: 'one', newString: 'uno', snapshotId: sha16('one\n'), replaceAll: false },
      ctx,
    );
    const report = await readSessionLog(writer.path);
    expect(report.ok).toBe(true);
    expect(report.events.map((e) => e.kind)).toEqual(['file.read', 'file.applied']);
    const projection = buildProjection(report.events);
    expect(projection.eventCount).toBe(2);
    expect(projection.lastSeq).toBe(2);
    expect(projection.issues).toEqual([]);
    // State-only kinds never surface as model messages.
    expect(projection.messages).toEqual([]);
  });
});
