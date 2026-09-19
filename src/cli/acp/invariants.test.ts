/**
 * acp/invariants — the three terminal-frame invariants, at the unit level.
 *
 * The guards are pure and must THROW (the transport catches and logs); the
 * server-level behaviour is covered by serverTerminalFrame.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  ACP_ERROR_CODES,
  ACP_PAYLOAD_MAX_CHARS,
  AcpInvariantViolation,
  TurnStreamTracker,
  assertTruncationDisclosed,
  clampMessageText,
  createTurnStream,
  terminalUpdateKind,
} from './invariants.js';
import {
  ACP_ERROR_CODES as REEXPORTED_CODES,
  errorCodeForJsonRpc,
  JSON_RPC_ERRORS,
  agentMessageChunk,
  type SessionUpdate,
} from './protocol.js';

const chunk = (text: string): SessionUpdate => agentMessageChunk(text);

describe('acp/invariants — invariant 3: stable string error codes', () => {
  it('are non-empty snake_case strings, unique, and re-exported by protocol.ts', () => {
    const codes = Object.values(ACP_ERROR_CODES);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(new Set(codes).size).toBe(codes.length);
    expect(REEXPORTED_CODES).toEqual(ACP_ERROR_CODES);
  });

  it('map every numeric JSON-RPC code to its string code (default: internal)', () => {
    expect(errorCodeForJsonRpc(JSON_RPC_ERRORS.PARSE_ERROR)).toBe(ACP_ERROR_CODES.PARSE_ERROR);
    expect(errorCodeForJsonRpc(JSON_RPC_ERRORS.INVALID_REQUEST)).toBe(
      ACP_ERROR_CODES.INVALID_REQUEST,
    );
    expect(errorCodeForJsonRpc(JSON_RPC_ERRORS.METHOD_NOT_FOUND)).toBe(
      ACP_ERROR_CODES.METHOD_NOT_FOUND,
    );
    expect(errorCodeForJsonRpc(JSON_RPC_ERRORS.INVALID_PARAMS)).toBe(
      ACP_ERROR_CODES.INVALID_PARAMS,
    );
    expect(errorCodeForJsonRpc(JSON_RPC_ERRORS.INTERNAL_ERROR)).toBe(
      ACP_ERROR_CODES.INTERNAL_ERROR,
    );
    expect(errorCodeForJsonRpc(0)).toBe(ACP_ERROR_CODES.INTERNAL_ERROR);
  });
});

describe('acp/invariants — invariant 2: no silent truncation', () => {
  it('clamps only over-cap text, and says so', () => {
    expect(clampMessageText('short')).toEqual({ text: 'short', truncated: false });
    const long = 'x'.repeat(ACP_PAYLOAD_MAX_CHARS + 10);
    const clamped = clampMessageText(long);
    expect(clamped.truncated).toBe(true);
    expect(clamped.text).toHaveLength(ACP_PAYLOAD_MAX_CHARS);
    expect(clampMessageText('abc', 3)).toEqual({ text: 'abc', truncated: false });
    expect(clampMessageText('abcd', 3)).toEqual({ text: 'abc', truncated: true });
  });

  it('the chunk factory flags its own clamp (a truncated frame is never silent)', () => {
    const short = agentMessageChunk('hi');
    expect(short).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
    expect('truncated' in short).toBe(false);

    const long = agentMessageChunk('y'.repeat(ACP_PAYLOAD_MAX_CHARS + 1));
    expect(long.truncated).toBe(true);
    expect(long.content.text).toHaveLength(ACP_PAYLOAD_MAX_CHARS);
  });

  it('passes an honest payload and fails a hand-built over-cap one', () => {
    expect(() => assertTruncationDisclosed(chunk('fine'))).not.toThrow();
    expect(() => assertTruncationDisclosed(chunk('z'.repeat(ACP_PAYLOAD_MAX_CHARS)))).not.toThrow();
    // A factory call can never fail the guard: the clamp already flipped the
    // flag, and the text now sits exactly AT the cap.
    expect(() =>
      assertTruncationDisclosed(chunk('z'.repeat(ACP_PAYLOAD_MAX_CHARS + 1))),
    ).not.toThrow();

    // Hand-built (bypassing the factory) without the flag: the guard's reason to exist.
    const sneak: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'z'.repeat(ACP_PAYLOAD_MAX_CHARS + 1) },
    };
    try {
      assertTruncationDisclosed(sneak);
      throw new Error('expected a truncated_payload violation');
    } catch (err) {
      expect(err).toBeInstanceOf(AcpInvariantViolation);
      expect((err as AcpInvariantViolation).invariant).toBe('truncated_payload');
      expect((err as AcpInvariantViolation).errorCode).toBe(ACP_ERROR_CODES.TRUNCATED_PAYLOAD);
    }
    // Over-cap but DISCLOSED is legal (a producer may pre-clamp and say so).
    expect(() =>
      assertTruncationDisclosed({ ...sneak, truncated: true } as unknown as SessionUpdate),
    ).not.toThrow();
  });
});

describe('acp/invariants — invariant 1: terminal frame uniqueness', () => {
  it('records frames, then refuses any frame after the terminal one', () => {
    const tracker = new TurnStreamTracker('s1');
    expect(tracker.terminated).toBe(false);
    expect(tracker.push(chunk('a'))).toBeNull();
    expect(tracker.frames).toBe(1);
    tracker.terminate('end_turn');
    expect(tracker.terminated).toBe(true);
    expect(tracker.terminalKind).toBe('end_turn');

    try {
      tracker.push(chunk('b'));
      throw new Error('expected a post_terminal_frame violation');
    } catch (err) {
      expect((err as AcpInvariantViolation).invariant).toBe('post_terminal_frame');
      expect((err as AcpInvariantViolation).errorCode).toBe(ACP_ERROR_CODES.PROTOCOL_ERROR);
    }
    expect(tracker.frames).toBe(1); // the refused frame was never recorded
  });

  it('refuses a second terminal frame for the same turn', () => {
    const tracker = new TurnStreamTracker('s1');
    tracker.terminate('cancelled');
    try {
      tracker.terminate('end_turn');
      throw new Error('expected a double_terminal violation');
    } catch (err) {
      expect((err as AcpInvariantViolation).invariant).toBe('double_terminal');
    }
  });

  it('fails loudly when the stream closes with no terminal frame', () => {
    const tracker = new TurnStreamTracker('s1');
    tracker.push(chunk('partial'));
    try {
      tracker.assertTerminated();
      throw new Error('expected a missing_terminal violation');
    } catch (err) {
      expect((err as AcpInvariantViolation).invariant).toBe('missing_terminal');
    }
    tracker.terminate('refusal');
    expect(tracker.assertTerminated()).toBe('refusal');
  });

  it('treats an input_required update as terminal (nothing follows it)', () => {
    expect(terminalUpdateKind({ sessionUpdate: 'input_required' })).toBe('input_required');
    expect(terminalUpdateKind({ sessionUpdate: 'agent_message_chunk' })).toBeNull();
    expect(terminalUpdateKind({})).toBeNull();

    const tracker = new TurnStreamTracker('s1');
    expect(tracker.push({ sessionUpdate: 'input_required' } as SessionUpdate)).toBe(
      'input_required',
    );
    expect(tracker.terminated).toBe(true);
    // The response that would follow it is a SECOND terminal frame: refused.
    expect(() => tracker.terminate('end_turn')).toThrow(AcpInvariantViolation);
  });
});

describe('acp/invariants — createTurnStream (the server-facing policy)', () => {
  it('logs + drops violations instead of throwing into the transport', () => {
    const logs: string[] = [];
    const stream = createTurnStream('s1', (line) => logs.push(line));
    expect(stream.push(chunk('a'))).toBe(true);
    expect(stream.terminate('end_turn')).toBe(true);
    expect(stream.terminate('refusal')).toBe(false); // double terminal refused
    expect(stream.push(chunk('b'))).toBe(false); // nothing after the terminal
    expect(logs.filter((l) => l.includes(ACP_ERROR_CODES.PROTOCOL_ERROR))).toHaveLength(2);
    expect(logs.every((l) => l.includes('[zelari-code acp]'))).toBe(true);
    stream.close(); // terminated: nothing to report
    expect(logs).toHaveLength(2);
  });

  it('reports a stream that closes without a terminal frame', () => {
    const logs: string[] = [];
    const stream = createTurnStream('s1', (line) => logs.push(line));
    stream.push(chunk('a'));
    stream.close();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('missing_terminal');
  });
});
