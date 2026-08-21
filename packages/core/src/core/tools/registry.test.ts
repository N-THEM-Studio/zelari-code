import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import { typedOk, type ToolDefinition } from './toolTypes.js';

function def<I, O>(partial: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return partial;
}

describe('ToolRegistry.invoke timeout + abort', () => {
  it('aborts the tool signal on timeout without aborting the parent signal', async () => {
    const parent = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const reg = new ToolRegistry();
    reg.register(
      def({
        name: 'slow',
        description: 'slow',
        permissions: [],
        timeoutMs: 40,
        inputSchema: z.object({}),
        execute: async (_args, ctx) => {
          toolSignal = ctx.signal;
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 400);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(t);
              resolve();
            }, { once: true });
          });
          return typedOk('done');
        },
      }),
    );
    const res = await reg.invoke('slow', {}, { signal: parent.signal });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/timed out after 40ms/);
    expect(parent.signal.aborted).toBe(false);
    expect(toolSignal?.aborted).toBe(true);
  });

  it('does not abort a completed tool after timeoutMs elapses', async () => {
    let toolSignal: AbortSignal | undefined;
    const reg = new ToolRegistry();
    reg.register(
      def({
        name: 'fast',
        description: 'fast',
        permissions: [],
        timeoutMs: 80,
        inputSchema: z.object({}),
        execute: async (_args, ctx) => {
          toolSignal = ctx.signal;
          return typedOk('ok');
        },
      }),
    );
    const res = await reg.invoke('fast', {});
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(toolSignal?.aborted).toBe(false);
  });

  it('aborts the tool when the parent signal aborts', async () => {
    const parent = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const reg = new ToolRegistry();
    reg.register(
      def({
        name: 'hang',
        description: 'hang',
        permissions: [],
        timeoutMs: 5_000,
        inputSchema: z.object({}),
        execute: async (_args, ctx) => {
          toolSignal = ctx.signal;
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 5_000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            }, { once: true });
          });
          return typedOk('done');
        },
      }),
    );
    const p = reg.invoke('hang', {}, { signal: parent.signal });
    await new Promise((r) => setTimeout(r, 20));
    parent.abort();
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/aborted/);
    expect(toolSignal?.aborted).toBe(true);
  });
});
