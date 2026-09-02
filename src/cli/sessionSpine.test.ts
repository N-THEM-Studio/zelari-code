/**
 * sessionSpine tests — dual-write bridge onto the 2.0 session spine.
 *
 * Covers: BrainEvent→spine mapping, adopt/resume seq continuation, ownership
 * lock, message-delta coalescing, user.message logging (the P1 gap), the
 * declared-discrete-fallback degradation, and the kill switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SessionSpineMirror,
  mapBrainEventToSpine,
  resumeSpineContext,
  spineEnabled,
} from './sessionSpine.js';
import { readSessionLog, ACTOR_USER } from '@zelari/core/session';
import {
  TOOL_CALL_TRUNCATED_RECOVERY_USER,
  TEXT_TOOLS_FAILED_USER,
  TEXT_TOOLS_PARTIAL_USER,
} from '@zelari/core/harness';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-spine-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function ev(type: string, rest: Record<string, unknown> = {}) {
  return { type, id: `id-${type}`, ts: 1_755_000_000_000, sessionId: 's1', ...rest } as never;
}

describe('mapBrainEventToSpine', () => {
  it('maps tool_execution_start → tool.call with tool/args/callId', () => {
    const mapped = mapBrainEventToSpine(
      ev('tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }),
    );
    expect(mapped).not.toBeNull();
    expect(mapped!.kind).toBe('tool.call');
    expect(mapped!.data).toMatchObject({ tool: 'bash', callId: 'c1' });
  });

  it('maps tool_execution_end → tool.result with ok inverted from isError', () => {
    const mapped = mapBrainEventToSpine(
      ev('tool_execution_end', { toolCallId: 'c1', result: 'err', isError: true, durationMs: 5 }),
    );
    expect(mapped!.kind).toBe('tool.result');
    expect(mapped!.data).toMatchObject({ callId: 'c1', ok: false });
  });

  it('maps session_compacted range + checkpoint onto session.compacted', () => {
    const mapped = mapBrainEventToSpine(
      ev('session_compacted', {
        summary: 'inner',
        messagesRemoved: 4,
        fromSeq: 2,
        toSeq: 8,
        checkpoint: { role: 'user', content: 'wrapped inner' },
        strategy: 'extractive',
        sourceEventSeqs: [2, 3, 8],
        inputTokens: 900,
        outputTokens: 250,
        savedTokens: 650,
        recompactionRate: 1,
        summaryStrategy: 'extractive',
        provider: 'test-provider',
        model: 'test-model',
      }),
    );
    expect(mapped!.kind).toBe('session.compacted');
    expect(mapped!.data).toMatchObject({
      summary: 'inner',
      fromSeq: 2,
      toSeq: 8,
      strategy: 'extractive',
      checkpoint: { role: 'user', content: 'wrapped inner' },
      inputTokens: 900,
      outputTokens: 250,
      savedTokens: 650,
      recompactionRate: 1,
      summaryStrategy: 'extractive',
      provider: 'test-provider',
      model: 'test-model',
    });
  });

  it('maps tool_call_truncated errors to a model-visible user.message note', () => {
    const mapped = mapBrainEventToSpine(
      ev('error', {
        severity: 'recoverable',
        code: 'tool_call_truncated',
        message: 'Tool call was truncated',
      }),
    );
    expect(mapped).not.toBeNull();
    expect(mapped!.kind).toBe('user.message');
    expect(mapped!.actor).toEqual(ACTOR_USER);
    expect((mapped!.data as { text: string }).text).toBe(TOOL_CALL_TRUNCATED_RECOVERY_USER);
  });

  it('maps text_tools_parse_failed to the model-visible failure note (2.18.1 t49)', () => {
    const mapped = mapBrainEventToSpine(
      ev('error', {
        severity: 'recoverable',
        code: 'text_tools_parse_failed',
        message: 'Found text-format tool block but parse failed',
      }),
    );
    expect(mapped).not.toBeNull();
    expect(mapped!.kind).toBe('user.message');
    expect((mapped!.data as { text: string }).text).toBe(TEXT_TOOLS_FAILED_USER);
  });

  it('maps text_tools_truncated to the partial-salvage note (2.18.1 t49)', () => {
    const mapped = mapBrainEventToSpine(
      ev('error', {
        severity: 'recoverable',
        code: 'text_tools_truncated',
        message: 'Text-format tool block was truncated (missing ---END---)',
      }),
    );
    expect(mapped).not.toBeNull();
    expect(mapped!.kind).toBe('user.message');
    expect((mapped!.data as { text: string }).text).toBe(TEXT_TOOLS_PARTIAL_USER);
  });

  it('keeps other error codes out of the spine vocabulary', () => {
    expect(
      mapBrainEventToSpine(ev('error', { severity: 'recoverable', message: 'provider hiccup' })),
    ).toBeNull();
    expect(
      mapBrainEventToSpine(
        ev('error', {
          severity: 'recoverable',
          code: 'tool_budget_extended',
          message: 'extended',
        }),
      ),
    ).toBeNull();
  });

  it('drops ui/progress events (queue_update, message_start, thinking_delta)', () => {
    expect(mapBrainEventToSpine(ev('queue_update', { queuedCount: 1 }))).toBeNull();
    expect(mapBrainEventToSpine(ev('message_start', { messageId: 'm', role: 'assistant' }))).toBeNull();
    expect(mapBrainEventToSpine(ev('thinking_delta', { messageId: 'm', delta: 'x' }))).toBeNull();
  });
});

describe('SessionSpineMirror.adopt', () => {
  it('bootstraps a fresh session with session.started at seq 1', async () => {
    const mirror = await SessionSpineMirror.adopt('sess-a', { baseDir: tmp, quiet: true });
    expect(mirror.status).toBe('active');
    await mirror.close();
    const report = await readSessionLog(path.join(tmp, 'sess-a', 'events.jsonl'));
    expect(report.events.map((e) => e.kind)).toEqual(['session.started', 'session.ended']);
    expect(report.events[0].seq).toBe(1);
  });

  it('resumes an existing session: session.resumed + seq continues after lastSeq', async () => {
    const first = await SessionSpineMirror.adopt('sess-b', { baseDir: tmp, quiet: true });
    first.userMessage('hello');
    await first.close();
    const second = await SessionSpineMirror.adopt('sess-b', { baseDir: tmp, quiet: true });
    second.userMessage('again');
    await second.close('done');
    const report = await readSessionLog(path.join(tmp, 'sess-b', 'events.jsonl'));
    const kinds = report.events.map((e) => e.kind);
    // 2.6.1 (plan §4/§25): TaskContract is default-ON — the first
    // user.message seeds task.contract; the post-resume steer versions it
    // via task.contract_updated (append-only, monotone).
    expect(kinds).toEqual([
      'session.started',
      'user.message',
      'task.contract',
      'session.ended',
      'session.resumed',
      'user.message',
      'task.contract_updated',
      'session.ended',
    ]);
    // seq must be monotonic and gap-free across the reopen
    report.events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it('a second live writer is rejected as locked (ownership)', async () => {
    const first = await SessionSpineMirror.adopt('sess-c', { baseDir: tmp, quiet: true });
    const second = await SessionSpineMirror.adopt('sess-c', { baseDir: tmp, quiet: true });
    expect(second.status).toBe('locked');
    // the locked mirror is inert, the first keeps writing
    first.userMessage('still mine');
    await first.close();
    const report = await readSessionLog(path.join(tmp, 'sess-c', 'events.jsonl'));
    expect(report.events.some((e) => e.kind === 'user.message')).toBe(true);
  });

  it('a locked resume is LOUD: warns once on stderr like the degraded branch', async () => {
    const first = await SessionSpineMirror.adopt('sess-lock', { baseDir: tmp, quiet: true });
    const stderr: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    try {
      // NOT quiet — the locked branch must emit the warnOnce note itself.
      const second = await SessionSpineMirror.adopt('sess-lock', { baseDir: tmp });
      expect(second.status).toBe('locked');
      const out = stderr.join('');
      expect(out).toContain('session spine locked for sess-lo');
      expect(out).toContain('possibly dead');
      expect(out).toContain('WITHOUT derived spine context');
      expect(out).toContain('Session log is locked by another writer');
    } finally {
      spy.mockRestore();
      await first.close();
    }
  });

  it('degrades silently when the sessions dir cannot be created', async () => {
    // a FILE at the path where the directory should go → mkdir fails
    const blocker = path.join(tmp, 'blocker');
    await fs.writeFile(blocker, 'x', 'utf-8');
    const mirror = await SessionSpineMirror.adopt('sess-d', { baseDir: blocker, quiet: true });
    expect(mirror.status).toBe('degraded');
    // never throws, stays inert
    expect(() => mirror.userMessage('nope')).not.toThrow();
    await mirror.close();
  });

  it('ZELARI_SESSION_SPINE=0 disables the mirror entirely', async () => {
    const prev = process.env.ZELARI_SESSION_SPINE;
    process.env.ZELARI_SESSION_SPINE = '0';
    try {
      expect(spineEnabled()).toBe(false);
      const mirror = await SessionSpineMirror.adopt('sess-e', { baseDir: tmp, quiet: true });
      expect(mirror.status).toBe('disabled');
      await mirror.close();
      await expect(fs.access(path.join(tmp, 'sess-e'))).rejects.toThrow();
    } finally {
      if (prev === undefined) delete process.env.ZELARI_SESSION_SPINE;
      else process.env.ZELARI_SESSION_SPINE = prev;
    }
  });
});

describe('SessionSpineMirror.mirrorBrainEvent', () => {
  it('coalesces message_delta into ONE assistant.message at message_end', async () => {
    const mirror = await SessionSpineMirror.adopt('sess-f', { baseDir: tmp, quiet: true });
    mirror.mirrorBrainEvent(ev('message_start', { messageId: 'm1', role: 'assistant' }));
    mirror.mirrorBrainEvent(ev('message_delta', { messageId: 'm1', delta: 'Hello ' }));
    mirror.mirrorBrainEvent(ev('message_delta', { messageId: 'm1', delta: 'world' }));
    mirror.mirrorBrainEvent(ev('message_end', { messageId: 'm1', totalLength: 11, finishReason: 'stop' }));
    await mirror.close();
    const report = await readSessionLog(path.join(tmp, 'sess-f', 'events.jsonl'));
    const assistant = report.events.filter((e) => e.kind === 'assistant.message');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].data.text).toBe('Hello world');
  });

  it('message_end without buffered deltas logs nothing (no truncated claim)', async () => {
    const mirror = await SessionSpineMirror.adopt('sess-g', { baseDir: tmp, quiet: true });
    mirror.mirrorBrainEvent(ev('message_end', { messageId: 'orphan', totalLength: 0, finishReason: 'stop' }));
    await mirror.close();
    const report = await readSessionLog(path.join(tmp, 'sess-g', 'events.jsonl'));
    expect(report.events.filter((e) => e.kind === 'assistant.message')).toHaveLength(0);
  });

  it('mirrors tool call+result pair', async () => {
    const mirror = await SessionSpineMirror.adopt('sess-h', { baseDir: tmp, quiet: true });
    mirror.mirrorBrainEvent(ev('tool_execution_start', { toolCallId: 'c9', toolName: 'bash', args: {} }));
    mirror.mirrorBrainEvent(ev('tool_execution_end', { toolCallId: 'c9', result: 'ok', isError: false, durationMs: 12 }));
    await mirror.close();
    const report = await readSessionLog(path.join(tmp, 'sess-h', 'events.jsonl'));
    const kinds = report.events.map((e) => e.kind);
    expect(kinds).toContain('tool.call');
    expect(kinds).toContain('tool.result');
  });
});

describe('resumeSpineContext', () => {
  it('returns null for an unknown session and a projection for a logged one', async () => {
    expect(await resumeSpineContext('nope', tmp)).toBeNull();

    const mirror = await SessionSpineMirror.adopt('sess-i', { baseDir: tmp, quiet: true });
    mirror.userMessage('write a test');
    mirror.mirrorBrainEvent(ev('message_end', { messageId: 'm', totalLength: 2, finishReason: 'stop' }));
    // note: no deltas buffered → no assistant message; add one properly
    mirror.mirrorBrainEvent(ev('message_delta', { messageId: 'm2', delta: 'done' }));
    mirror.mirrorBrainEvent(ev('message_end', { messageId: 'm2', totalLength: 4, finishReason: 'stop' }));
    await mirror.close();

    const ctx = await resumeSpineContext('sess-i', tmp);
    expect(ctx).not.toBeNull();
    expect(ctx!.derived.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(ctx!.derived[0].content).toBe('write a test');
    expect(ctx!.projection.lastSeq).toBeGreaterThan(2);
  });
});

describe('SessionSpineMirror.release', () => {
  it('leaves the log without session.ended so resume can continue the seq', async () => {
    const mirror = await SessionSpineMirror.adopt('sess-int', { baseDir: tmp, quiet: true });
    mirror.userMessage('partial');
    await mirror.release();
    const { readSessionLog } = await import('@zelari/core/session');
    const report = await readSessionLog(path.join(tmp, 'sess-int', 'events.jsonl'));
    expect(report.events.some((e) => e.kind === 'session.ended')).toBe(false);

    const again = await SessionSpineMirror.adopt('sess-int', { baseDir: tmp, quiet: true });
    expect(again.status).toBe('active');
    expect(again.resumedFromSeq).toBeGreaterThan(0);
    await again.close('done');
  });
});

describe('ADR-0033 (t75): derived file events on the spine', () => {
  async function readKinds(sessionId: string) {
    const { readSessionLog } = await import('@zelari/core/session');
    const report = await readSessionLog(path.join(tmp, sessionId, 'events.jsonl'));
    return report;
  }

  it('read_file tool.result → file.read right after it, with path + snapshotId', async () => {
    const mirror = await SessionSpineMirror.adopt('sess-fileread', { baseDir: tmp, quiet: true });
    mirror.mirrorBrainEvent(
      ev('tool_execution_start', { toolName: 'read_file', args: { path: 'a.ts' }, toolCallId: 'c1' }),
    );
    mirror.mirrorBrainEvent(
      ev('tool_execution_end', {
        toolCallId: 'c1',
        result: JSON.stringify({ path: '/r/a.ts', snapshotId: 'abcd1234abcd1234' }),
        isError: false,
        durationMs: 1,
      }),
    );
    await mirror.close('test');

    const report = await readKinds('sess-fileread');
    const kinds = report.events.map((e) => e.kind);
    const i = kinds.indexOf('tool.result');
    expect(i).toBeGreaterThan(-1);
    expect(kinds[i + 1]).toBe('file.read');
    expect(report.events[i + 1].data).toMatchObject({
      path: '/r/a.ts',
      snapshotId: 'abcd1234abcd1234',
    });
  });

  it('edit ok → file.applied; edit reject → file.rejected (compact: no minimalDiff)', async () => {
    const mirror = await SessionSpineMirror.adopt('sess-fileedit', { baseDir: tmp, quiet: true });
    mirror.mirrorBrainEvent(
      ev('tool_execution_start', { toolName: 'edit', args: { path: 'a.ts' }, toolCallId: 'e1' }),
    );
    mirror.mirrorBrainEvent(
      ev('tool_execution_end', {
        toolCallId: 'e1',
        result: JSON.stringify({
          path: '/r/a.ts',
          applied: true,
          occurrencesReplaced: 1,
          snapshotId: 'eeee5678eeee5678',
          bytesWritten: 9,
        }),
        isError: false,
        durationMs: 1,
      }),
    );
    mirror.mirrorBrainEvent(
      ev('tool_execution_start', { toolName: 'edit', args: { path: 'b.ts' }, toolCallId: 'e2' }),
    );
    mirror.mirrorBrainEvent(
      ev('tool_execution_end', {
        toolCallId: 'e2',
        result:
          'edit: stale_snapshot: /r/b.ts (expected aaaa1111, actual bbbb2222)\nstatus=failed warnings=STALE_SNAPSHOT',
        isError: true,
        durationMs: 1,
      }),
    );
    await mirror.close('test');

    const report = await readKinds('sess-fileedit');
    const kinds = report.events.map((e) => e.kind);
    const appliedAt = kinds.indexOf('file.applied');
    const rejectedAt = kinds.indexOf('file.rejected');
    expect(appliedAt).toBeGreaterThan(kinds.indexOf('tool.result'));
    expect(rejectedAt).toBeGreaterThan(appliedAt);
    expect(report.events[appliedAt].data).toMatchObject({
      path: '/r/a.ts',
      occurrencesReplaced: 1,
      snapshotId: 'eeee5678eeee5678',
    });
    expect(report.events[rejectedAt].data).toMatchObject({
      path: '/r/b.ts',
      status: 'stale_snapshot',
    });
    expect(JSON.stringify(report.events[rejectedAt].data)).not.toContain('minimalDiff');
  });

  it('non-file tools and unparsable payloads derive nothing (no crash, no events)', async () => {
    const mirror = await SessionSpineMirror.adopt('sess-filenoise', { baseDir: tmp, quiet: true });
    mirror.mirrorBrainEvent(
      ev('tool_execution_start', { toolName: 'bash', args: {}, toolCallId: 'b1' }),
    );
    mirror.mirrorBrainEvent(
      ev('tool_execution_end', { toolCallId: 'b1', result: 'ok', isError: false, durationMs: 1 }),
    );
    mirror.mirrorBrainEvent(
      ev('tool_execution_start', { toolName: 'read_file', args: {}, toolCallId: 'r1' }),
    );
    mirror.mirrorBrainEvent(
      ev('tool_execution_end', {
        toolCallId: 'r1',
        result: 'not json {{{',
        isError: false,
        durationMs: 1,
      }),
    );
    await mirror.close('test');

    const report = await readKinds('sess-filenoise');
    expect(report.events.some((e) => e.kind.startsWith('file.'))).toBe(false);
  });
});
