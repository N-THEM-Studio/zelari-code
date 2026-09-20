/**
 * WS7 slice 2 (t140) — REPLAY IS READ-ONLY.
 *
 * The whole slice claims that a spine can be re-read with pure projections and
 * NO side effect: `zelari-code replay` must not append to the log it reads, must
 * not create a cache / state file, must not touch the network. This test proves
 * it on a spine written by the REAL writer and closed (test (a)+(e) of the
 * slice: no static fixtures exist for the session package — the tests build
 * spines with SessionLogWriter, which is the real thing),
 *
 * and pins the two projection fields the command renders from it: the per-tool
 * tally and the verify-debt pairs.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLogWriter } from './writer.js';
import { buildProjection, readSessionLog } from './replay.js';
import { openVerifyDebts, projectVerifyDebts } from './verifyDebt.js';
import type { SessionEventInput } from './types.js';

const TS = 1755000000000;

async function closedSpine(): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-replay-ro-'));
  let tick = 0;
  const writer = await SessionLogWriter.open(dir, 'ro-session', 1, { now: () => TS + (tick += 1) });
  const events: SessionEventInput[] = [
    { kind: 'session.started', actor: { type: 'system' } },
    { kind: 'user.message', actor: { type: 'user' }, data: { text: 'read every file' } },
    { kind: 'tool.call', actor: { type: 'agent' }, data: { callId: 'c1', tool: 'read_file', args: { path: 'a.ts' } } },
    { kind: 'tool.result', actor: { type: 'tool' }, data: { callId: 'c1', tool: 'read_file', ok: true, output: 'x' } },
    { kind: 'tool.call', actor: { type: 'agent' }, data: { callId: 'c2', tool: 'read_file', args: { path: 'b.ts' } } },
    { kind: 'tool.result', actor: { type: 'tool' }, data: { callId: 'c2', tool: 'read_file', ok: true, output: 'y' } },
    { kind: 'tool.call', actor: { type: 'agent' }, data: { callId: 'c3', tool: 'bash', args: { command: 'ls' } } },
    { kind: 'permission.asked', actor: { type: 'system', role: 'permissions' }, data: { tool: 'bash', effect: 'ask' } },
    { kind: 'tool.result', actor: { type: 'tool' }, data: { callId: 'c3', tool: 'bash', ok: false, output: 'denied' } },
    { kind: 'verify.debt_open', actor: { type: 'system' }, data: { taskId: 't-bridge', description: 'wire the bridge', detail: 'general tentacle finished unverified' } },
    { kind: 'verify.debt_open', actor: { type: 'system' }, data: { taskId: 't-docs', description: 'update the docs' } },
    { kind: 'verify.debt_cleared', actor: { type: 'system' }, data: { taskId: 't-bridge' } },
    { kind: 'verify.requested', actor: { type: 'system', role: 'strict-done' }, data: { taskId: 't-docs', criterionIds: ['typecheck'] } },
    { kind: 'session.ended', actor: { type: 'system' }, data: { reason: 'completed' } },
  ];
  try {
    for (const e of events) await writer.append(e);
  } finally {
    await writer.close();
  }
  return { dir, file: writer.path };
}

describe('replay is read-only', () => {
  it('re-reads a closed spine twice with identical results and leaves it byte-identical', async () => {
    const { dir, file } = await closedSpine();
    const beforeBytes = await fs.readFile(file);
    const beforeStat = await fs.stat(file);
    const beforeListing = (await fs.readdir(dir)).sort();

    const first = await readSessionLog(file);
    const second = await readSessionLog(file);
    const projectionA = buildProjection(first.events, first.issues);
    const projectionB = buildProjection(second.events, second.issues);

    // Deterministic: the same log yields the same projection.
    expect(projectionB).toEqual(projectionA);
    expect(first.issues).toEqual([]);

    // Tool calls + the per-tool tally.
    expect(projectionA.toolCalls).toBe(3);
    expect(projectionA.toolResults).toBe(3);
    expect(projectionA.toolCallBreakdown).toEqual([
      { tool: 'read_file', calls: 2, results: 2 },
      { tool: 'bash', calls: 1, results: 1 },
    ]);
    expect(projectionA.interruptedTools).toEqual([]);

    // Verify debt: one open, one cleared.
    expect(projectionA.verifyDebts.map((d) => [d.taskId, d.clearedSeq])).toEqual([
      ['t-bridge', 12],
      ['t-docs', undefined],
    ]);
    expect(openVerifyDebts(projectionA.verifyDebts).map((d) => d.taskId)).toEqual(['t-docs']);

    // Decision events: the ask plus the verify request.
    expect(projectionA.decisionEvents.map((d) => d.kind)).toEqual(['permission.asked', 'verify.requested']);

    // NOTHING was written: same bytes, same mtime, same directory listing.
    const afterBytes = await fs.readFile(file);
    const afterStat = await fs.stat(file);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.size).toBe(beforeStat.size);
    expect((await fs.readdir(dir)).sort()).toEqual(beforeListing);
    // …and no cache/state file appeared next to the log either.
    expect((await fs.readdir(dir)).filter((n) => n !== 'events.jsonl')).toEqual([]);
  });
});

describe('projectVerifyDebts', () => {
  it('pairs open → clear, keeps re-opened slots open, ignores orphans and empty ids', () => {
    const e = (seq: number, kind: SessionEventInput['kind'], data: Record<string, unknown>) => ({
      schemaVersion: 1 as const,
      sessionId: 's',
      seq,
      ts: TS + seq,
      kind,
      actor: { type: 'system' as const },
      data,
    });
    const debts = projectVerifyDebts([
      e(1, 'verify.debt_open', { taskId: 'a', description: 'first' }),
      e(2, 'verify.debt_cleared', { taskId: 'a' }),
      e(3, 'verify.debt_open', { taskId: 'a', description: 'again', detail: 'round 2' }),
      e(4, 'verify.debt_cleared', { taskId: 'ghost' }), // orphan: ignored
      e(5, 'verify.debt_open', { taskId: '', description: 'unpairable' }), // no id: skipped
      e(6, 'verify.debt_open', { taskId: 'b' }),
      e(7, 'verify.debt_cleared', { taskId: 'b' }),
      e(8, 'verify.debt_cleared', { taskId: 'b' }), // second clear: first one wins
    ]);
    expect(debts.map((d) => ({ ...d }))).toEqual([
      { taskId: 'a', description: 'again', detail: 'round 2', openedSeq: 3, openedAt: TS + 3 },
      { taskId: 'b', description: '', openedSeq: 6, openedAt: TS + 6, clearedSeq: 7, clearedAt: TS + 7 },
    ]);
    expect(openVerifyDebts(debts).map((d) => d.taskId)).toEqual(['a']);
  });
});
