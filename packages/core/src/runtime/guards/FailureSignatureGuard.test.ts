import { describe, expect, it } from 'vitest';
import {
  FailureSignatureGuard,
  normalizeFailureTail,
  stripAnsi,
} from './FailureSignatureGuard.js';
import type {
  ToolCallEvent,
  ToolResultEvent,
} from '../observers/types.js';

const identity = {
  runId: 'r1',
  agentId: 'a1',
  role: 'lead' as const,
  mode: 'kraken' as const,
};

function callEvt(id: string, args: unknown): ToolCallEvent {
  return { id, ts: 1, identity, turn: 1, toolCallId: id, toolName: 'run_command', args };
}

function resEvt(id: string, result: unknown, ok = true): ToolResultEvent {
  return { id, ts: 2, identity, turn: 1, toolCallId: id, toolName: 'run_command', result, ok };
}

function shellResult(stdout: string, exitCode: number): unknown {
  return { stdout, stderr: '', exitCode, durationMs: 1234, shellVia: 'bash' };
}

const FAIL_BODY = [
  'FAIL auth.spec.ts',
  'Expected 200, received 401',
].join('\n');

describe('normalizeFailureTail', () => {
  it('strips ANSI escapes', () => {
    expect(stripAnsi('\u001b[31merror\u001b[0m')).toBe('error');
  });

  it('ignores volatile tokens (timestamps, durations, PIDs, UUIDs, temp paths)', () => {
    const a = normalizeFailureTail(
      '2026-08-25T12:31:07.123Z pid 4242 3.7s /tmp/xyz/log FAIL x\nExpected 200, received 401',
    );
    const b = normalizeFailureTail(
      '1999-01-01T00:00:00.000Z pid 99 0.1s /tmp/other FAIL x\nExpected 200, received 401',
    );
    expect(a).toBe(b);
  });

  it('drops pure progress/spinner/counter lines', () => {
    const out = normalizeFailureTail('✓ 12/40\n|\n3 / 4\nFAIL auth.spec.ts');
    expect(out).toBe('FAIL auth.spec.ts');
  });

  it('keeps meaningful assertion lines', () => {
    expect(normalizeFailureTail(FAIL_BODY)).toContain('Expected 200, received 401');
  });
});

describe('FailureSignatureGuard', () => {
  it('first failure → continue', async () => {
    const guard = new FailureSignatureGuard();
    await guard.onToolCall?.(callEvt('1', { command: 'npm test' }));
    const r = await guard.onToolResult?.(resEvt('1', shellResult(FAIL_BODY, 1)));
    expect(r?.action).toBe('continue');
  });

  it('injects on 2nd identical failure signature by default', async () => {
    const guard = new FailureSignatureGuard();
    for (let i = 1; i <= 2; i += 1) {
      await guard.onToolCall?.(callEvt(String(i), { command: 'npm test' }));
      await guard.onToolResult?.(resEvt(String(i), shellResult(FAIL_BODY, 1)));
    }
    // second occurrence happens inside the loop; verify via a third → still inject
    await guard.onToolCall?.(callEvt('3', { command: 'npm test' }));
    const r = await guard.onToolResult?.(resEvt('3', shellResult(FAIL_BODY, 1)));
    expect(r?.action).toBe('inject');
  });

  it('stops on the 5th identical failure by default', async () => {
    const guard = new FailureSignatureGuard();
    let last;
    for (let i = 1; i <= 5; i += 1) {
      await guard.onToolCall?.(callEvt(String(i), { command: 'npm test' }));
      last = await guard.onToolResult?.(resEvt(String(i), shellResult(FAIL_BODY, 1)));
    }
    expect(last).toMatchObject({ action: 'stop', code: 'repeated_failure' });
  });

  it('treats same error with different noise as the same signature', async () => {
    const guard = new FailureSignatureGuard();
    await guard.onToolCall?.(callEvt('1', { command: 'npm test' }));
    await guard.onToolResult?.(
      resEvt('1', shellResult(`12:31:07 4.2s\n${FAIL_BODY}`, 1)),
    );
    await guard.onToolCall?.(callEvt('2', { command: 'npm test' }));
    const r = await guard.onToolResult?.(
      resEvt('2', shellResult(`09:00:01 0.3s\n${FAIL_BODY}`, 1)),
    );
    expect(r?.action).toBe('inject');
  });

  it('a different failure text starts a new count', async () => {
    const guard = new FailureSignatureGuard();
    await guard.onToolCall?.(callEvt('1', { command: 'npm test' }));
    await guard.onToolResult?.(resEvt('1', shellResult(FAIL_BODY, 1)));
    await guard.onToolCall?.(callEvt('2', { command: 'npm test' }));
    const r = await guard.onToolResult?.(
      resEvt('2', shellResult('FAIL other.spec.ts\nTypeError: x is not a function', 1)),
    );
    expect(r?.action).toBe('continue');
  });

  it('a successful run of the same command clears its counters', async () => {
    const guard = new FailureSignatureGuard();
    for (let i = 1; i <= 2; i += 1) {
      await guard.onToolCall?.(callEvt(String(i), { command: 'npm test' }));
      await guard.onToolResult?.(resEvt(String(i), shellResult(FAIL_BODY, 1)));
    }
    await guard.onToolCall?.(callEvt('3', { command: 'npm test' }));
    await guard.onToolResult?.(resEvt('3', shellResult('all passed', 0)));
    await guard.onToolCall?.(callEvt('4', { command: 'npm test' }));
    const r = await guard.onToolResult?.(resEvt('4', shellResult(FAIL_BODY, 1)));
    expect(r?.action).toBe('continue');
  });

  it('ignores non-failing results and string failures without exit code', async () => {
    const guard = new FailureSignatureGuard();
    await guard.onToolCall?.(callEvt('1', { command: 'ls' }));
    const rOk = await guard.onToolResult?.(resEvt('1', shellResult('file a\nfile b', 0)));
    expect(rOk?.action).toBe('continue');
    // string result + ok=false (no exitCode) is still fingerprinted
    await guard.onToolCall?.(callEvt('2', { command: 'grep x' }));
    await guard.onToolResult?.(resEvt('2', 'not found', false));
    await guard.onToolCall?.(callEvt('3', { command: 'grep x' }));
    const rStr = await guard.onToolResult?.(resEvt('3', 'not found', false));
    expect(rStr?.action).toBe('inject');
  });

  it('reset clears counters and pending args', async () => {
    const guard = new FailureSignatureGuard();
    await guard.onToolCall?.(callEvt('1', { command: 'npm test' }));
    await guard.onToolResult?.(resEvt('1', shellResult(FAIL_BODY, 1)));
    guard.reset();
    await guard.onToolCall?.(callEvt('2', { command: 'npm test' }));
    const r = await guard.onToolResult?.(resEvt('2', shellResult(FAIL_BODY, 1)));
    expect(r?.action).toBe('continue');
  });

  it('honors custom thresholds', async () => {
    const guard = new FailureSignatureGuard({ warnAfter: 1, stopAfter: 3 });
    let last;
    for (let i = 1; i <= 3; i += 1) {
      await guard.onToolCall?.(callEvt(String(i), { command: 'npm test' }));
      last = await guard.onToolResult?.(resEvt(String(i), shellResult(FAIL_BODY, 1)));
    }
    expect(last).toMatchObject({ action: 'stop' });
  });
});
