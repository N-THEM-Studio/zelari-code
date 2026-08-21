import { describe, expect, it } from 'vitest';
import { classifyInterruptedTools, interruptedEventData } from './recovery.js';
import type { SessionEventEnvelope } from './types.js';

function ev(
  seq: number,
  kind: SessionEventEnvelope['kind'],
  data: Record<string, unknown>,
): SessionEventEnvelope {
  return {
    schemaVersion: 1,
    sessionId: 's',
    seq,
    ts: seq,
    kind,
    actor: { type: 'agent' },
    data,
  };
}

describe('classifyInterruptedTools', () => {
  it('read-only dangling calls are retry-safe / not-started', () => {
    const [item] = classifyInterruptedTools([
      ev(1, 'tool.call', { callId: 'r1', tool: 'read_file' }),
    ]);
    expect(item).toMatchObject({
      tool: 'read_file',
      state: 'not-started',
      retrySafety: 'safe',
      sideEffect: 'none',
    });
  });

  it('write/bash dangling calls are inspect-first', () => {
    const items = classifyInterruptedTools([
      ev(1, 'tool.call', { callId: 'w1', tool: 'write_file' }),
      ev(2, 'tool.call', { callId: 'b1', tool: 'bash' }),
      ev(3, 'tool.result', { callId: 'b1', ok: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      tool: 'write_file',
      callId: 'w1',
      state: 'started-outcome-unknown',
      retrySafety: 'inspect-first',
      sideEffect: 'local',
    });
  });

  it('already-classified dangling calls are skipped', () => {
    expect(
      classifyInterruptedTools([
        ev(1, 'tool.call', { callId: 'w1', tool: 'write_file' }),
        ev(2, 'tool.interrupted', { callId: 'w1', state: 'started-outcome-unknown' }),
      ]),
    ).toEqual([]);
  });

  it('paired calls are not interrupted', () => {
    expect(
      classifyInterruptedTools([
        ev(1, 'tool.call', { callId: 'c1', tool: 'edit_file' }),
        ev(2, 'tool.result', { callId: 'c1', ok: true }),
      ]),
    ).toEqual([]);
  });

  it('interruptedEventData is a tool.interrupted payload', () => {
    const [item] = classifyInterruptedTools([
      ev(4, 'tool.call', { callId: 'x', tool: 'apply_diff' }),
    ]);
    expect(interruptedEventData(item!)).toEqual({
      toolCallSeq: 4,
      callId: 'x',
      tool: 'apply_diff',
      state: 'started-outcome-unknown',
      retrySafety: 'inspect-first',
      sideEffect: 'local',
    });
  });
});
