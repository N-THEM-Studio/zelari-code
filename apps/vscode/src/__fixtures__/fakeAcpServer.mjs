#!/usr/bin/env node
/**
 * fakeAcpServer.mjs — a faithful mini ACP agent, for the client's tests only.
 *
 * It speaks the SAME subset as `zelari-code acp` (see src/cli/acp/protocol.ts:
 * NDJSON stdio, initialize / session/new / session/prompt / session/cancel,
 * `session/update` notifications for messages and tool calls, JSON-RPC errors
 * with a stable string code in `error.data.code`) and mirrors its shutdown
 * contract: stdin EOF -> exit 0. That lets the client's real spawn path,
 * streaming and clean shutdown be tested without a provider, a network call
 * or a built CLI.
 *
 * Env switches (all optional, default off):
 *   FAKE_ACP_STALL=1     `session/prompt` never answers (tests cancellation
 *                        and "pending requests reject on shutdown")
 *   FAKE_ACP_STDERR=1    write two stderr lines at boot (stderr wiring)
 *
 * It is NOT a test file (no .test. in the name) and is excluded from the
 * extension's tsconfig: it is an executable fixture, not a module.
 */
import { createInterface } from 'node:readline';

const NOT_HANDLED = new Set(['initialized', '$/cancelRequest']);

let sessionSeq = 0;
let callSeq = 0;
const sessions = new Map();

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

const rpcError = (id, code, message, errorCode) =>
  send({ jsonrpc: '2.0', id, error: { code, message, data: { code: errorCode } } });

const update = (sessionId, u) => notify('session/update', { sessionId, update: u });

function handle(message) {
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (NOT_HANDLED.has(method)) return;

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'number' ? params.protocolVersion : 1;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [],
      },
    });
    return;
  }

  if (method === 'session/new') {
    const sessionId = `fake-session-${++sessionSeq}`;
    sessions.set(sessionId, { cwd: typeof params.cwd === 'string' ? params.cwd : process.cwd() });
    send({ jsonrpc: '2.0', id, result: { sessionId } });
    return;
  }

  if (method === 'session/prompt') {
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      rpcError(id, -32602, `unknown session '${sessionId}'`, 'invalid_params');
      return;
    }
    const text = (Array.isArray(params.prompt) ? params.prompt : [])
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text)
      .join('');
    const callId = `fake-call-${++callSeq}`;
    update(sessionId, {
      sessionUpdate: 'tool_call',
      callId,
      title: 'echo_tool',
      kind: 'execute',
      status: 'pending',
    });
    update(sessionId, { sessionUpdate: 'tool_call_update', callId, status: 'completed' });
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `echo: ${text}` },
    });
    // The stall mode keeps the JSON-RPC loop ALIVE (as the real server does)
    // while the turn never settles: only cancel/EOF can end it.
    if (process.env.FAKE_ACP_STALL === '1') return;
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (method === 'session/cancel') {
    if (process.env.FAKE_ACP_STALL === '1') {
      // The real server settles the in-flight prompt as `cancelled`; the fake
      // answers the cancel request and lets the test observe both.
      send({ jsonrpc: '2.0', id, result: null });
      return;
    }
    send({ jsonrpc: '2.0', id, result: null });
    return;
  }

  rpcError(id, -32601, `method not found: ${method}`, 'method_not_found');
}

if (process.env.FAKE_ACP_STDERR === '1') {
  process.stderr.write('[fake-acp] boot\n[fake-acp] ready\n');
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    rpcError(null, -32700, 'parse error', 'parse_error');
    return;
  }
  if (message && typeof message === 'object' && typeof message.method === 'string') {
    handle(message);
    return;
  }
  rpcError(message?.id ?? null, -32600, 'invalid request', 'invalid_request');
});
// stdin EOF: the clean-shutdown signal. Exit 0, like `zelari-code acp`.
input.on('close', () => {
  process.exit(0);
});
