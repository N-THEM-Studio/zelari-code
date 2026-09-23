import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from './store.js';
import { forkSession, lineageOf, resumeSession } from './lineage.js';
import { exportSession } from './exportSession.js';
import { ACTOR_USER } from './types.js';

async function tmpStore(): Promise<SessionStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-store-test-'));
  return SessionStore.withDefaults({ baseDir: dir });
}

describe('SessionStore + lineage', () => {
  it('create → read → projection roundtrip', async () => {
    const store = await tmpStore();
    const { sessionId, writer } = await store.create({ reason: 'test', profile: 'kraken/v1' });
    await writer.append({ kind: 'user.message', actor: ACTOR_USER, data: { text: 'hello' } });
    await store.end(writer, 'done');
    const projection = await store.projection(sessionId);
    expect(projection.startedAt).toBeDefined();
    expect(projection.endedAt).toBeDefined();
    expect(projection.messages).toHaveLength(1);
    const summaries = await store.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.sessionId).toBe(sessionId);
    await fs.rm(store.dir, { recursive: true, force: true });
  });

  it('resume classifies a dangling mutating tool call as inspect-first', async () => {
    const store = await tmpStore();
    const { sessionId, writer } = await store.create();
    await writer.append({
      kind: 'tool.call',
      actor: { type: 'agent' },
      data: { callId: 'w1', tool: 'write_file' },
    });
    await writer.close();
    const resumed = await resumeSession(store, sessionId);
    expect(resumed.projection.interruptedTools).toEqual([]);
    const kinds = (await store.read(sessionId)).events.map((e) => e.kind);
    expect(kinds).toContain('tool.interrupted');
    expect(kinds).toContain('session.resumed');
    await resumed.writer.close();
    await fs.rm(store.dir, { recursive: true, force: true });
  });

  it('resume continues the seq and marks session.resumed', async () => {
    const store = await tmpStore();
    const { sessionId, writer } = await store.create();
    await writer.append({ kind: 'note', actor: ACTOR_USER, data: { n: 1 } });
    await writer.close(); // interrupt without session.ended
    const resumed = await resumeSession(store, sessionId);
    const e = await resumed.writer.append({ kind: 'note', actor: ACTOR_USER, data: { n: 2 } });
    expect(e.seq).toBe(4); // started, note, resumed, note
    expect(resumed.projection.resumedCount).toBe(1);
    expect(resumed.projection.endedAt).toBeUndefined(); // interrupted session is resumable
    await resumed.writer.close();
    await fs.rm(store.dir, { recursive: true, force: true });
  });

  it('fork copies the trajectory up to fromSeq and records lineage', async () => {
    const store = await tmpStore();
    const parent = await store.create();
    await parent.writer.append({ kind: 'user.message', actor: ACTOR_USER, data: { text: 'v1' } });
    await parent.writer.append({ kind: 'note', actor: ACTOR_USER, data: { n: 2 } });
    await parent.writer.append({ kind: 'note', actor: ACTOR_USER, data: { n: 3 } });
    const fork = await forkSession(store, parent.sessionId, { fromSeq: 2 });
    const forkProjection = await store.projection(fork.sessionId);
    expect(fork.copiedEvents).toBe(2);
    expect(forkProjection.fork).toEqual({ parentSessionId: parent.sessionId, parentSeq: 2 });
    expect(forkProjection.lastSeq).toBe(4); // 2 copied + forked event... (1 started + 1 message + forked)
    const chain = await lineageOf(store, fork.sessionId);
    expect(chain).toEqual([parent.sessionId, fork.sessionId]);
    await parent.writer.close();
    await fork.writer.close();
    await fs.rm(store.dir, { recursive: true, force: true });
  });

  it('exportSession produces the portable format with summary', async () => {
    const store = await tmpStore();
    const { sessionId, writer } = await store.create();
    await writer.append({ kind: 'user.message', actor: ACTOR_USER, data: { text: 'x' } });
    await store.end(writer);
    const exported = await exportSession(store, sessionId);
    expect(exported.format).toBe('zelari-session-export');
    expect(exported.version).toBe(1);
    expect(exported.events).toHaveLength(3);
    expect(exported.summary.lastSeq).toBe(3);
    await fs.rm(store.dir, { recursive: true, force: true });
  });

  it('fork at turn boundary preserves tool.call + tool.result + assistant.message', async () => {
    const store = await tmpStore();
    const parent = await store.create();
    // Simulate a full turn: user msg → tool call → tool result → assistant reply
    await parent.writer.append({ kind: 'user.message', actor: ACTOR_USER, data: { text: 'fix bug' } }); // seq 1 (started) + 2
    await parent.writer.append({ kind: 'tool.call', actor: { type: 'agent' }, data: { callId: 'c1', tool: 'bash', args: { command: 'ls' } } }); // seq 3
    await parent.writer.append({ kind: 'tool.result', actor: { type: 'tool' }, data: { callId: 'c1', output: 'file.txt', ok: true, durationMs: 50 } }); // seq 4
    await parent.writer.append({ kind: 'assistant.message', actor: { type: 'agent' }, data: { text: 'found file.txt' } }); // seq 5
    // Fork at the turn boundary (after assistant reply)
    const fork = await forkSession(store, parent.sessionId, { fromSeq: 5 });
    const forkProjection = await store.projection(fork.sessionId);
    // 5 parent events copied (fromSeq <= 5); forked session also has its own
    // session.started + session.forked marker = 7 total events
    expect(fork.copiedEvents).toBe(5);
    expect(forkProjection.lastSeq).toBe(7); // 1 fork-started + 5 copied + 1 forked marker
    // Tool calls/results are preserved in the fork
    expect(forkProjection.toolCalls).toBe(1);
    expect(forkProjection.toolResults).toBe(1);
    // Messages are preserved
    expect(forkProjection.messages).toHaveLength(3); // user + tool result + assistant
    // Lineage is correct
    const chain = await lineageOf(store, fork.sessionId);
    expect(chain).toEqual([parent.sessionId, fork.sessionId]);
    await parent.writer.close();
    await fork.writer.close();
    await fs.rm(store.dir, { recursive: true, force: true });
  });

  it('forked session replay is independent from parent', async () => {
    const store = await tmpStore();
    const parent = await store.create();
    await parent.writer.append({ kind: 'user.message', actor: ACTOR_USER, data: { text: 'start' } });
    await parent.writer.append({ kind: 'assistant.message', actor: { type: 'agent' }, data: { text: 'reply v1' } });
    const fork = await forkSession(store, parent.sessionId, { fromSeq: 3 });
    // Add different events to parent and fork
    await parent.writer.append({ kind: 'user.message', actor: ACTOR_USER, data: { text: 'parent continues' } });
    await fork.writer.append({ kind: 'user.message', actor: ACTOR_USER, data: { text: 'fork diverges' } });
    const parentProj = await store.projection(parent.sessionId);
    const forkProj = await store.projection(fork.sessionId);
    // Parent sees its own continuation
    expect(parentProj.messages.some((m) => m.content === 'parent continues')).toBe(true);
    expect(parentProj.messages.some((m) => m.content === 'fork diverges')).toBe(false);
    // Fork sees its own divergence
    expect(forkProj.messages.some((m) => m.content === 'fork diverges')).toBe(true);
    expect(forkProj.messages.some((m) => m.content === 'parent continues')).toBe(false);
    // Both share the common prefix
    expect(forkProj.messages.some((m) => m.content === 'start')).toBe(true);
    expect(forkProj.messages.some((m) => m.content === 'reply v1')).toBe(true);
    await parent.writer.close();
    await fork.writer.close();
    await fs.rm(store.dir, { recursive: true, force: true });
  });

  it('forked session export is independent', async () => {
    const store = await tmpStore();
    const parent = await store.create();
    await parent.writer.append({ kind: 'user.message', actor: ACTOR_USER, data: { text: 'hello' } });
    await store.end(parent.writer, 'done');
    const fork = await forkSession(store, parent.sessionId, { fromSeq: 2 });
    await store.end(fork.writer, 'fork-done');
    const parentExport = await exportSession(store, parent.sessionId);
    const forkExport = await exportSession(store, fork.sessionId);
    // Different session IDs
    expect(parentExport.sessionId).not.toBe(forkExport.sessionId);
    // Fork has the forked marker
    const forkEvents = forkExport.events as Array<{ kind: string }>;
    expect(forkEvents.some((e) => e.kind === 'session.forked')).toBe(true);
    // Parent does NOT have a forked marker
    const parentEvents = parentExport.events as Array<{ kind: string }>;
    expect(parentEvents.some((e) => e.kind === 'session.forked')).toBe(false);
    await fs.rm(store.dir, { recursive: true, force: true });
  });
});
