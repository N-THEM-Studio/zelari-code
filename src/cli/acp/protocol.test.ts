/**
 * ACP protocol layer — JSON-RPC classification, param validation (-32602
 * factories), error codes (-32601 is a server concern) and the outbound
 * session/update subset. Pure functions, no I/O.
 */
import { describe, expect, it } from 'vitest';
import {
  ACP_PROTOCOL_VERSION,
  AcpError,
  JSON_RPC_ERRORS,
  agentMessageChunk,
  invalidParams,
  parseJsonRpcMessage,
  readInitializeParams,
  readPromptParams,
  readSessionIdParams,
  readSessionNewParams,
  sessionUpdateNotification,
  toolCallStart,
  toolCallStatus,
} from './protocol.js';

describe('acp/protocol — message classification', () => {
  it('recognises a request with an id', () => {
    const parsed = parseJsonRpcMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/new',
      params: { cwd: '/tmp' },
    });
    expect(parsed.kind).toBe('request');
    if (parsed.kind !== 'request') return;
    expect(parsed.request).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/new',
      params: { cwd: '/tmp' },
    });
  });

  it('recognises a notification (no id) and keeps params optional', () => {
    expect(parseJsonRpcMessage({ jsonrpc: '2.0', method: 'initialized' })).toEqual({
      kind: 'notification',
      notification: { jsonrpc: '2.0', method: 'initialized' },
    });
  });

  it('rejects non-objects, arrays, a bad jsonrpc field and a bad method', () => {
    for (const bad of ['x', 42, null, [], { jsonrpc: '1.0', method: 'm' }, { id: 1 }]) {
      const parsed = parseJsonRpcMessage(bad);
      expect(parsed.kind).toBe('invalid');
    }
  });

  it('rejects a non-scalar id', () => {
    const parsed = parseJsonRpcMessage({ jsonrpc: '2.0', id: {}, method: 'm' });
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') expect(parsed.reason).toContain('id must be');
  });
});

describe('acp/protocol — param readers', () => {
  it('initialize: defaults the version, rejects a non-number', () => {
    expect(readInitializeParams(undefined)).toEqual({ protocolVersion: ACP_PROTOCOL_VERSION });
    expect(readInitializeParams({ protocolVersion: 1 })).toEqual({ protocolVersion: 1 });
    expect(() => readInitializeParams({ protocolVersion: 'v1' })).toThrow(AcpError);
  });

  it('session/new: client cwd wins, CLI fallback fills an omitted one', () => {
    expect(readSessionNewParams({ cwd: '/work' }, '/fallback')).toEqual({ cwd: '/work' });
    expect(readSessionNewParams({}, '/fallback')).toEqual({ cwd: '/fallback' });
    expect(() => readSessionNewParams({}, undefined)).toThrow(/cwd/);
    expect(() => readSessionNewParams({ cwd: '   ' })).toThrow(/cwd/);
  });

  it('session/prompt: concatenates text blocks, skips other block types', () => {
    expect(
      readPromptParams({
        sessionId: 's1',
        prompt: [
          { type: 'text', text: 'fix ' },
          { type: 'image', data: 'zzz' },
          { type: 'text', text: 'the bug' },
        ],
      }),
    ).toEqual({ sessionId: 's1', text: 'fix the bug' });
  });

  it('session/prompt: absent sessionId / prompt / text all fail as params', () => {
    expect(() => readPromptParams({ prompt: [{ type: 'text', text: 'x' }] })).toThrow(/sessionId/);
    expect(() => readPromptParams({ sessionId: 's1' })).toThrow(/content-block array/);
    expect(() => readPromptParams({ sessionId: 's1', prompt: [] })).toThrow(/text block/);
    expect(() =>
      readPromptParams({ sessionId: 's1', prompt: [{ type: 'text', text: '  ' }] }),
    ).toThrow(/text block/);
  });

  it('session-scoped reader names the method in the error', () => {
    expect(readSessionIdParams({ sessionId: 's' }, 'session/cancel')).toEqual({ sessionId: 's' });
    expect(() => readSessionIdParams({}, 'session/cancel')).toThrow(/session\/cancel/);
  });

  it('every param failure carries -32602', () => {
    expect(invalidParams('nope')).toBeInstanceOf(AcpError);
    expect(invalidParams('nope').code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
    try {
      readSessionNewParams({});
    } catch (err) {
      expect((err as AcpError).code).toBe(-32602);
    }
  });
});

describe('acp/protocol — outbound session/update subset', () => {
  it('agent_message_chunk carries a text content block', () => {
    expect(agentMessageChunk('hi')).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
  });

  it('tool_call is pending by default, kind execute; tool_call_update only moves status', () => {
    expect(toolCallStart({ callId: 'c1', title: 'read_file' })).toEqual({
      sessionUpdate: 'tool_call',
      callId: 'c1',
      title: 'read_file',
      kind: 'execute',
      status: 'pending',
    });
    expect(toolCallStatus({ callId: 'c1', status: 'completed' })).toEqual({
      sessionUpdate: 'tool_call_update',
      callId: 'c1',
      status: 'completed',
    });
  });

  it('wraps an update into a session/update notification scoped to the session', () => {
    expect(sessionUpdateNotification('sess', agentMessageChunk('yo'))).toEqual({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yo' } },
      },
    });
  });
});
