/**
 * ACP server — session/prompt semantics: ordered streaming, a non-blocking
 * JSON-RPC loop, refusal mapping, cancel (notification AND request) and the
 * EOF/shutdown contract. Dispatcher is always a fake: no provider, no network.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createMessageParser, encodeMessage } from './framing.js';
import { startAcpServer } from './server.js';
import type { AcpTurnDispatcher, AcpTurnRequest, AcpTurnResult } from './turnAdapter.js';

type Msg = Record<string, any>;

function createHarness(dispatcher: AcpTurnDispatcher) {
  const input = new PassThrough();
  const written: string[] = [];
  const logs: string[] = [];
  let shutdowns = 0;
  const handle = startAcpServer({
    dispatcher,
    input,
    output: {
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    },
    log: (line) => logs.push(line),
    onShutdown: () => {
      shutdowns += 1;
    },
  });
  const parser = createMessageParser();
  let consumed = 0;
  return {
    input,
    handle,
    logs,
    shutdownCount: () => shutdowns,
    send: (message: unknown): void => {
      input.write(encodeMessage(message));
    },
    take: (): Msg[] => {
      const chunk = written.slice(consumed).join('');
      consumed = written.length;
      return parser.push(chunk) as Msg[];
    },
    flush: (ticks = 3): Promise<void> =>
      new Promise<void>((resolve) => {
        let n = 0;
        const step = (): void => {
          if (n++ >= ticks) return resolve();
          setImmediate(step);
        };
        step();
      }),
  };
}

function byId(messages: Msg[], id: unknown): Msg | undefined {
  return messages.find((m) => m?.['id'] === id);
}

function updatesOf(messages: Msg[]): Msg[] {
  return messages.filter((m) => m?.['method'] === 'session/update');
}

/** initialize + session/new, returning the session id. */
async function openSession(h: ReturnType<typeof createHarness>): Promise<string> {
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  h.send({ jsonrpc: '2.0', method: 'initialized' });
  h.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/work' } });
  await h.flush();
  const sessionId = byId(h.take(), 2)?.['result']?.['sessionId'];
  if (typeof sessionId !== 'string') throw new Error('session/new did not return a sessionId');
  return sessionId;
}

function prompt(h: ReturnType<typeof createHarness>, id: number, sessionId: string, text: string): void {
  h.send({
    jsonrpc: '2.0',
    id,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text }] },
  });
}

describe('acp/server — session/prompt', () => {
  it('streams updates in dispatcher order, then answers with stopReason', async () => {
    const dispatcher: AcpTurnDispatcher = async (request: AcpTurnRequest) => {
      request.onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'reading ' },
      });
      request.onUpdate({
        sessionUpdate: 'tool_call',
        callId: 'c1',
        title: 'read_file',
        kind: 'execute',
        status: 'pending',
      });
      request.onUpdate({ sessionUpdate: 'tool_call_update', callId: 'c1', status: 'completed' });
      request.onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
      });
      return { stopReason: 'end_turn', exitCode: 0 };
    };
    const h = createHarness(dispatcher);
    const sessionId = await openSession(h);
    prompt(h, 9, sessionId, 'read the file');
    await h.flush();
    const messages = h.take();
    expect(updatesOf(messages)).toEqual([
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'reading ' },
          },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            callId: 'c1',
            title: 'read_file',
            kind: 'execute',
            status: 'pending',
          },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'tool_call_update', callId: 'c1', status: 'completed' },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
        },
      },
    ]);
    expect(byId(messages, 9)?.['result']).toEqual({ stopReason: 'end_turn' });
    h.handle.close();
  });

  it('does NOT block the loop while a turn runs (other requests are served)', async () => {
    let release: ((r: AcpTurnResult) => void) | undefined;
    const h = createHarness(
      () =>
        new Promise<AcpTurnResult>((resolve) => {
          release = resolve;
        }),
    );
    const sessionId = await openSession(h);
    prompt(h, 20, sessionId, 'slow');
    await h.flush();
    h.send({ jsonrpc: '2.0', id: 21, method: 'initialize', params: {} });
    await h.flush();
    const messages = h.take();
    // initialize answered BEFORE the turn finished: nothing queues behind it.
    expect(byId(messages, 21)).toHaveProperty('result');
    expect(byId(messages, 20)).toBeUndefined();
    release?.({ stopReason: 'end_turn', exitCode: 0 });
    await h.flush();
    expect(byId(h.take(), 20)?.['result']).toEqual({ stopReason: 'end_turn' });
    h.handle.close();
  });

  it('rejects a second prompt while one is in flight', async () => {
    let release: ((r: AcpTurnResult) => void) | undefined;
    const h = createHarness(
      () =>
        new Promise<AcpTurnResult>((resolve) => {
          release = resolve;
        }),
    );
    const sessionId = await openSession(h);
    prompt(h, 10, sessionId, 'one');
    await h.flush();
    prompt(h, 11, sessionId, 'two');
    await h.flush();
    expect(byId(h.take(), 11)?.['error']?.['code']).toBe(-32602);
    release?.({ stopReason: 'end_turn', exitCode: 0 });
    await h.flush();
    h.handle.close();
  });

  it('maps a failing turn to refusal without killing the process', async () => {
    const h = createHarness(async () => {
      throw new Error('provider exploded');
    });
    const sessionId = await openSession(h);
    prompt(h, 30, sessionId, 'x');
    await h.flush();
    expect(byId(h.take(), 30)?.['result']).toEqual({ stopReason: 'refusal' });
    expect(h.logs.some((l) => l.includes('provider exploded'))).toBe(true);

    h.send({ jsonrpc: '2.0', id: 31, method: 'initialize', params: {} });
    await h.flush();
    expect(byId(h.take(), 31)).toHaveProperty('result');
    h.handle.close();
  });
});

describe('acp/server — cancel', () => {
  it('session/cancel as a NOTIFICATION settles the prompt as cancelled and drops later updates', async () => {
    let emitLate: (() => void) | undefined;
    const h = createHarness(
      (request: AcpTurnRequest) =>
        new Promise<AcpTurnResult>((resolve) => {
          emitLate = () => {
            request.onUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'late' },
            });
            resolve({ stopReason: 'end_turn', exitCode: 0 });
          };
        }),
    );
    const sessionId = await openSession(h);
    prompt(h, 40, sessionId, 'long task');
    await h.flush();
    h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    await h.flush();
    expect(byId(h.take(), 40)?.['result']).toEqual({ stopReason: 'cancelled' });

    emitLate?.();
    await h.flush();
    expect(updatesOf(h.take())).toEqual([]); // the cancelled turn streams nothing
    h.handle.close();
  });

  it('session/cancel is also accepted as a REQUEST (answers null)', async () => {
    const h = createHarness(async () => ({ stopReason: 'end_turn', exitCode: 0 }));
    const sessionId = await openSession(h);
    h.send({ jsonrpc: '2.0', id: 50, method: 'session/cancel', params: { sessionId } });
    await h.flush();
    expect(byId(h.take(), 50)?.['result']).toBeNull();
    h.handle.close();
  });
});

describe('acp/server — shutdown', () => {
  it('EOF shuts down once, settles in-flight prompts, and whenClosed resolves', async () => {
    let release: ((r: AcpTurnResult) => void) | undefined;
    const h = createHarness(
      () =>
        new Promise<AcpTurnResult>((resolve) => {
          release = resolve;
        }),
    );
    const sessionId = await openSession(h);
    prompt(h, 60, sessionId, 'in flight');
    await h.flush();
    h.take();

    h.input.end();
    await h.flush();
    expect(h.shutdownCount()).toBe(1);
    expect(byId(h.take(), 60)?.['result']).toEqual({ stopReason: 'cancelled' });

    h.handle.close(); // idempotent
    expect(h.shutdownCount()).toBe(1);
    await expect(h.handle.whenClosed()).resolves.toBeUndefined();
    release?.({ stopReason: 'end_turn', exitCode: 0 });
    await h.flush();
    expect(h.shutdownCount()).toBe(1);
  });

  it('whenClosed() after close() resolves immediately', async () => {
    const h = createHarness(async () => ({ stopReason: 'end_turn', exitCode: 0 }));
    h.handle.close();
    await expect(h.handle.whenClosed()).resolves.toBeUndefined();
  });
});
