/**
 * sessionReplayInvariant — Exit-1 gate E1.6 + E1.7 (CI-required).
 *
 * E1.6 (replay determinismo): a scripted multi-turn run must reconstruct
 *   entirely from `events.jsonl` alone — replay → deriveMessages →
 *   derivedModelSeed is deterministic and semantic-equal to the documented
 *   mapping (compacted → user, orphan tool results dropped, assistant
 *   scrubbed with the binding policy).
 *
 * E1.7 (invariante P1, ADR-0016): model-visible ⟺ logged.
 *   forward:  every message that feeds the harness traces back to a
 *             MODEL_SURFACE event by seq;
 *   backward: every model-surface event either lands in the derived
 *             history or is excluded by a declared, tested policy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionSpineMirror } from './sessionSpine.js';
import {
  openHeadlessSpine,
  seedHeadlessModelHistory,
  derivedModelSeed,
  type HeadlessSpineHandle,
} from './headlessSpine.js';
import {
  readSessionLog,
  deriveMessages,
  isModelSurfaceEvent,
  coveringCompactions,
  shadowedSeqSet,
  resolveSessionsDir,
  type SessionEventEnvelope,
} from '@zelari/core/session';
import type { AgentMessage } from '@zelari/core/harness';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-replay-inv-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function eventsPath(sessionId: string): string {
  return path.join(resolveSessionsDir({ baseDir: tmp }), sessionId, 'events.jsonl');
}

function brainEvent(type: string, rest: Record<string, unknown> = {}) {
  return { type, id: `id-${type}`, ts: 1_755_000_000_000, sessionId: 's1', ...rest } as never;
}

/** Replay the raw JSONL without touching any writer (cross-process view). */
async function replay(sessionId: string): Promise<SessionEventEnvelope[]> {
  const report = await readSessionLog(eventsPath(sessionId));
  expect(report.ok).toBe(true);
  expect(report.issues).toEqual([]);
  return report.events;
}

/**
 * Script a full headless-shaped run: legacy import, one live turn with a
 * streamed assistant reply (message_end coalescer) plus a tool call/result,
 * then a compaction — the whole model-surface zoo.
 */
async function runScriptedSession(sessionId: string): Promise<HeadlessSpineHandle> {
  const handle = await openHeadlessSpine({ sessionId, baseDir: tmp, quiet: true });

  const legacy: AgentMessage[] = [
    { role: 'user', content: 'legacy-u1' },
    { role: 'assistant', content: 'legacy-a1' },
  ];
  const seed = await seedHeadlessModelHistory(handle, legacy);
  expect(seed.source).toBe('spine-import');

  // Live turn 1 — exactly the order runHeadless wires them.
  handle.userMessage('turn-1 task');
  handle.spine.mirrorBrainEvent(brainEvent('message_delta', { messageId: 'm1', delta: '<think>x</think>' }));
  handle.spine.mirrorBrainEvent(brainEvent('message_delta', { messageId: 'm1', delta: 'turn-1 reply' }));
  handle.spine.mirrorBrainEvent(brainEvent('message_end', { messageId: 'm1', finishReason: 'stop' }));
  handle.spine.mirrorBrainEvent(
    brainEvent('tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }),
  );
  handle.spine.mirrorBrainEvent(
    brainEvent('tool_execution_end', { toolCallId: 'c1', result: 'file-a file-b', isError: false }),
  );
  handle.spine.mirrorBrainEvent(brainEvent('session_compacted', { summary: 'compacted-context' }));
  await handle.spine.flush();
  return handle;
}

describe('Exit-1/E1.6 — replay determinismo (log → deriveMessages → seed)', () => {
  it('reconstructs the whole run from events.jsonl alone (cross-process resume)', async () => {
    const handle = await runScriptedSession('inv-e16-a');
    await handle.close('test-end');

    // New adopt on the same log — no shared memory with the scripted run.
    const reopened = await SessionSpineMirror.adopt('inv-e16-a', { baseDir: tmp, quiet: true });
    expect(reopened.status).toBe('active');
    const derived = await reopened.derivedPriorTurns();
    expect(derived).not.toBeNull();

    // Independent derive straight from the raw file must agree exactly.
    const fromFile = deriveMessages(await replay('inv-e16-a'));
    expect(derived).toEqual(fromFile);

    const roleContent = derived!.map((m) => `${m.role}:${m.content}`);
    expect(roleContent).toEqual([
      'user:legacy-u1',
      'assistant:legacy-a1',
      'user:turn-1 task',
      'assistant:<think>x</think>turn-1 reply',
      'tool:file-a file-b', // derived neutral history keeps tool results…
      'system:compacted-context', // …and compaction, before the seed policy maps them
    ]);
    await reopened.close('test-end');
  });

  it('derives deterministically: two replays of the same log are deep-equal', async () => {
    const handle = await runScriptedSession('inv-e16-b');
    await handle.close('test-end');
    const first = deriveMessages(await replay('inv-e16-b'));
    const second = deriveMessages(await replay('inv-e16-b'));
    expect(first).toEqual(second);
  });

  it('seed policy is the documented semantic-equal mapping', async () => {
    const handle = await runScriptedSession('inv-e16-c');
    await handle.close('test-end');

    const derived = deriveMessages(await replay('inv-e16-c'));
    const seed = derivedModelSeed(derived);
    expect(seed.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:legacy-u1',
      'assistant:legacy-a1',
      'user:turn-1 task',
      'assistant:<think>x</think>turn-1 reply', // binding policy: <think> preserved
      'user:compacted-context', // compacted summary → user (1.x store convention)
      // tool result dropped: orphan role 'tool' without a paired tool_calls block
    ]);
  });
});

describe('Exit-1/E1.7 — invariante model-visible ⟺ logged (P1)', () => {
  it('forward: every derived message traces to a model-surface event by seq', async () => {
    const handle = await runScriptedSession('inv-e17-a');
    await handle.close('test-end');

    const events = await replay('inv-e17-a');
    const derived = deriveMessages(events);
    expect(derived.length).toBeGreaterThan(0);
    for (const m of derived) {
      const source = events.find((e) => e.seq === m.seq);
      expect(source, `seq ${m.seq} must exist in the log`).toBeDefined();
      expect(isModelSurfaceEvent(source!)).toBe(true);
      const expectedRole =
        source!.kind === 'user.message'
          ? 'user'
          : source!.kind === 'assistant.message'
            ? 'assistant'
            : source!.kind === 'session.compacted'
              ? 'system'
              : 'tool';
      expect(m.role).toBe(expectedRole);
    }
  });

  it('backward: every model-surface event reaches the derived history or is excluded by declared policy', async () => {
    const handle = await runScriptedSession('inv-e17-b');
    await handle.close('test-end');

    const events = await replay('inv-e17-b');
    const derived = deriveMessages(events);
    const derivedSeqs = new Set(derived.map((m) => m.seq));
    const surface = events.filter(isModelSurfaceEvent);
    expect(surface.length).toBeGreaterThan(0);
    const shadowed = shadowedSeqSet(coveringCompactions(events));
    for (const e of surface) {
      // Declared exclusions: tool.call (includeToolCalls=false) and seqs
      // shadowed by a range-bearing session.compacted.
      if (e.kind === 'tool.call') continue;
      if (shadowed.has(e.seq)) continue;
      expect(derivedSeqs.has(e.seq), `${e.kind}@${e.seq} must derive`).toBe(true);
    }
  });

  it('next-turn harness history rebuilds from the spine alone after the run', async () => {
    const handle = await runScriptedSession('inv-e17-c');

    // Turn 2 wiring, exactly as runHeadless does: seed BEFORE the prompt log.
    const seed = await seedHeadlessModelHistory(handle, []);
    expect(seed.source).toBe('spine');
    handle.userMessage('turn-2 task');
    handle.spine.mirrorBrainEvent(brainEvent('message_delta', { messageId: 'm2', delta: 'turn-2 reply' }));
    handle.spine.mirrorBrainEvent(brainEvent('message_end', { messageId: 'm2', finishReason: 'stop' }));
    await handle.spine.flush();

    // What the harness of turn 2 saw is the seed plus the current prompt.
    // Forward invariant on live wiring: every seed message — user,
    // assistant, compacted-summary-as-user — traces to a logged
    // model-surface event, and log order matches turn order.
    const surface = (await replay('inv-e17-c')).filter(isModelSurfaceEvent);
    const loggedTexts = surface.map((e) =>
      String(
        (e.data as { text?: string; summary?: string }).text ??
          (e.data as { summary?: string }).summary ??
          '',
      ),
    );
    const texts = loggedTexts.filter((t) =>
      ['legacy-u1', 'turn-1 task', 'turn-2 task'].includes(t),
    );
    expect(texts).toEqual(['legacy-u1', 'turn-1 task', 'turn-2 task']);
    for (const m of seed.history) {
      expect(loggedTexts).toContain(m.content);
    }
    expect(texts.indexOf('turn-1 task')).toBeLessThan(texts.indexOf('turn-2 task'));

    await handle.close('test-end');
    const turn3 = await SessionSpineMirror.adopt('inv-e17-c', { baseDir: tmp, quiet: true });
    const seed3 = derivedModelSeed((await turn3.derivedPriorTurns()) ?? []);
    expect(seed3.map((m) => m.content)).toEqual([
      'legacy-u1',
      'legacy-a1',
      'turn-1 task',
      '<think>x</think>turn-1 reply',
      'compacted-context',
      'turn-2 task',
      'turn-2 reply',
    ]);
    await turn3.close('test-end');
  });
});
