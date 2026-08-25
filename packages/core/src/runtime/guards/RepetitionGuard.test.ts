import { describe, expect, it } from 'vitest';
import { RepetitionGuard, toolCallFingerprint } from './RepetitionGuard.js';
import type { ToolCallEvent } from '../observers/types.js';

const identity = {
  runId: 'r1',
  agentId: 'a1',
  role: 'lead' as const,
  mode: 'kraken' as const,
};

function evt(id: string, toolName: string, args: unknown): ToolCallEvent {
  return { id, ts: 1, identity, turn: 1, toolCallId: id, toolName, args };
}

describe('toolCallFingerprint', () => {
  it('is independent of arg key order', () => {
    const a = toolCallFingerprint('bash', { command: 'npm test', cwd: '.' });
    const b = toolCallFingerprint('bash', { cwd: '.', command: 'npm test' });
    expect(a.argsHash).toBe(b.argsHash);
  });

  it('distinguishes different args', () => {
    expect(toolCallFingerprint('bash', { c: 'x' }).argsHash).not.toBe(
      toolCallFingerprint('bash', { c: 'y' }).argsHash,
    );
  });
});

describe('RepetitionGuard', () => {
  it('first identical call → continue', async () => {
    const guard = new RepetitionGuard();
    const r = await guard.onToolCall?.(evt('1', 'bash', { command: 'npm test' }));
    expect(r?.action).toBe('continue');
  });

  it('injects on the 2nd identical call by default', async () => {
    const guard = new RepetitionGuard();
    await guard.onToolCall?.(evt('1', 'bash', { command: 'npm test' }));
    const r = await guard.onToolCall?.(evt('2', 'bash', { command: 'npm test' }));
    expect(r?.action).toBe('inject');
  });

  it('stops on the 5th identical call by default', async () => {
    const guard = new RepetitionGuard();
    for (let i = 0; i < 4; i += 1) {
      await guard.onToolCall?.(evt(String(i), 'bash', { command: 'npm test' }));
    }
    const r = await guard.onToolCall?.(evt('5', 'bash', { command: 'npm test' }));
    expect(r).toMatchObject({ action: 'stop', code: 'repeated_tool' });
  });

  it('counts per-fingerprint independently', async () => {
    const guard = new RepetitionGuard();
    await guard.onToolCall?.(evt('1', 'bash', { command: 'a' }));
    await guard.onToolCall?.(evt('2', 'bash', { command: 'b' }));
    // second occurrence of {command:'a'} → inject; {command:'b'} unaffected
    const r = await guard.onToolCall?.(evt('3', 'bash', { command: 'a' }));
    expect(r?.action).toBe('inject');
  });

  it('reset clears counts', async () => {
    const guard = new RepetitionGuard();
    await guard.onToolCall?.(evt('1', 'bash', { command: 'npm test' }));
    guard.reset();
    const r = await guard.onToolCall?.(evt('2', 'bash', { command: 'npm test' }));
    expect(r?.action).toBe('continue');
  });

  it('honors custom thresholds', async () => {
    const guard = new RepetitionGuard({ warnAfter: 1, stopAfter: 3 });
    await guard.onToolCall?.(evt('1', 'bash', { command: 'x' }));
    await guard.onToolCall?.(evt('2', 'bash', { command: 'x' }));
    const r = await guard.onToolCall?.(evt('3', 'bash', { command: 'x' }));
    expect(r?.action).toBe('stop');
  });
});
