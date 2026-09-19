/**
 * ACP server — handshake + routing/error behaviour (fail-soft: every error
 * answer leaves the loop alive). The dispatcher is ALWAYS a fake here: no
 * provider, no model, no network. Turn streaming / cancel / shutdown live in
 * serverPrompt.test.ts.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createMessageParser, encodeMessage } from './framing.js';
import { startAcpServer } from './server.js';
import type { AcpTurnDispatcher, AcpTurnResult } from './turnAdapter.js';

type Msg = Record<string, any>;

function createHarness(dispatcher: AcpTurnDispatcher, fallbackCwd?: string) {
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
    ...(fallbackCwd ? { fallbackCwd } : {}),
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
    /** Messages decoded since the previous take() (order preserved). */
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

const okDispatcher: AcpTurnDispatcher = async (): Promise<AcpTurnResult> => ({
  stopReason: 'end_turn',
  exitCode: 0,
});

function byId(messages: Msg[], id: unknown): Msg | undefined {
  return messages.find((m) => m?.['id'] === id);
}

describe('acp/server — handshake', () => {
  it('answers initialize with the protocol version + capabilities, ignoring `initialized`', async () => {
    const h = createHarness(okDispatcher);
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 7 } });
    h.send({ jsonrpc: '2.0', method: 'initialized' });
    await h.flush();
    const messages = h.take();
    expect(messages).toHaveLength(1); // the notification is never answered
    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 7,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      },
    });
    expect(h.logs).toEqual([]);
    h.handle.close();
  });

  it('defaults the protocol version when the client omits it', async () => {
    const h = createHarness(okDispatcher);
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await h.flush();
    expect(byId(h.take(), 1)?.['result']?.['protocolVersion']).toBe(1);
    h.handle.close();
  });

  it('opens sessions (client cwd, then the CLI --cwd fallback)', async () => {
    const h = createHarness(okDispatcher, '/fallback');
    h.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/client' } });
    await h.flush();
    const first = byId(h.take(), 1)?.['result']?.['sessionId'];
    h.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    await h.flush();
    const second = byId(h.take(), 2)?.['result']?.['sessionId'];
    expect(typeof first).toBe('string');
    expect(typeof second).toBe('string');
    expect(h.handle.sessionIds()).toEqual([first, second]);
    h.handle.close();
  });
});

describe('acp/server — routing errors (fail-soft: the loop survives)', () => {
  it('answers -32601 for an unknown method and keeps serving', async () => {
    const h = createHarness(okDispatcher);
    h.send({ jsonrpc: '2.0', id: 5, method: 'session/load', params: {} });
    await h.flush();
    expect(byId(h.take(), 5)?.['error']?.['code']).toBe(-32601);

    h.send({ jsonrpc: '2.0', id: 6, method: 'initialize', params: {} });
    await h.flush();
    expect(byId(h.take(), 6)).toHaveProperty('result');
    h.handle.close();
  });

  it('answers -32602 for malformed params (and for unknown sessions)', async () => {
    const h = createHarness(okDispatcher);
    h.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '' } });
    h.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] },
    });
    await h.flush();
    const messages = h.take();
    expect(byId(messages, 1)?.['error']?.['code']).toBe(-32602);
    expect(byId(messages, 2)?.['error']?.['message']).toContain('unknown session');
    h.handle.close();
  });

  it('answers -32600 for a garbage frame and stays alive', async () => {
    const h = createHarness(okDispatcher);
    h.send({ jsonrpc: '1.0', id: 1, method: 'initialize' });
    await h.flush();
    expect(byId(h.take(), 1)?.['error']?.['code']).toBe(-32600);

    h.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
    await h.flush();
    expect(byId(h.take(), 2)).toHaveProperty('result');
    h.handle.close();
  });

  it('logs and ignores an unknown notification (never answers a notification)', async () => {
    const h = createHarness(okDispatcher);
    h.send({ jsonrpc: '2.0', method: 'telemetry/ping', params: {} });
    await h.flush();
    expect(h.take()).toEqual([]);
    expect(h.logs.some((l) => l.includes('unknown notification'))).toBe(true);
    h.handle.close();
  });

  it('a cancel for an unknown session is logged, not fatal', async () => {
    const h = createHarness(okDispatcher);
    h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'ghost' } });
    await h.flush();
    expect(h.logs.some((l) => l.includes('unknown session'))).toBe(true);

    h.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
    await h.flush();
    expect(byId(h.take(), 3)).toHaveProperty('result');
    h.handle.close();
  });
});
