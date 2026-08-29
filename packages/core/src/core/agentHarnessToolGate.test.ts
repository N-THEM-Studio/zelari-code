/**
 * agentHarnessToolGate.test.ts — v2.6 Phase 3 resource seam (doc §11.3/§13):
 * the host-owned `toolCallGate` is consulted before every registry dispatch
 * (native tool_call deltas AND text-format tools). Denied calls synthesize a
 * model-visible error result and never reach the registry; a missing or
 * throwing gate never blocks a call (degrade-and-stop, P1).
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentHarness, type ProviderDelta, type ProviderStreamFn } from './AgentHarness.js';
import { ToolRegistry } from './tools/registry.js';

function makeRegistry(log: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'read_file',
    description: 'read',
    permissions: [],
    inputSchema: z.object({ path: z.string() }),
    execute: async () => {
      log.push('read_file');
      return { ok: true, value: 'file-content' };
    },
  });
  registry.register({
    name: 'bash',
    description: 'shell',
    permissions: [],
    inputSchema: z.object({ command: z.string() }),
    execute: async () => {
      log.push('bash');
      return { ok: true, value: 'ok' };
    },
  });
  return registry;
}

/** Provider fake: each call emits the deltas of script[callIndex]. */
function fakeStream(script: ProviderDelta[][]): ProviderStreamFn {
  let call = 0;
  return async function* (): AsyncIterable<ProviderDelta> {
    const seq = script[Math.min(call, script.length - 1)]!;
    call++;
    for (const d of seq) yield d;
  };
}

async function collect(harness: AgentHarness) {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const ev of harness.run()) events.push(ev as unknown as { type: string });
  return events;
}

function toolEnds(events: Array<{ type: string; [k: string]: unknown }>) {
  return events.filter((e) => e.type === 'tool_execution_end');
}

describe('AgentHarness toolCallGate (2.6 Phase 3)', () => {
  it('denies a native tool call: registry NOT invoked, error result is model-visible', async () => {
    const log: string[] = [];
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'gate-native',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      toolRegistry: makeRegistry(log),
      providerStream: fakeStream([
        [
          { kind: 'tool_call', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
          { kind: 'finish', reason: 'tool_calls' },
        ],
        [{ kind: 'finish', reason: 'stop' }],
      ]),
      toolCallGate: (name) =>
        name === 'bash' ? { allowed: false, reason: 'verification reserve — no new scope' } : { allowed: true },
    });
    const events = await collect(harness);
    const ends = toolEnds(events);
    const denied = ends.find((e) => typeof e.result === 'string' && (e.result as string).includes('[resource-gate]'));
    expect(denied).toBeDefined();
    expect(denied!.isError).toBe(true);
    expect((denied!.result as string)).toContain('verification reserve');
    expect(log).toEqual([]);
  });

  it('allows verification-ish tools through the same gate', async () => {
    const log: string[] = [];
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'gate-allow',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      toolRegistry: makeRegistry(log),
      providerStream: fakeStream([
        [
          { kind: 'tool_call', toolCallId: 't2', toolName: 'read_file', args: { path: 'x' } },
          { kind: 'finish', reason: 'tool_calls' },
        ],
        [{ kind: 'finish', reason: 'stop' }],
      ]),
      toolCallGate: (name) =>
        name === 'bash' ? { allowed: false, reason: 'reserve' } : { allowed: true },
    });
    const events = await collect(harness);
    const ok = toolEnds(events).find((e) => e.result === 'file-content');
    expect(ok).toBeDefined();
    expect(log).toEqual(['read_file']);
  });

  it('degrade-and-stop: a THROWING gate never blocks the call', async () => {
    const log: string[] = [];
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'gate-throw',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      toolRegistry: makeRegistry(log),
      providerStream: fakeStream([
        [
          { kind: 'tool_call', toolCallId: 't3', toolName: 'bash', args: { command: 'ls' } },
          { kind: 'finish', reason: 'tool_calls' },
        ],
        [{ kind: 'finish', reason: 'stop' }],
      ]),
      toolCallGate: () => {
        throw new Error('gate exploded');
      },
    });
    const events = await collect(harness);
    const ok = toolEnds(events).find((e) => e.result === 'ok');
    expect(ok).toBeDefined();
    expect(log).toEqual(['bash']);
  });

  it('denies text-format tool calls with the same model-visible reason', async () => {
    const log: string[] = [];
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'gate-text',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      toolRegistry: makeRegistry(log),
      providerStream: fakeStream([
        [
          {
            kind: 'text',
            delta: '---TOOLS---[{"name":"bash","args":{"command":"ls -la"}}]---END---',
          },
          { kind: 'finish', reason: 'stop' },
        ],
        [{ kind: 'finish', reason: 'stop' }],
      ]),
      toolCallGate: (name) =>
        name === 'bash' ? { allowed: false, reason: 'reserve' } : { allowed: true },
    });
    const events = await collect(harness);
    const ends = toolEnds(events);
    const denied = ends.find((e) => typeof e.result === 'string' && (e.result as string).includes('[resource-gate]'));
    expect(denied).toBeDefined();
    expect(denied!.isError).toBe(true);
    expect(log).toEqual([]);
  });
});

describe('AgentHarness toolCallGate failure mode (v2.16 t24)', () => {
  it('fail-closed: a THROWING gate DENIES the call — registry NOT invoked, gate-failed', async () => {
    const log: string[] = [];
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'gate-throw-strict',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      toolRegistry: makeRegistry(log),
      providerStream: fakeStream([
        [
          { kind: 'tool_call', toolCallId: 't4', toolName: 'bash', args: { command: 'ls' } },
          { kind: 'finish', reason: 'tool_calls' },
        ],
        [{ kind: 'finish', reason: 'stop' }],
      ]),
      toolCallGate: () => {
        throw new Error('gate exploded');
      },
      toolCallGateFailureMode: 'fail-closed',
    });
    const events = await collect(harness);
    const denied = toolEnds(events).find(
      (e) => typeof e.result === 'string' && (e.result as string).includes('gate-failed'),
    );
    expect(denied).toBeDefined();
    expect(denied!.isError).toBe(true);
    expect(log).toEqual([]);
  });

  it('fail-closed also denies on the text-format tool path', async () => {
    const log: string[] = [];
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'gate-throw-strict-text',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      toolRegistry: makeRegistry(log),
      providerStream: fakeStream([
        [
          {
            kind: 'text',
            delta: '---TOOLS---[{"name":"bash","args":{"command":"ls -la"}}]---END---',
          },
          { kind: 'finish', reason: 'stop' },
        ],
        [{ kind: 'finish', reason: 'stop' }],
      ]),
      toolCallGate: () => {
        throw new Error('gate exploded');
      },
      toolCallGateFailureMode: 'fail-closed',
    });
    const events = await collect(harness);
    const denied = toolEnds(events).find(
      (e) => typeof e.result === 'string' && (e.result as string).includes('gate-failed'),
    );
    expect(denied).toBeDefined();
    expect(denied!.isError).toBe(true);
    expect(log).toEqual([]);
  });

  it('default stays fail-open for the TUI: allow + logged warning', async () => {
    const log: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const harness = new AgentHarness({
        model: 'test-model',
        provider: 'test',
        sessionId: 'gate-throw-tui',
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        toolRegistry: makeRegistry(log),
        providerStream: fakeStream([
          [
            { kind: 'tool_call', toolCallId: 't5', toolName: 'bash', args: { command: 'ls' } },
            { kind: 'finish', reason: 'tool_calls' },
          ],
          [{ kind: 'finish', reason: 'stop' }],
        ]),
        toolCallGate: () => {
          throw new Error('gate exploded');
        },
      });
      const events = await collect(harness);
      const ok = toolEnds(events).find((e) => e.result === 'ok');
      expect(ok).toBeDefined();
      expect(log).toEqual(['bash']);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('fail-open'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
