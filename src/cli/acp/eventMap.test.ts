/**
 * ACP eventMap — projection of the headless NDJSON event stream onto the
 * session/update subset, plus the line drainer used by the turn adapter.
 * Pure functions: the shapes asserted here are the ones the CLI emits
 * (@zelari/core/events BrainEvent, see src/cli/hooks/eventsToMessages.ts).
 */
import { describe, expect, it } from 'vitest';
import { drainLines, mapCapturedLine, mapHeadlessEvent } from './eventMap.js';

describe('acp/eventMap — mapHeadlessEvent', () => {
  it('maps a streaming text delta to an agent_message_chunk', () => {
    expect(mapHeadlessEvent({ type: 'message_delta', delta: 'hello' })).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    ]);
  });

  it('ignores an empty delta (no empty chunks on the wire)', () => {
    expect(mapHeadlessEvent({ type: 'message_delta', delta: '' })).toEqual([]);
  });

  it('maps tool_execution_start to a pending tool_call with the tool name as title', () => {
    expect(
      mapHeadlessEvent({ type: 'tool_execution_start', toolCallId: 'c9', toolName: 'read_file' }),
    ).toEqual([
      {
        sessionUpdate: 'tool_call',
        callId: 'c9',
        title: 'read_file',
        kind: 'execute',
        status: 'pending',
      },
    ]);
  });

  it('maps tool_execution_end to completed / failed', () => {
    expect(mapHeadlessEvent({ type: 'tool_execution_end', toolCallId: 'c9' })).toEqual([
      { sessionUpdate: 'tool_call_update', callId: 'c9', status: 'completed' },
    ]);
    expect(
      mapHeadlessEvent({ type: 'tool_execution_end', toolCallId: 'c9', isError: true }),
    ).toEqual([{ sessionUpdate: 'tool_call_update', callId: 'c9', status: 'failed' }]);
  });

  it('produces nothing for events outside the mapped set', () => {
    for (const event of [
      { type: 'log', message: 'x' },
      { type: 'kraken_metrics', metrics: {} },
      { type: 'session_started', sessionId: 's' },
      { type: 'verification_run' },
      { type: 'agent_end', reason: 'completed' },
    ]) {
      expect(mapHeadlessEvent(event)).toEqual([]);
    }
  });

  it('is fail-soft on junk (never throws)', () => {
    for (const junk of [null, undefined, 'nope', 7, [], { no: 'type' }, { toolCallId: 5 }]) {
      expect(mapHeadlessEvent(junk)).toEqual([]);
    }
    // Missing ids/names degrade instead of throwing.
    expect(mapHeadlessEvent({ type: 'tool_execution_start', toolCallId: 'c1' })).toEqual([
      { sessionUpdate: 'tool_call', callId: 'c1', title: 'tool', kind: 'execute', status: 'pending' },
    ]);
  });
});

describe('acp/eventMap — drainLines', () => {
  it('emits only complete lines, keeps the remainder buffered', () => {
    const buffer = { text: '{"a":1}\n{"b":' };
    const lines: string[] = [];
    drainLines(buffer, false, (l) => lines.push(l));
    expect(lines).toEqual(['{"a":1}']);
    expect(buffer.text).toBe('{"b":');
  });

  it('trims CR and skips blank lines', () => {
    const buffer = { text: '{"a":1}\r\n\n' };
    const lines: string[] = [];
    drainLines(buffer, false, (l) => lines.push(l));
    expect(lines).toEqual(['{"a":1}']);
  });

  it('flushes the trailing partial line only when asked', () => {
    const buffer = { text: 'tail' };
    const lines: string[] = [];
    drainLines(buffer, false, (l) => lines.push(l));
    expect(lines).toEqual([]);
    drainLines(buffer, true, (l) => lines.push(l));
    expect(lines).toEqual(['tail']);
    expect(buffer.text).toBe('');
  });
});

describe('acp/eventMap — mapCapturedLine', () => {
  it('projects a JSON event line', () => {
    expect(mapCapturedLine('{"type":"message_delta","delta":"ok"}')).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
    ]);
  });

  it('treats a non-JSON line as plain assistant text (never loses output)', () => {
    expect(mapCapturedLine('plain text')).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'plain text' } },
    ]);
  });
});
