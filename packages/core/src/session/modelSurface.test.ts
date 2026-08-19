import { describe, expect, it } from 'vitest';
import { deriveMessages, isModelSurfaceEvent, pairToolCalls } from './modelSurface.js';
import type { SessionEventEnvelope, SessionEventKind } from './types.js';

function e(seq: number, kind: SessionEventKind, data: Record<string, unknown>): SessionEventEnvelope {
  return { schemaVersion: 1, sessionId: 's', seq, ts: seq, kind, actor: { type: 'agent' }, data };
}

describe('isModelSurfaceEvent', () => {
  it('accepts only surface kinds', () => {
    expect(isModelSurfaceEvent({ kind: 'user.message' })).toBe(true);
    expect(isModelSurfaceEvent({ kind: 'tool.result' })).toBe(true);
    expect(isModelSurfaceEvent({ kind: 'session.compacted' })).toBe(true);
    expect(isModelSurfaceEvent({ kind: 'verification.run' })).toBe(false);
    expect(isModelSurfaceEvent({ kind: 'note' })).toBe(false);
    expect(isModelSurfaceEvent({ kind: 'mission.phase' })).toBe(false);
  });
});

describe('deriveMessages', () => {
  const events = [
    e(1, 'session.started', {}),
    e(2, 'user.message', { text: 'fix the bug' }),
    e(3, 'assistant.message', { text: 'on it' }),
    e(4, 'tool.call', { callId: 'c1', tool: 'bash', args: { command: 'npm test' } }),
    e(5, 'tool.result', { callId: 'c1', tool: 'bash', ok: false, output: '1 failed' }),
    e(6, 'note', { text: 'internal note — NOT model-visible' }),
    e(7, 'session.compacted', { summary: 'early turns compacted' }),
  ];

  it('projects only surface events, with provenance seq', () => {
    const messages = deriveMessages(events);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'system']);
    expect(messages.map((m) => m.seq)).toEqual([2, 3, 5, 7]);
    expect(messages[2]).toMatchObject({ toolCallId: 'c1', toolName: 'bash', isError: true, content: '1 failed' });
  });

  it('includeToolCalls emits tool.call as assistant messages', () => {
    const messages = deriveMessages(events, { includeToolCalls: true });
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'tool', 'system']);
  });
});

describe('pairToolCalls', () => {
  it('pairs calls with results by callId and leaves orphans unpaired', () => {
    const events = [
      e(1, 'tool.call', { callId: 'a', tool: 'bash' }),
      e(2, 'tool.call', { callId: 'b', tool: 'read_file' }),
      e(3, 'tool.result', { callId: 'a', ok: true, output: 'ok' }),
    ];
    const pairs = pairToolCalls(events);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.result?.seq).toBe(3);
    expect(pairs[1]?.result).toBeUndefined();
  });
});
