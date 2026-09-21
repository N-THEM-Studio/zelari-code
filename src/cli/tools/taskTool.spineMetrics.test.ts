/**
 * t159 (P2a-2) — `subagent.metrics` on the task tool path.
 *
 * Runs REAL `runTentacle` runs against scripted harnesses (same machinery as
 * taskTool.tentacleContract.test) and pins the four things the slice claims:
 *   1. a terminal tentacle — success AND failure — emits ONE event, carrying
 *      the counters t156/t157 already thread up (`ok`, `turns`, `toolCalls`,
 *      usage, durationMs, `degenerate`) and nothing else: no prompt, no result
 *      text, no fabricated zeros when the provider reported no usage;
 *   2. a FAILING sink cannot break the tentacle it is measuring (fail-open),
 *      and an absent sink (host without a spine) records nothing at all;
 *   3. the `task` tool forwards `ToolContext.emitSessionEvent`, so the event
 *      lands on the session's REAL spine through the REAL writer — the
 *      vocabulary addition survives zod + the tolerant replay;
 *   4. the replay stays tolerant (ADR-0016): the new line never becomes an
 *      issue, and no consumer of the projection is broken by its presence.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrainEvent } from '@zelari/core/shared/events';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import {
  SessionLogWriter,
  buildProjection,
  readSessionLog,
  SUBAGENT_METRICS_KIND,
  type SessionEventInput,
} from '@zelari/core/session';
import {
  createTaskTool,
  flushSubagentMetrics,
  resetTaskSpawnCount,
  resetTaskVerifyObligation,
  runTentacle,
  type SubAgentContext,
  type TaskToolDeps,
} from './taskTool.js';

beforeEach(() => {
  resetTaskVerifyObligation();
  resetTaskSpawnCount();
});

/** Status-theater line from the 2026-09-21 incident (> the guard's min length). */
const LOOP_LINE =
  'Bene, dungeon.js fatto. Aggiorno todo e procedo con inventory adesso, come previsto.';

function scriptedDeps(run: () => AsyncGenerator<BrainEvent>): TaskToolDeps {
  return {
    createSubAgentContext: async ({ agent }) => {
      const ctx: SubAgentContext = {
        providerStream: (() => {
          throw new Error('not invoked by the scripted harness');
        }) as unknown as SubAgentContext['providerStream'],
        model: 'test-model',
        provider: 'test-provider',
        registry: new ToolRegistry(),
        tools: [],
        agent,
      };
      return ctx;
    },
    harnessFactory: () => ({ run }),
    allowWorktree: false,
  };
}

/** One tool call + one assistant turn that REPORTS usage (like a real provider). */
function measuredRun(): () => AsyncGenerator<BrainEvent> {
  return async function* (): AsyncGenerator<BrainEvent> {
    yield {
      type: 'tool_execution_start',
      toolCallId: 't159-1',
      toolName: 'bash',
      args: { command: 'npx vitest run src/cli/tools' },
    } as unknown as BrainEvent;
    yield {
      type: 'tool_execution_end',
      toolCallId: 't159-1',
      isError: false,
      durationMs: 4,
      result: '1/1 passed',
    } as unknown as BrainEvent;
    yield { type: 'message_start' } as BrainEvent;
    yield { type: 'message_delta', delta: 'Done: the suite is green.' } as BrainEvent;
    yield {
      type: 'message_end',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    } as unknown as BrainEvent;
  };
}

function collector(): { events: SessionEventInput[]; sink: (i: SessionEventInput) => Promise<unknown> } {
  const events: SessionEventInput[] = [];
  return {
    events,
    sink: async (input) => {
      events.push(input);
      return { seq: events.length };
    },
  };
}

function runAt(cwd: string, extra: Record<string, unknown> = {}) {
  return runTentacle({
    deps: scriptedDeps(measuredRun()),
    args: { description: 'slice t159', prompt: 'implement the slice' },
    agent: 'explore',
    thoroughness: 'quick',
    parentCwd: cwd,
    sessionId: 't159-spine-metrics',
    ...extra,
  } as Parameters<typeof runTentacle>[0]);
}

describe('t159 — terminal metrics event (P2a-2)', () => {
  it('success ⇒ one event with the measured counters and NO fabricated usage', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-t159-'));
    const { events, sink } = collector();
    const res = await runAt(cwd, { sessionEventSink: sink });
    await flushSubagentMetrics();

    expect(res.ok).toBe(true);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe(SUBAGENT_METRICS_KIND);
    expect(event.actor).toEqual({ type: 'system', role: 'metrics' });
    const data = event.data!;
    expect(data).toMatchObject({
      kind: 'explore',
      ok: true,
      thoroughness: 'quick',
      model: 'test-model',
      turns: 1,
      toolCalls: 1,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
    // Honest absence: a provider that cached nothing gets no `cached` field,
    // and no PII (prompt/result/detail) ever rides along.
    expect('cachedPromptTokens' in (data.usage as object)).toBe(false);
    expect('degenerate' in data).toBe(false);
    expect('prompt' in data || 'result' in data || 'detail' in data).toBe(false);
    expect(typeof data.durationMs).toBe('number');
  });

  it('failure (loop guard) ⇒ the SAME event, ok:false + structured degenerate flag', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-t159-'));
    const { events, sink } = collector();
    const deps = scriptedDeps(async function* (): AsyncGenerator<BrainEvent> {
      for (let i = 0; i < 5; i += 1) {
        yield { type: 'message_start' } as BrainEvent;
        yield { type: 'message_delta', delta: LOOP_LINE } as BrainEvent;
        yield { type: 'message_end' } as BrainEvent;
      }
    });
    const res = await runTentacle({
      deps,
      args: { description: 'degenerate', prompt: 'research' },
      agent: 'explore',
      thoroughness: 'quick',
      parentCwd: cwd,
      sessionId: 't159-degenerate',
      sessionEventSink: sink,
    });
    await flushSubagentMetrics();

    expect(res.ok).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      kind: 'explore',
      ok: false,
      degenerate: true,
      turns: 3,
    });
    // No usage was reported by the scripted harness: the key is ABSENT, not 0.
    expect('usage' in events[0]!.data!).toBe(false);
  });

  it('failure (no output) ⇒ still emits, with no counters invented', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-t159-'));
    const { events, sink } = collector();
    const deps = scriptedDeps(async function* (): AsyncGenerator<BrainEvent> {});
    const res = await runTentacle({
      deps,
      args: { description: 'empty run', prompt: 'nothing' },
      agent: 'explore',
      thoroughness: 'quick',
      parentCwd: cwd,
      sessionId: 't159-empty',
      sessionEventSink: sink,
    });
    await flushSubagentMetrics();

    expect(res.ok).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ kind: 'explore', ok: false });
    expect('turns' in events[0]!.data!).toBe(false);
    expect('toolCalls' in events[0]!.data!).toBe(false);
    expect('usage' in events[0]!.data!).toBe(false);
  });

  it('FAIL-OPEN: a throwing sink cannot break the tentacle, and no sink is silent', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-t159-'));
    const thrown = await runAt(cwd, {
      sessionEventSink: () => Promise.reject(new Error('SESSION_LOG_LOCKED')),
    });
    await flushSubagentMetrics();
    expect(thrown.ok).toBe(true);
    if (!thrown.ok) throw new Error(thrown.error);
    expect(thrown.result).toContain('the suite is green');

    // Host without a spine: the run is byte-identical to the pre-t159 behavior.
    const { events } = collector();
    const noSink = await runAt(cwd);
    await flushSubagentMetrics();
    expect(noSink.ok).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('t159 — the task tool path lands on the REAL spine (P2a-2)', () => {
  it('ctx.emitSessionEvent → real writer → replay: the new line is not an issue', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-t159-'));
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-t159-sessions-'));
    const writer = await SessionLogWriter.open(dir, 't159-tool-path', 1);
    const ctx: ToolContext = {
      signal: new AbortController().signal,
      cwd,
      audit: () => undefined,
      sessionId: 't159-tool-path',
      emitSessionEvent: (input) => writer.append(input),
    };
    try {
      const tool = createTaskTool(scriptedDeps(measuredRun()), { allowedAgents: ['explore'] });
      const args = { description: 'slice t159', prompt: 'implement the slice' };
      const out = await tool.execute(
        args as Parameters<typeof tool.execute>[0],
        ctx,
      );
      await flushSubagentMetrics();
      expect(out.ok, out.ok ? '' : out.error).toBe(true);
    } finally {
      await writer.close();
    }

    const report = await readSessionLog(writer.path);
    const events = report.events.filter((e) => e.kind === SUBAGENT_METRICS_KIND);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toEqual({ type: 'system', role: 'metrics' });
    expect(events[0]!.data.kind).toBe('explore');
    expect(events[0]!.data.ok).toBe(true);
    expect(events[0]!.data.toolCalls).toBe(1);
    // Tolerance + no broken consumer: the write is not an issue, and the
    // projection (model history included) is unaffected by the measurement.
    expect(report.issues).toEqual([]);
    const projection = buildProjection(report.events, report.issues);
    expect(projection.eventCount).toBe(1);
    expect(projection.messages).toEqual([]);
  });
});
