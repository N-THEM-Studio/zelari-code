/**
 * Unit tests — ATIF v0.1 export (A4: trajectory interchange format).
 *
 * Tests the pure conversion from session spine events to ATIF trajectory.
 */
import { describe, expect, it } from 'vitest';
import {
  exportAtif,
  ATIF_VERSION,
  type AtifTrajectory,
} from './exportAtif.js';
import type { SessionEventEnvelope } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function envelope(
  kind: string,
  data: Record<string, unknown>,
  seq: number,
  ts = 1000 + seq,
  sessionId = 'test-session',
): SessionEventEnvelope {
  return {
    schemaVersion: 1,
    sessionId,
    seq,
    ts,
    kind: kind as SessionEventEnvelope['kind'],
    actor: { type: 'agent' },
    data,
  } as SessionEventEnvelope;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('exportAtif', () => {
  it('produces a valid ATIF v0.1 document from a minimal session', () => {
    const events = [
      envelope('session.started', { reason: 'host-bootstrap' }, 1),
      envelope('user.message', { text: 'Fix the bug' }, 2),
      envelope('assistant.message', { text: 'I will fix it.' }, 3),
      envelope('session.ended', { reason: 'completed' }, 4),
    ];

    const atif = exportAtif(events, [], { agent: 'test', agentVersion: '1.0.0' });

    expect(atif.atifVersion).toBe(ATIF_VERSION);
    expect(atif.metadata.agent).toBe('test');
    expect(atif.metadata.agentVersion).toBe('1.0.0');
    expect(atif.metadata.sessionId).toBe('test-session');
    expect(atif.metadata.totalSteps).toBe(2);
    expect(atif.metadata.userMessages).toBe(1);
    expect(atif.metadata.assistantMessages).toBe(1);
    expect(atif.metadata.toolCalls).toBe(0);
    expect(atif.metadata.startedAt).toBe(1001);
    expect(atif.metadata.endedAt).toBe(1004);
  });

  it('maps tool.call + tool.result to ATIF steps', () => {
    const events = [
      envelope('session.started', {}, 1),
      envelope('tool.call', { callId: 'c1', tool: 'bash', args: { command: 'ls' } }, 2),
      envelope('tool.result', { callId: 'c1', output: 'file.txt', ok: true, durationMs: 150 }, 3),
      envelope('session.ended', {}, 4),
    ];

    const atif = exportAtif(events);

    expect(atif.steps).toHaveLength(2);
    expect(atif.steps[0]).toMatchObject({
      index: 0,
      type: 'tool_call',
      tool: 'bash',
      callId: 'c1',
      input: { command: 'ls' },
    });
    expect(atif.steps[1]).toMatchObject({
      index: 1,
      type: 'tool_result',
      tool: 'bash',
      callId: 'c1',
      output: 'file.txt',
      outputTruncated: false,
      durationMs: 150,
      isError: false,
    });
    expect(atif.metadata.toolCalls).toBe(1);
    expect(atif.metadata.toolResults).toBe(1);
  });

  it('truncates long tool output and sets outputTruncated flag', () => {
    const longOutput = 'x'.repeat(20000);
    const events = [
      envelope('tool.call', { callId: 'c1', tool: 'bash', args: {} }, 1),
      envelope('tool.result', { callId: 'c1', output: longOutput, ok: true }, 2),
    ];

    const atif = exportAtif(events, [], { maxOutputLength: 100 });

    const resultStep = atif.steps[1] as Extract<typeof atif.steps[number], { type: 'tool_result' }>;
    expect(resultStep.output).toHaveLength(100);
    expect(resultStep.outputTruncated).toBe(true);
  });

  it('preserves short output without truncation', () => {
    const events = [
      envelope('tool.call', { callId: 'c1', tool: 'bash', args: {} }, 1),
      envelope('tool.result', { callId: 'c1', output: 'short', ok: true }, 2),
    ];

    const atif = exportAtif(events, [], { maxOutputLength: 100 });

    const resultStep = atif.steps[1] as Extract<typeof atif.steps[number], { type: 'tool_result' }>;
    expect(resultStep.output).toBe('short');
    expect(resultStep.outputTruncated).toBe(false);
  });

  it('marks errored tool results', () => {
    const events = [
      envelope('tool.call', { callId: 'c1', tool: 'write', args: {} }, 1),
      envelope('tool.result', { callId: 'c1', output: 'permission denied', ok: false }, 2),
    ];

    const atif = exportAtif(events);

    const resultStep = atif.steps[1] as Extract<typeof atif.steps[number], { type: 'tool_result' }>;
    expect(resultStep.isError).toBe(true);
  });

  it('attributes tool name from call when result lacks it', () => {
    const events = [
      envelope('tool.call', { callId: 'c1', tool: 'bash', args: {} }, 1),
      envelope('tool.result', { callId: 'c1', output: 'ok', ok: true }, 2),
    ];

    const atif = exportAtif(events);

    const resultStep = atif.steps[1] as Extract<typeof atif.steps[number], { type: 'tool_result' }>;
    expect(resultStep.tool).toBe('bash');
  });

  it('extracts model/provider from harness_manifest', () => {
    const events = [
      envelope('session.started', {}, 1),
      envelope('session.harness_manifest', {
        manifest: { model: 'deepseek-chat', provider: 'deepseek' },
        manifestHash: 'abc',
      }, 2),
      envelope('session.ended', {}, 3),
    ];

    const atif = exportAtif(events);

    expect(atif.metadata.model).toBe('deepseek-chat');
    expect(atif.metadata.provider).toBe('deepseek');
  });

  it('counts issues from replay report', () => {
    const events = [envelope('session.started', {}, 1)];
    const issues = [{ type: 'corrupt-line' }, { type: 'seq-gap' }];

    const atif = exportAtif(events, issues);

    expect(atif.metadata.issues).toBe(2);
  });

  it('handles empty session gracefully', () => {
    const atif = exportAtif([], []);

    expect(atif.atifVersion).toBe(ATIF_VERSION);
    expect(atif.steps).toHaveLength(0);
    expect(atif.metadata.totalSteps).toBe(0);
    expect(atif.metadata.sessionId).toBe('');
  });

  it('maintains step ordering by seq', () => {
    const events = [
      envelope('session.started', {}, 1),
      envelope('user.message', { text: 'first' }, 2),
      envelope('tool.call', { callId: 'c1', tool: 'bash', args: {} }, 3),
      envelope('tool.result', { callId: 'c1', output: 'ok', ok: true }, 4),
      envelope('assistant.message', { text: 'done' }, 5),
      envelope('session.ended', {}, 6),
    ];

    const atif = exportAtif(events);

    expect(atif.steps.map((s) => s.type)).toEqual([
      'user_message',
      'tool_call',
      'tool_result',
      'assistant_message',
    ]);
    // Indices are sequential
    atif.steps.forEach((s, i) => expect(s.index).toBe(i));
  });

  it('round-trip: export preserves all observable content', () => {
    const events = [
      envelope('session.started', {}, 1, 1000),
      envelope('user.message', { text: 'What is 2+2?' }, 2, 1001),
      envelope('tool.call', { callId: 'c1', tool: 'bash', args: { command: 'echo 4' } }, 3, 1002),
      envelope('tool.result', { callId: 'c1', output: '4', ok: true, durationMs: 10 }, 4, 1003),
      envelope('assistant.message', { text: 'The answer is 4.' }, 5, 1004),
      envelope('session.ended', { reason: 'completed' }, 6, 1005),
    ];

    const atif = exportAtif(events, [], {
      agent: 'zelari-code',
      agentVersion: '2.61.0',
    });

    // Metadata
    expect(atif.metadata.sessionId).toBe('test-session');
    expect(atif.metadata.startedAt).toBe(1000);
    expect(atif.metadata.endedAt).toBe(1005);
    expect(atif.metadata.totalSteps).toBe(4);
    expect(atif.metadata.userMessages).toBe(1);
    expect(atif.metadata.toolCalls).toBe(1);
    expect(atif.metadata.toolResults).toBe(1);
    expect(atif.metadata.assistantMessages).toBe(1);

    // Steps content
    const [user, call, result, assistant] = atif.steps;
    expect(user).toMatchObject({ type: 'user_message', content: 'What is 2+2?' });
    expect(call).toMatchObject({ type: 'tool_call', tool: 'bash', callId: 'c1' });
    expect(result).toMatchObject({ type: 'tool_result', output: '4', callId: 'c1' });
    expect(assistant).toMatchObject({ type: 'assistant_message', content: 'The answer is 4.' });

    // Every step has a timestamp
    for (const step of atif.steps) {
      expect(step.ts).toBeGreaterThan(0);
    }
  });
});
