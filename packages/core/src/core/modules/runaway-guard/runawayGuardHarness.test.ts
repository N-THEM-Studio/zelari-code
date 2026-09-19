/**
 * runawayGuardHarness.test.ts — WIRING test: the AgentHarness really consults
 * core/modules/runaway-guard (identical-repetition warn before a dispatch;
 * stall → turn-ending abort with the existing message_end / agent_end events).
 *
 * Lives next to the module (scope: packages/core/src/core/modules/**) because
 * the harness must not grow test-only seams: the guard is driven through its
 * public defaults, exactly as the loop uses it — the scenarios below only
 * shape the provider stream.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentHarness, type ProviderDelta, type ProviderStreamFn } from '../../AgentHarness.js';
import { ToolRegistry } from '../../tools/registry.js';

/** Registry whose tool result never changes (identical results = no progress). */
function staticRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'read_file',
    description: 'read',
    permissions: [],
    inputSchema: z.object({ path: z.string() }),
    execute: async () => ({ ok: true, value: 'file-content' }),
  });
  return registry;
}

function harnessWith(providerStream: ProviderStreamFn, sessionId: string): AgentHarness {
  return new AgentHarness({
    model: 'test-model',
    provider: 'test',
    sessionId,
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    toolRegistry: staticRegistry(),
    providerStream,
  });
}

/** Provider fake: repeats the LAST script entry once the script runs out. */
function scriptedStream(script: ProviderDelta[][]): ProviderStreamFn {
  let call = 0;
  return async function* (): AsyncIterable<ProviderDelta> {
    const seq = script[Math.min(call, script.length - 1)]!;
    call += 1;
    for (const d of seq) yield d;
  };
}

/** Provider fake: one read_file of paths[i % len] per turn, forever. */
function cyclicStream(paths: string[], onCall?: () => void): ProviderStreamFn {
  let call = 0;
  return async function* (): AsyncIterable<ProviderDelta> {
    onCall?.();
    const path = paths[call % paths.length]!;
    call += 1;
    yield { kind: 'tool_call', toolCallId: `t${call}`, toolName: 'read_file', args: { path } };
    yield { kind: 'finish', reason: 'tool_calls' };
  };
}

type Ev = { type: string; [k: string]: unknown };

async function collect(harness: AgentHarness): Promise<Ev[]> {
  const events: Ev[] = [];
  for await (const ev of harness.run()) events.push(ev as unknown as Ev);
  return events;
}

/** Capture console.error lines WITHOUT losing them to mockRestore(). */
async function withStderr<T>(fn: () => Promise<T>): Promise<{ lines: string[]; value: T }> {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const value = await fn();
    return { lines: spy.mock.calls.map((call) => String(call[0] ?? '')), value };
  } finally {
    spy.mockRestore();
  }
}

describe('AgentHarness × runaway-guard (wiring)', () => {
  it('warns (log only) on the 3rd identical call of a turn and dispatches it anyway', async () => {
    const identical: ProviderDelta[][] = [
      [
        { kind: 'tool_call', toolCallId: 't1', toolName: 'read_file', args: { path: 'a.ts' } },
        { kind: 'tool_call', toolCallId: 't2', toolName: 'read_file', args: { path: 'a.ts' } },
        { kind: 'tool_call', toolCallId: 't3', toolName: 'read_file', args: { path: 'a.ts' } },
        { kind: 'finish', reason: 'tool_calls' },
      ],
      [{ kind: 'finish', reason: 'stop' }],
    ];
    const { lines, value: events } = await withStderr(() =>
      collect(harnessWith(scriptedStream(identical), 'runaway-warn')),
    );

    const warnings = lines.filter((line) => line.startsWith('[runaway-guard]'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('read_file');
    expect(warnings[0]).toContain('3× in a row');
    // Warn is advisory: all three calls still reached the registry.
    expect(events.filter((e) => e.type === 'tool_execution_end')).toHaveLength(3);
  });

  it('warns at most once per identical call key, however long the loop runs', async () => {
    // 8 turns of the very same call: the guard keeps returning 'warn', but the
    // log must not grow with the repetition (stderr flood).
    let call = 0;
    const repeating: ProviderStreamFn = async function* (): AsyncIterable<ProviderDelta> {
      const i = call;
      call += 1;
      if (i >= 8) {
        yield { kind: 'finish', reason: 'stop' };
        return;
      }
      yield {
        kind: 'tool_call',
        toolCallId: `t${i}`,
        toolName: 'read_file',
        args: { path: 'a.ts' },
      };
      yield { kind: 'finish', reason: 'tool_calls' };
    };
    const { lines } = await withStderr(() =>
      collect(harnessWith(repeating, 'runaway-warn-dedupe')),
    );

    const warnings = lines.filter((line) => line.startsWith('[runaway-guard]'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('3× in a row');
  });

  it('abort: ends the turn after K turns without new calls or results', async () => {
    let providerCalls = 0;
    const cyclic = cyclicStream(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'], () => {
      providerCalls += 1;
    });
    const { value: events } = await withStderr(() =>
      collect(harnessWith(cyclic, 'runaway-abort')),
    );

    const abort = events.find((e) => e.code === 'runaway_guard_abort');
    expect(abort).toBeDefined();
    expect(abort!.severity).toBe('recoverable');
    expect(String(abort!.message)).toContain('no new tool call or tool result');
    // The turn was closed cleanly: the existing turn/run end events still fire.
    expect(events.filter((e) => e.type === 'message_end').at(-1)?.finishReason).toBe('stop');
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'completed' });
    // …and the loop stopped instead of draining the whole tool budget (soft 60).
    expect(providerCalls).toBeLessThan(20);
  });

  it('does not abort a run that keeps making progress', async () => {
    // A brand-new path every turn = a new call key every turn: the stall
    // counter never advances, and the run ends on its own closing turn.
    let call = 0;
    let providerCalls = 0;
    const growing: ProviderStreamFn = async function* () {
      providerCalls += 1;
      const i = call;
      call += 1;
      if (i >= 12) {
        yield { kind: 'finish', reason: 'stop' };
        return;
      }
      yield { kind: 'tool_call', toolCallId: `t${i}`, toolName: 'read_file', args: { path: `file-${i}.ts` } };
      yield { kind: 'finish', reason: 'tool_calls' };
    };
    const { value: events } = await withStderr(() =>
      collect(harnessWith(growing, 'runaway-progress')),
    );

    expect(events.find((e) => e.code === 'runaway_guard_abort')).toBeUndefined();
    expect(events.at(-1)?.type).toBe('agent_end');
    expect(providerCalls).toBe(13); // 12 tool turns + the closing answer turn
  });
});
