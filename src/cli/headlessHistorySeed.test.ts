/**
 * headlessHistorySeed — Exit-1/E1.2 canonical model-context path.
 *
 * Proves: legacy `--history` is imported one-shot into a fresh spine log,
 * prior turns are then derived from events (never re-imported), resume
 * ignores fresh legacy input, and a disabled spine falls back to the
 * filtered legacy seed (declared discrete fallback).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openHeadlessSpine, seedHeadlessModelHistory } from './headlessSpine.js';
import { readSessionLog, resolveSessionsDir } from '@zelari/core/session';
import type { AgentMessage } from '@zelari/core/harness';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-history-seed-'));
});

afterEach(async () => {
  delete process.env.ZELARI_SESSION_SPINE;
  await fs.rm(tmp, { recursive: true, force: true });
});

const legacy: AgentMessage[] = [
  { role: 'user', content: 'build the login form' },
  {
    role: 'assistant',
    content: '<think>plan</think>Done — see ---QUESTION---\ncontinue?',
  },
  { role: 'system', content: 'stale system' },
  { role: 'tool', content: '{"ok":true}' } as AgentMessage,
];

function eventsPath(sessionId: string): string {
  return path.join(resolveSessionsDir({ baseDir: tmp }), sessionId, 'events.jsonl');
}

describe('seedHeadlessModelHistory', () => {
  it('imports legacy --history one-shot and returns the derived seed', async () => {
    const handle = await openHeadlessSpine({
      sessionId: 'seed-1',
      baseDir: tmp,
      quiet: true,
    });
    const seed = await seedHeadlessModelHistory(handle, legacy);

    expect(seed.source).toBe('spine-import');
    expect(seed.importedCount).toBe(2);
    // system/tool dropped; <think> + ---QUESTION--- preserved (binding policy)
    expect(seed.history).toHaveLength(2);
    expect(seed.history[0]).toEqual({ role: 'user', content: 'build the login form', seq: 3 });
    expect(seed.history[1]?.role).toBe('assistant');
    expect(seed.history[1]?.content).toContain('<think>plan</think>');
    expect(seed.history[1]?.content).toContain('---QUESTION---');

    // The imported turns are in the log — model-visible ⟺ logged (P1).
    const report = await readSessionLog(eventsPath('seed-1'));
    const texts = report.events
      .filter((e) => e.kind === 'user.message' || e.kind === 'assistant.message')
      .map((e) => (e.data as { text?: string }).text);
    expect(texts).toEqual(['build the login form', seed.history[1]!.content]);
    const imported = report.events.find((e) => e.kind === 'assistant.message');
    expect((imported?.data as Record<string, unknown>).imported).toBe(
      'legacy-history',
    );
    await handle.close('test-end');
  });

  it('derives from the log on resume and ignores new legacy input', async () => {
    const first = await openHeadlessSpine({
      sessionId: 'seed-2',
      baseDir: tmp,
      quiet: true,
    });
    const s1 = await seedHeadlessModelHistory(first, [
      { role: 'user', content: 'u-first' },
      { role: 'assistant', content: 'a-first' },
    ]);
    expect(s1.source).toBe('spine-import');
    await first.close('test-end');

    const resumed = await openHeadlessSpine({
      sessionId: 'seed-2',
      baseDir: tmp,
      quiet: true,
    });
    const s2 = await seedHeadlessModelHistory(resumed, [
      { role: 'user', content: 'u-second-should-be-ignored' },
    ]);
    expect(s2.source).toBe('spine');
    expect(s2.importedCount).toBe(0);
    expect(s2.history.map((m) => m.content)).toEqual(['u-first', 'a-first']);
    await resumed.close('test-end');
  });

  it('falls back to the filtered legacy seed when the spine is disabled', async () => {
    process.env.ZELARI_SESSION_SPINE = '0';
    const handle = await openHeadlessSpine({
      sessionId: 'seed-3',
      baseDir: tmp,
      quiet: true,
    });
    const seed = await seedHeadlessModelHistory(handle, legacy);
    expect(seed.source).toBe('legacy-fallback');
    expect(seed.importedCount).toBe(0);
    expect(seed.history.map((m) => m.role)).toEqual(['user', 'assistant']);
    await handle.close('test-end');
  });

  it('returns an empty seed for a fresh log with no legacy history', async () => {
    const handle = await openHeadlessSpine({
      sessionId: 'seed-4',
      baseDir: tmp,
      quiet: true,
    });
    const seed = await seedHeadlessModelHistory(handle);
    expect(seed).toEqual({ history: [], importedCount: 0, source: 'spine' });
    await handle.close('test-end');
  });

  it('keeps model-surface events in conversation order (invariant)', async () => {
    const handle = await openHeadlessSpine({
      sessionId: 'seed-5',
      baseDir: tmp,
      quiet: true,
    });
    const plain: AgentMessage[] = [
      { role: 'user', content: 'plain user' },
      { role: 'assistant', content: 'plain assistant' },
    ];
    const seed = await seedHeadlessModelHistory(handle, plain);
    expect(seed.source).toBe('spine-import');

    const report = await readSessionLog(eventsPath('seed-5'));
    const kinds = report.events.map((e) => e.kind);
    expect(kinds.indexOf('user.message')).toBeLessThan(
      kinds.indexOf('assistant.message'),
    );
    // Clean text round-trips byte-identical through import → derive.
    expect(seed.history).toEqual([
      { ...plain[0], seq: 3 },
      { ...plain[1], seq: 4 },
    ]);
    await handle.close('test-end');
  });

  it('derivedModelSeed: compacted → user, tool results dropped (shared policy)', async () => {
    const handle = await openHeadlessSpine({
      sessionId: 'seed-6',
      baseDir: tmp,
      quiet: true,
    });
    await seedHeadlessModelHistory(handle, [{ role: 'user', content: 'u1' }]);

    // A compaction event lands on the spine (TUI /compact or budget policy).
    handle.spine.mirrorBrainEvent({
      type: 'session_compacted',
      summary: 'sum-of-old-turns',
    } as never);
    await handle.spine.flush();
    const afterCompact = await seedHeadlessModelHistory(handle, []);
    expect(afterCompact.source).toBe('spine');
    expect(
      afterCompact.history.map((m) => `${m.role}:${m.content}`),
    ).toContain('user:sum-of-old-turns');

    // Tool results derive as orphans (no assistant tool_calls block) and
    // must NOT reach the model seed.
    handle.spine.mirrorBrainEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      result: 'raw tool output',
      isError: false,
    } as never);
    await handle.spine.flush();
    const afterTool = await seedHeadlessModelHistory(handle, []);
    expect(afterTool.history.some((m) => m.role === 'tool')).toBe(false);
    await handle.close('test-end');
  });
});
