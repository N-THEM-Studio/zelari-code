/**
 * agentHarnessTextToolsFeedback.test.ts — 2.18.1 (t49)
 *
 * A provider-truncated ---TOOLS--- block previously lost EVERY call: the
 * canonical regex requires ---END---, so no salvage strategy ran, the
 * error was UI-only, and the model never learned its calls did not run
 * ("describes edits it never made"). Locks the new contract:
 *   - complete prefix calls of a truncated block execute;
 *   - the model context receives a feedback note (fallback history push)
 *     for both partial salvage and full parse failure;
 *   - the spine-facing error codes are emitted for sessionSpine mirroring.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentHarness,
  TEXT_TOOLS_FAILED_MARKER,
  TEXT_TOOLS_PARTIAL_MARKER,
  type ProviderDelta,
  type ProviderStreamFn,
} from './AgentHarness.js';
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

describe('AgentHarness text-tools feedback (2.18.1 t49)', () => {
  it('truncated block: runs the complete prefix and tells the model about the dropped tail', async () => {
    const log: string[] = [];
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'go' },
    ];
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'texttools-partial',
      messages: messages as AgentHarness['config']['messages'],
      tools: [],
      toolRegistry: makeRegistry(log),
      providerStream: fakeStream([
        [
          {
            kind: 'text',
            // Cut mid-second-call: provider truncation, no ---END---.
            delta:
              '---TOOLS---[{"name":"read_file","args":{"path":"a.ts"}},{"name":"read_file","args":{"path":"b.ts","con',
          },
          { kind: 'finish', reason: 'stop' },
        ],
        [{ kind: 'finish', reason: 'stop' }],
      ]),
    });
    const events = await collect(harness);
    // The complete prefix call executed exactly once.
    expect(log).toEqual(['read_file']);
    // Spine-facing advisory emitted for the mirroring layer.
    expect(
      events.some(
        (e) => e.type === 'error' && (e as { code?: string }).code === 'text_tools_truncated',
      ),
    ).toBe(true);
    // The model-visible note landed in the rolling history after the seal.
    const note = messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(TEXT_TOOLS_PARTIAL_MARKER),
    );
    expect(note).toBeDefined();
    expect(note!.content as string).toContain('Re-emit the remaining work');
  });

  it('unrecoverable block: nothing executes and the model learns the calls did not run', async () => {
    const log: string[] = [];
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'go' },
    ];
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'texttools-failed',
      messages: messages as AgentHarness['config']['messages'],
      tools: [],
      toolRegistry: makeRegistry(log),
      providerStream: fakeStream([
        [
          { kind: 'text', delta: '---TOOLS---[{"name":"read_file","args":{"path":"' },
          { kind: 'finish', reason: 'stop' },
        ],
        [{ kind: 'finish', reason: 'stop' }],
      ]),
    });
    const events = await collect(harness);
    expect(log).toEqual([]);
    expect(
      events.some(
        (e) => e.type === 'error' && (e as { code?: string }).code === 'text_tools_parse_failed',
      ),
    ).toBe(true);
    const note = messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(TEXT_TOOLS_FAILED_MARKER),
    );
    expect(note).toBeDefined();
    expect(note!.content as string).toContain('no call parsed');
  });

  it('canonical block: no feedback note is injected (no false positives)', async () => {
    const log: string[] = [];
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'go' },
    ];
    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'test',
      sessionId: 'texttools-clean',
      messages: messages as AgentHarness['config']['messages'],
      tools: [],
      toolRegistry: makeRegistry(log),
      providerStream: fakeStream([
        [
          {
            kind: 'text',
            delta: '---TOOLS---[{"name":"read_file","args":{"path":"a.ts"}}]---END---',
          },
          { kind: 'finish', reason: 'stop' },
        ],
        [{ kind: 'finish', reason: 'stop' }],
      ]),
    });
    await collect(harness);
    expect(log).toEqual(['read_file']);
    expect(
      messages.some(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          (m.content.includes(TEXT_TOOLS_PARTIAL_MARKER) || m.content.includes(TEXT_TOOLS_FAILED_MARKER)),
      ),
    ).toBe(false);
  });
});
