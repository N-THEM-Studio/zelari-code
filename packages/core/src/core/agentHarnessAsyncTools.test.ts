/**
 * agentHarnessAsyncTools.test.ts — B8 (ADR-0038): async tool call placeholders.
 *
 * Verifies that parallel-safe tool calls produce correct results and that
 * the placeholder mechanism (injection + replacement) leaves no stale markers
 * in the model history.
 */
import { describe, expect, it } from 'vitest';
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
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, value: 'shell-output' };
    },
  });
  return registry;
}

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

describe('AgentHarness async tool placeholders (B8)', () => {
  it('parallel tool calls produce correct results in model history', async () => {
    const log: string[] = [];
    const registry = makeRegistry(log);
    const messages: Array<{ role: string; content?: string; toolCallId?: string; toolCalls?: unknown[] }> = [
      { role: 'user', content: 'read and check' },
    ];

    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'test-async',
      messages,
      tools: [],
      toolRegistry: registry,
      providerStream: fakeStream([
        [
          { kind: 'text', delta: 'I will read and check.' },
          { kind: 'tool_call', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a.txt' } },
          { kind: 'tool_call', toolCallId: 'c2', toolName: 'bash', args: { command: 'ls' } },
          { kind: 'finish', reason: 'tool_calls' },
        ],
        [{ kind: 'text', delta: 'Done.' }, { kind: 'finish', reason: 'stop' }],
      ]),
    });

    const events = await collect(harness);

    // Both tools executed
    expect(log).toContain('read_file');
    expect(log).toContain('bash');

    // Tool end events emitted for both
    const toolEnds = events.filter((e) => e.type === 'tool_execution_end');
    expect(toolEnds).toHaveLength(2);

    // Model history has assistant + 2 tool results (no placeholders remain)
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    // No placeholder markers in final history
    for (const m of toolMessages) {
      expect(m.content).not.toContain('[still-running:');
    }
    // Actual results present
    const contents = toolMessages.map((m) => m.content).sort();
    expect(contents).toEqual(['file-content', 'shell-output']);
  });

  it('single tool call does not use placeholder path', async () => {
    const log: string[] = [];
    const registry = makeRegistry(log);
    const messages: Array<{ role: string; content?: string; toolCallId?: string; toolCalls?: unknown[] }> = [
      { role: 'user', content: 'read file' },
    ];

    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'test-single',
      messages,
      tools: [],
      toolRegistry: registry,
      providerStream: fakeStream([
        [
          { kind: 'tool_call', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a.txt' } },
          { kind: 'finish', reason: 'tool_calls' },
        ],
        [{ kind: 'text', delta: 'Done.' }, { kind: 'finish', reason: 'stop' }],
      ]),
    });

    await collect(harness);

    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]!.content).toBe('file-content');
    expect(toolMessages[0]!.content).not.toContain('[still-running:');
  });
});
