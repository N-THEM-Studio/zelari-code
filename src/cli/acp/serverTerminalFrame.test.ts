/**
 * acp/server — the three terminal-frame invariants at the TRANSPORT level.
 *
 * Complements serverPrompt.test.ts (which owns the existing semantics): here
 * we assert that a turn's stream terminates EXACTLY once, that nothing is
 * emitted after it, that a clamped payload is always disclosed, and that every
 * error frame carries a stable string code. Dispatchers are fakes — no
 * provider, no network.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createMessageParser, encodeMessage } from './framing.js';
import { startAcpServer } from './server.js';
import { ACP_ERROR_CODES, agentMessageChunk, type SessionUpdate } from './protocol.js';
import { ACP_PAYLOAD_MAX_CHARS } from './invariants.js';
import type { AcpTurnDispatcher, AcpTurnResult } from './turnAdapter.js';

type Msg = Record<string, any>;

function createHarness(dispatcher: AcpTurnDispatcher) {
  const input = new PassThrough();
  const written: string[] = [];
  const logs: string[] = [];
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
  });
  const parser = createMessageParser();
  let consumed = 0;
  return {
    handle,
    logs,
    send: (message: unknown): void => input.write(encodeMessage(message)),
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

function responsesFor(messages: Msg[], id: number): Msg[] {
  return messages.filter((m) => m?.['id'] === id);
}

function updatesOf(messages: Msg[]): Msg[] {
  return messages.filter((m) => m?.['method'] === 'session/update');
}

async function openSession(h: ReturnType<typeof createHarness>): Promise<string> {
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
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

const okTurn =
  (exitCode = 0): AcpTurnDispatcher =>
  async () => ({ stopReason: exitCode === 0 ? 'end_turn' : 'refusal', exitCode });

describe('acp/server — invariant 1: exactly one terminal frame per turn', () => {
  it('answers one prompt with one response, and two prompts with two', async () => {
    const h = createHarness(okTurn());
    const sessionId = await openSession(h);
    prompt(h, 10, sessionId, 'one');
    await h.flush();
    prompt(h, 11, sessionId, 'two');
    await h.flush();
    const messages = h.take();
    expect(responsesFor(messages, 10)).toHaveLength(1);
    expect(responsesFor(messages, 11)).toHaveLength(1);
    expect(byId(messages, 10)?.['result']).toEqual({ stopReason: 'end_turn' });
    h.handle.close();
  });

  it('drops (and logs) an update that arrives AFTER the terminal frame', async () => {
    let late: (() => void) | undefined;
    const h = createHarness(async (request) => {
      late = () => request.onUpdate(agentMessageChunk('too late'));
      return { stopReason: 'end_turn', exitCode: 0 };
    });
    const sessionId = await openSession(h);
    prompt(h, 20, sessionId, 'quick');
    await h.flush();
    expect(byId(h.take(), 20)?.['result']).toEqual({ stopReason: 'end_turn' });

    late?.();
    await h.flush();
    expect(updatesOf(h.take())).toEqual([]); // the stream is already closed
    expect(h.logs.some((l) => l.includes('after the terminal'))).toBe(true);
    expect(h.logs.some((l) => l.includes(ACP_ERROR_CODES.PROTOCOL_ERROR))).toBe(true);
    h.handle.close();
  });

  it('settles a turn whose dispatcher throws SYNCHRONOUSLY, and un-wedges the session', async () => {
    const syncThrow = (() => {
      throw new Error('sync boom');
    }) as unknown as AcpTurnDispatcher;
    const h = createHarness(syncThrow);
    const sessionId = await openSession(h);
    prompt(h, 30, sessionId, 'x');
    await h.flush();
    const first = h.take();
    expect(responsesFor(first, 30)).toHaveLength(1); // exactly one terminal frame
    expect(byId(first, 30)?.['result']).toEqual({ stopReason: 'refusal' });
    expect(h.logs.some((l) => l.includes(ACP_ERROR_CODES.TURN_FAILED) && l.includes('sync boom'))).toBe(true);

    // The turn is over for real: the session accepts the next prompt instead of
    // answering -32602 'already has a prompt in flight' forever.
    prompt(h, 31, sessionId, 'y');
    await h.flush();
    expect(byId(h.take(), 31)?.['result']).toEqual({ stopReason: 'refusal' });
    h.handle.close();
  });

  it('a cancel-then-resolve race still yields exactly one terminal frame', async () => {
    let release: ((r: AcpTurnResult) => void) | undefined;
    const h = createHarness(
      () =>
        new Promise<AcpTurnResult>((resolve) => {
          release = resolve;
        }),
    );
    const sessionId = await openSession(h);
    prompt(h, 40, sessionId, 'long');
    await h.flush();
    h.take();
    h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    await h.flush();
    expect(byId(h.take(), 40)?.['result']).toEqual({ stopReason: 'cancelled' });

    release?.({ stopReason: 'end_turn', exitCode: 0 });
    await h.flush();
    expect(responsesFor(h.take(), 40)).toEqual([]); // the late result is not a second frame
    h.handle.close();
  });
});

describe('acp/server — invariant 2: truncated payloads are disclosed', () => {
  it('flags a clamped chunk instead of silently cutting it', async () => {
    let huge = '';
    const h = createHarness(async (request) => {
      huge = 'x'.repeat(ACP_PAYLOAD_MAX_CHARS + 512);
      request.onUpdate(agentMessageChunk(huge));
      return { stopReason: 'end_turn', exitCode: 0 };
    });
    const sessionId = await openSession(h);
    prompt(h, 50, sessionId, 'big');
    await h.flush();
    const updates = updatesOf(h.take());
    expect(updates).toHaveLength(1);
    const update = updates[0]!['params']['update'] as SessionUpdate & { truncated?: boolean };
    expect(update.truncated).toBe(true);
    expect((update as { content: { text: string } }).content.text).toHaveLength(
      ACP_PAYLOAD_MAX_CHARS,
    );
    expect((update as { content: { text: string } }).content.text.length).toBeLessThan(
      huge.length,
    );
    h.handle.close();
  });

  it('drops (and logs) a hand-built over-cap payload with no truncated flag', async () => {
    const h = createHarness(async (request) => {
      request.onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'z'.repeat(ACP_PAYLOAD_MAX_CHARS + 1) },
      });
      return { stopReason: 'end_turn', exitCode: 0 };
    });
    const sessionId = await openSession(h);
    prompt(h, 51, sessionId, 'sneaky');
    await h.flush();
    const messages = h.take();
    expect(updatesOf(messages)).toEqual([]); // never reached the wire
    expect(h.logs.some((l) => l.includes(ACP_ERROR_CODES.TRUNCATED_PAYLOAD))).toBe(true);
    expect(byId(messages, 51)?.['result']).toEqual({ stopReason: 'end_turn' }); // turn still answered
    h.handle.close();
  });
});

describe('acp/server — invariant 3: stable string codes on error frames', () => {
  it('carries the numeric AND the stable string code, per failure class', async () => {
    const h = createHarness(okTurn());
    const sessionId = await openSession(h);

    h.send({ jsonrpc: '1.0', id: 60, method: 'initialize' }); // invalid request
    h.send({ jsonrpc: '2.0', id: 61, method: 'session/load', params: {} }); // unknown method
    h.send({
      jsonrpc: '2.0',
      id: 62,
      method: 'session/prompt',
      params: { sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] },
    }); // invalid params
    await h.flush();
    const messages = h.take();
    expect(byId(messages, 60)?.['error']).toMatchObject({
      code: -32600,
      data: { code: ACP_ERROR_CODES.INVALID_REQUEST },
    });
    expect(byId(messages, 61)?.['error']).toMatchObject({
      code: -32601,
      data: { code: ACP_ERROR_CODES.METHOD_NOT_FOUND },
    });
    expect(byId(messages, 62)?.['error']).toMatchObject({
      code: -32602,
      data: { code: ACP_ERROR_CODES.INVALID_PARAMS },
    });
    // Never an ad-hoc message used as a code, never a number as the code.
    for (const id of [60, 61, 62]) {
      const code = byId(messages, id)?.['error']?.['data']?.['code'];
      expect(typeof code).toBe('string');
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(sessionId.length).toBeGreaterThan(0);
    h.handle.close();
  });
});
