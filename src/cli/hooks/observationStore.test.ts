/**
 * observationStore + retrieve_observation — Fase 2 acceptance.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionJsonlWriter } from '@zelari/core/harness';
import { createBrainEvent } from '@zelari/core/events';
import {
  getObservationBySeq,
  getSeqForToolCallId,
  indexEventsForTests,
  ingestLiveEvent,
  invalidateObservationIndex,
  loadObservationIndex,
} from './observationStore.js';
import { formatObservationStub } from './sessionSurface.js';
import { createRetrieveObservationTool, parseSeqRef } from '../tools/retrieveObservation.js';

const abort = new AbortController().signal;

function ctx(sessionId: string) {
  return {
    signal: abort,
    cwd: process.cwd(),
    sessionId,
    audit: () => undefined,
  };
}

describe('parseSeqRef', () => {
  it('accepts number, #N and ref=#N', () => {
    expect(parseSeqRef(12)).toBe(12);
    expect(parseSeqRef('#12')).toBe(12);
    expect(parseSeqRef('ref=#12')).toBe(12);
    expect(parseSeqRef('OBSERVATION ref=#3')).toBe(3);
    expect(parseSeqRef('nope')).toBeNull();
    expect(parseSeqRef(0)).toBeNull();
  });
});

describe('observationStore from JSONL', () => {
  let dir: string;

  afterEach(async () => {
    invalidateObservationIndex();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('assigns monotonic 1-based seq in file order and rematerializes', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-obs-'));
    const sid = 'sess-a';
    const w = new SessionJsonlWriter(sid, { baseDir: dir, flushIntervalMs: 60_000 });
    const start1 = createBrainEvent('tool_execution_start', sid, {
      toolCallId: 'c1',
      toolName: 'read_file',
      args: { path: 'a.ts' },
    });
    const end1 = createBrainEvent('tool_execution_end', sid, {
      toolCallId: 'c1',
      result: 'FILE-ONE-BODY',
      isError: false,
      durationMs: 11,
    });
    const start2 = createBrainEvent('tool_execution_start', sid, {
      toolCallId: 'c2',
      toolName: 'grep_content',
      args: { pattern: 'x' },
    });
    const end2 = createBrainEvent('tool_execution_end', sid, {
      toolCallId: 'c2',
      result: 'FILE-TWO-BODY',
      isError: false,
      durationMs: 22,
    });
    void w.append(start1);
    void w.append(end1);
    void w.append(start2);
    void w.append(end2);
    await w.flush();

    const index = await loadObservationIndex(sid, dir);
    expect(index.bySeq.size).toBe(2);
    expect(await getSeqForToolCallId(sid, 'c2', dir)).toBe(2);
    const rec = await getObservationBySeq(sid, 1, dir);
    expect(rec?.result).toBe('FILE-ONE-BODY');
    expect(rec?.toolName).toBe('read_file');

    const tool = createRetrieveObservationTool({ sessionId: sid, baseDir: dir });
    const hit = await tool.execute({ seq: '#2' }, ctx(sid));
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.value.result).toBe('FILE-TWO-BODY');
      expect(hit.value.tool).toBe('grep_content');
      expect(hit.value.seq).toBe(2);
    }
    const miss = await tool.execute({ seq: 99 }, ctx(sid));
    expect(miss.ok).toBe(false);

    await w.close();
  });

  it('ingestLiveEvent is idempotent and retrieve works before flush', async () => {
    const sid = 'live-sess';
    const start = createBrainEvent('tool_execution_start', sid, {
      toolCallId: 'live-1',
      toolName: 'list_files',
      args: {},
    });
    const end = createBrainEvent('tool_execution_end', sid, {
      toolCallId: 'live-1',
      result: 'LIVE-BODY',
      isError: false,
      durationMs: 5,
    });
    ingestLiveEvent(sid, start);
    ingestLiveEvent(sid, end);
    ingestLiveEvent(sid, end); // idempotent
    const rec = await getObservationBySeq(sid, 1);
    expect(rec?.result).toBe('LIVE-BODY');
    expect(await getSeqForToolCallId(sid, 'live-1')).toBe(1);
  });

  it('refuses to rematerialize a stub that leaked into the log', async () => {
    const sid = 'stub-sess';
    const stub = formatObservationStub({ seq: 1, tool: 'read_file', bytes: 10 });
    indexEventsForTests(sid, [
      createBrainEvent('tool_execution_end', sid, {
        toolCallId: 's1',
        result: stub,
        isError: false,
        durationMs: 1,
      }),
    ]);
    const tool = createRetrieveObservationTool({ sessionId: sid, baseDir: os.tmpdir() });
    const res = await tool.execute({ seq: 1 }, ctx(sid));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.meta?.warnings).toContain('STUB_IN_LOG');
  });
});

describe('retrieve_observation session guard', () => {
  it('fails clearly without a real session id', async () => {
    const tool = createRetrieveObservationTool();
    const res = await tool.execute({ seq: 1 }, ctx('cli'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.meta?.warnings).toContain('NO_SESSION');
  });
});
