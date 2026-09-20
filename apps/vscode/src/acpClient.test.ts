import { describe, expect, it } from 'vitest';
import { AcpClient } from './acpClient.js';
import {
  AcpClientClosedError,
  AcpProtocolError,
  AcpResponseError,
  type AcpCloseInfo,
  type AcpExitInfo,
  type AcpTransport,
} from './acpTransport.js';
import type { AcpSessionUpdateParams } from './protocol.js';

interface FakeTransport {
  transport: AcpTransport;
  /** Parsed frames written by the client. */
  frames(): Array<Record<string, any>>;
  feed(message: unknown): void;
  feedRaw(chunk: string): void;
  fireEnd(): void;
  fireExit(code: number | null, signal?: string | null): void;
  fireError(error: Error): void;
  fireStderr(line: string): void;
  endInputCalls(): number;
  killCalls(): number;
}

/** An in-memory duplex: no child process, no VS Code host, no network. */
function createFakeTransport(): FakeTransport {
  const written: string[] = [];
  const listeners = {
    data: [] as Array<(chunk: string) => void>,
    end: [] as Array<() => void>,
    exit: [] as Array<(code: number | null, signal: string | null) => void>,
    error: [] as Array<(error: Error) => void>,
    stderr: [] as Array<(line: string) => void>,
  };
  let endInputs = 0;
  let kills = 0;

  const transport: AcpTransport = {
    write: (chunk) => written.push(chunk),
    onData: (listener) => listeners.data.push(listener),
    onEnd: (listener) => listeners.end.push(listener),
    onExit: (listener) => listeners.exit.push(listener),
    onError: (listener) => listeners.error.push(listener),
    onStderr: (listener) => listeners.stderr.push(listener),
    endInput: () => {
      endInputs += 1;
    },
    kill: () => {
      kills += 1;
    },
  };

  return {
    transport,
    frames: () => written.map((chunk) => JSON.parse(chunk) as Record<string, any>),
    feed: (message) => {
      for (const listener of listeners.data) listener(`${JSON.stringify(message)}\n`);
    },
    feedRaw: (chunk) => {
      for (const listener of listeners.data) listener(chunk);
    },
    fireEnd: () => {
      for (const listener of listeners.end) listener();
    },
    fireExit: (code, signal = null) => {
      for (const listener of listeners.exit) listener(code, signal);
    },
    fireError: (error) => {
      for (const listener of listeners.error) listener(error);
    },
    fireStderr: (line) => {
      for (const listener of listeners.stderr) listener(line);
    },
    endInputCalls: () => endInputs,
    killCalls: () => kills,
  };
}

function createClient(): { fake: FakeTransport; client: AcpClient; log: string[] } {
  const fake = createFakeTransport();
  const log: string[] = [];
  const client = new AcpClient(fake.transport, (line) => log.push(line));
  return { fake, client, log };
}

/** Run `start()`, answer its frame with `result`, and return the promise. */
async function requestAndRespond<T>(
  fake: FakeTransport,
  start: () => Promise<T>,
  result: unknown,
): Promise<T> {
  const promise = start();
  const frame = fake.frames().at(-1);
  expect(frame).toBeDefined();
  fake.feed({ jsonrpc: '2.0', id: frame?.['id'], result });
  return await promise;
}

describe('acpClient — request/response correlation', () => {
  it('frames requests as NDJSON with server-side ids and the served method names', async () => {
    const { fake, client } = createClient();
    const init = requestAndRespond(
      fake,
      () => client.initialize(),
      { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] },
    );

    expect(fake.frames()[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 },
    });
    await expect(init).resolves.toMatchObject({ protocolVersion: 1 });
    // The handshake tail the spec expects from a client (the server ignores it).
    expect(fake.frames()[1]).toEqual({ jsonrpc: '2.0', method: 'initialized', params: {} });
    expect(fake.frames()).toHaveLength(2);
  });

  it('sends exactly the params the served subset defines (session/new, session/prompt, session/cancel)', async () => {
    const { fake, client } = createClient();

    await expect(requestAndRespond(fake, () => client.newSession('/work'), { sessionId: 's-1' })).resolves.toBe('s-1');
    expect(fake.frames()[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: '/work' },
    });

    // No cwd: the server falls back to its own --cwd / process cwd.
    await expect(requestAndRespond(fake, () => client.newSession(), { sessionId: 's-2' })).resolves.toBe('s-2');
    expect(fake.frames()[1]).toMatchObject({ method: 'session/new', params: {} });

    await expect(
      requestAndRespond(fake, () => client.prompt('s-1', 'fix the parser'), { stopReason: 'end_turn' }),
    ).resolves.toBe('end_turn');
    expect(fake.frames()[2]).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 's-1', prompt: [{ type: 'text', text: 'fix the parser' }] },
    });

    await expect(requestAndRespond(fake, () => client.cancel('s-1'), null)).resolves.toBeUndefined();
    expect(fake.frames()[3]).toMatchObject({ method: 'session/cancel', params: { sessionId: 's-1' } });
  });

  it('correlates by id, never by arrival order (one turn at a time, pipelined responses)', async () => {
    const { fake, client } = createClient();
    const first = client.request<string>('session/new', { cwd: '/a' });
    const second = client.request<string>('session/prompt', { sessionId: 's-1' });
    expect(fake.frames().map((f) => f['id'])).toEqual([1, 2]);

    fake.feed({ jsonrpc: '2.0', id: 2, result: 'second-answer' });
    await expect(second).resolves.toBe('second-answer');
    fake.feed({ jsonrpc: '2.0', id: 1, result: 'first-answer' });
    await expect(first).resolves.toBe('first-answer');
  });

  it('rejects with BOTH error codes preserved (numeric envelope + stable string code)', async () => {
    const { fake, client } = createClient();
    const promise = client.request('nope/x', {});
    fake.feed({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'method not found: nope/x', data: { code: 'method_not_found' } },
    });

    const error = await promise.then(
      () => undefined,
      (err: unknown) => err as AcpResponseError,
    );
    expect(error).toBeInstanceOf(AcpResponseError);
    expect(error?.jsonRpcCode).toBe(-32601);
    expect(error?.errorCode).toBe('method_not_found');
    expect(error?.message).toBe('method not found: nope/x');
  });

  it('validates the fields it uses and reports a protocol violation, not a silent undefined', async () => {
    const { fake, client } = createClient();
    await expect(requestAndRespond(fake, () => client.initialize(), {})).rejects.toBeInstanceOf(AcpProtocolError);
    await expect(requestAndRespond(fake, () => client.newSession('/w'), {})).rejects.toThrow('no sessionId');
    await expect(requestAndRespond(fake, () => client.prompt('s', 'x'), {})).rejects.toThrow('no stopReason');
  });
});

describe('acpClient — notification fan-out', () => {
  it('fans session/update out to every listener and contains a throwing listener', async () => {
    const { fake, client, log } = createClient();
    const seen: string[] = [];
    const params: AcpSessionUpdateParams = {
      sessionId: 's-1',
      update: { sessionUpdate: 'tool_call', callId: 'c-1', title: 'read_file', kind: 'execute', status: 'pending' },
    };
    client.on('update', () => {
      throw new Error('a broken UI callback');
    });
    client.on('update', (p) => seen.push(`${p.sessionId}:${p.update.sessionUpdate}`));

    fake.feed({ jsonrpc: '2.0', method: 'session/update', params });

    expect(seen).toEqual(['s-1:tool_call']);
    expect(log.join('\n')).toContain("listener for 'update' threw (contained)");
    expect(log.join('\n')).toContain('a broken UI callback');
  });

  it('reports malformed params as a plain notification instead of faking an update', () => {
    const { fake, client } = createClient();
    const updates: unknown[] = [];
    const others: string[] = [];
    client.on('update', (p) => updates.push(p));
    client.on('notification', (m) => others.push(m.method));

    fake.feed({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1' } });

    expect(updates).toEqual([]);
    expect(others).toEqual(['session/update']);
  });

  it('drops frames it cannot use (garbage, unknown ids, agent reverse requests) and keeps working', async () => {
    const { fake, client, log } = createClient();
    fake.feedRaw('not json at all\n');
    fake.feed({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: {} } });
    fake.feed({ jsonrpc: '2.0', id: 99, result: 'nobody asked' });
    fake.feed({ jsonrpc: '2.0', id: 42, method: 'fs/read_text_file', params: { path: '/x' } });
    fake.feedRaw('42\n');

    // The loop is intact: a real round trip still works after all of that.
    await expect(requestAndRespond(fake, () => client.initialize(), { protocolVersion: 1 })).resolves.toMatchObject({
      protocolVersion: 1,
    });
    expect(log.join('\n')).toContain('dropped a non-JSON line');
    expect(log.join('\n')).toContain('dropped a response for unknown id 99');
    expect(log.join('\n')).toContain('ignored agent request');
    expect(log.join('\n')).toContain('dropped a non-object frame');
  });

  it('delivers agent stderr lines to the UI', () => {
    const { fake, client } = createClient();
    const lines: string[] = [];
    client.on('stderr', (line) => lines.push(line));
    fake.fireStderr('[zelari-code acp] frame dropped (fail-soft)');
    expect(lines).toEqual(['[zelari-code acp] frame dropped (fail-soft)']);
  });
});

describe('acpClient — shutdown semantics', () => {
  it('shutdown(): closes stdin, rejects every pending request, emits closed exactly once', async () => {
    const { fake, client } = createClient();
    const closed: AcpCloseInfo[] = [];
    client.on('closed', (info) => closed.push(info));

    const inFlight = client.request('session/prompt', { sessionId: 's-1' });
    client.shutdown();

    await expect(inFlight).rejects.toBeInstanceOf(AcpClientClosedError);
    expect(fake.endInputCalls()).toBe(1);
    expect(fake.killCalls()).toBe(0); // graceful: EOF first, killing is the fallback
    expect(closed).toEqual([{ reason: 'shutdown', code: null, signal: null }]);
    expect(client.closed).toBe(true);

    // A real child fires `end` and `exit` after EOF: still exactly ONE terminal event.
    fake.fireEnd();
    fake.fireExit(0);
    expect(closed).toHaveLength(1);

    // And the client is inert: no new request, no new frame on the wire.
    await expect(client.request('initialize')).rejects.toBeInstanceOf(AcpClientClosedError);
    client.notify('session/cancel', { sessionId: 's-1' });
    expect(fake.frames()).toHaveLength(1);
    expect(client.closeInfo?.reason).toBe('shutdown');
  });

  it('shutdown({ kill: true }) signals the process, and kill() is idempotent', () => {
    const { fake, client } = createClient();
    client.shutdown({ kill: true });
    expect(fake.endInputCalls()).toBe(1);
    expect(fake.killCalls()).toBe(1);

    client.kill();
    client.kill();
    client.shutdown();
    expect(fake.killCalls()).toBe(1);
    expect(fake.endInputCalls()).toBe(1);
  });

  it('an agent that dies mid-turn rejects the in-flight request with the exit code', async () => {
    const { fake, client } = createClient();
    const closed: AcpCloseInfo[] = [];
    const exits: AcpExitInfo[] = [];
    client.on('closed', (info) => closed.push(info));
    client.on('exit', (info) => exits.push(info));

    const inFlight = client.request('session/prompt', { sessionId: 's-1' });
    fake.fireExit(137, 'SIGKILL');

    await expect(inFlight).rejects.toThrow('session closed (exit, code 137)');
    expect(exits).toEqual([{ code: 137, signal: 'SIGKILL' }]);
    expect(closed).toEqual([{ reason: 'exit', code: 137, signal: 'SIGKILL' }]);
  });

  it('a broken pipe closes the session once, contained, with the reason on the log', async () => {
    const { fake, client, log } = createClient();
    const closed: AcpCloseInfo[] = [];
    const inFlight = client.request('session/prompt', { sessionId: 's-1' });
    client.on('closed', (info) => closed.push(info));

    fake.fireError(new Error('EPIPE: the agent is gone'));

    await expect(inFlight).rejects.toBeInstanceOf(AcpClientClosedError);
    expect(closed).toEqual([
      { reason: 'error', code: null, signal: null, message: 'EPIPE: the agent is gone' },
    ]);
    expect(log.join('\n')).toContain('transport error: EPIPE: the agent is gone');
  });

  it('EOF salvage: a final response with no trailing newline still resolves on transport end', async () => {
    const { fake, client } = createClient();
    const pending = client.request<{ protocolVersion: number }>('initialize', {});
    fake.feedRaw('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}');
    fake.fireEnd();

    await expect(pending).resolves.toEqual({ protocolVersion: 1 });
    expect(client.closed).toBe(true);
    expect(client.closeInfo?.reason).toBe('end');
  });
});
