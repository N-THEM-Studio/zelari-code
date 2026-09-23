/**
 * verificationBridge.verificationFailed — K5.3 / F32: the `VerificationFailed`
 * lifecycle hook on strict-done BLOCKED.
 *
 * Locks:
 * - the hook fires EXACTLY when the strict-done gate blocks, with the small
 *   { criteria, reason } payload (blocking criterion ids + truncated summary);
 * - it does NOT fire on a strict PASS;
 * - the "nothing bindable" UNVERIFIED block fires too (empty criteria);
 * - firing is pure observability: verdict/blocked/summary are computed
 *   exactly as before, and a throwing hook can never affect the gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShellProvider, ShellResult } from '@zelari/core/runtime';
import type { SessionEventInput } from '@zelari/core/session';
import { evaluateStrictBuildGate } from './verificationBridge.js';
import { resetKrakenCandidates, setKrakenCheckResults, setKrakenSelection } from './candidateRegistry.js';

const CHECKS = ['session survives concurrent refresh'];
const TYPECHECK = 'fake-typecheck';
const TEST = 'fake-test';
const BUILD = 'fake-build';

interface HookCall {
  payload: { criteria: string[]; reason: string };
  ctx?: { sessionId?: string; cwd?: string };
}

function stubHooks(): {
  calls: HookCall[];
  hooks: {
    runVerificationFailed(payload: HookCall['payload'], ctx?: HookCall['ctx']): Promise<void>;
  };
} {
  const calls: HookCall[] = [];
  return {
    calls,
    hooks: {
      async runVerificationFailed(payload, ctx) {
        calls.push({ payload, ctx });
      },
    },
  };
}

function emitSeq(): (input: SessionEventInput) => Promise<{ seq: number }> {
  let n = 1;
  return async () => ({ seq: n++ });
}

function selectWithChecks(checks: string[]): void {
  resetKrakenCandidates();
  setKrakenSelection({
    status: 'selected',
    winnerIndex: 0,
    rationale: 'test',
    requiredChecks: checks,
    degraded: false,
    verifier: null,
    judgedBy: 'llm',
  });
}

function stubShell(
  byCommand: Record<string, { exit?: number; stdout?: string; stderr?: string }>,
): ShellProvider {
  return {
    async exec(command: string): Promise<ShellResult> {
      const canned = byCommand[command] ?? { exit: 0, stdout: '' };
      return {
        exitCode: canned.exit ?? 0,
        stdout: canned.stdout ?? '',
        stderr: canned.stderr ?? '',
        durationMs: 1,
        timedOut: false,
      };
    },
  };
}

function packEnv(): Record<string, string | undefined> {
  return {
    ZELARI_VERIFY_PACK: '1',
    ZELARI_VERIFY_TYPECHECK_CMD: TYPECHECK,
    ZELARI_VERIFY_TEST_CMD: TEST,
    ZELARI_VERIFY_BUILD_CMD: BUILD,
  };
}

const ANCHORED_TRACE = [
  {
    tool: 'bash',
    callId: 'c-vitest',
    ok: true,
    command: 'vitest',
    output: '58/58 passed',
    durationMs: 1,
    endedAt: Date.now(),
  },
];

function selectPassing(): void {
  selectWithChecks(CHECKS);
  setKrakenCheckResults([{ check: CHECKS[0], status: 'pass', note: 'vitest 58/58' }], ANCHORED_TRACE);
}

let envPrev: string | undefined;
beforeEach(() => {
  envPrev = process.env.ZELARI_STRICT_DONE;
  process.env.ZELARI_STRICT_DONE = '1';
  resetKrakenCandidates();
});
afterEach(() => {
  if (envPrev === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = envPrev;
  resetKrakenCandidates();
});

describe('VerificationFailed hook (K5.3 / F32)', () => {
  it('fires once with { criteria, reason } when the strict-done gate BLOCKS', async () => {
    selectPassing();
    const { calls, hooks } = stubHooks();
    const gate = await evaluateStrictBuildGate('build', {
      env: packEnv(),
      emit: emitSeq(),
      shell: stubShell({
        [TYPECHECK]: { exit: 2, stderr: 'TS2345: argument of type...' },
        [TEST]: { exit: 0, stdout: '58 passed' },
        [BUILD]: { exit: 0, stdout: 'ok' },
      }),
      hooks,
    });
    // Verdict unchanged — the hook only reports.
    expect(gate.blocked).toBe(true);
    expect(gate.evaluation!.verdict).toBe('REPAIR_REQUIRED');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.criteria).toContain('correctness.error-signals');
    expect(typeof calls[0]!.payload.reason).toBe('string');
    expect(calls[0]!.payload.reason.length).toBeGreaterThan(0);
    expect(calls[0]!.payload.reason.length).toBeLessThanOrEqual(300);
  });

  it('does NOT fire on a strict PASS', async () => {
    selectPassing();
    const { calls, hooks } = stubHooks();
    const gate = await evaluateStrictBuildGate('build', {
      env: packEnv(),
      emit: emitSeq(),
      shell: stubShell({}),
      hooks,
    });
    expect(gate.blocked).toBe(false);
    expect(gate.evaluation!.verdict).toBe('PASS');
    expect(calls).toHaveLength(0);
  });

  it('the UNVERIFIED (nothing bindable) block fires too, with empty criteria', async () => {
    const { calls, hooks } = stubHooks();
    const gate = await evaluateStrictBuildGate('build', {
      env: { ZELARI_VERIFY_PACK: '0' },
      emit: emitSeq(),
      shell: stubShell({}),
      hooks,
    });
    expect(gate.unverified).toBe(true);
    expect(gate.blocked).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.criteria).toEqual([]);
    expect(calls[0]!.payload.reason).toContain('unverified');
  });

  it('a throwing hook never changes the gate (fire-and-forget observer)', async () => {
    selectPassing();
    const gate = await evaluateStrictBuildGate('build', {
      env: packEnv(),
      emit: emitSeq(),
      shell: stubShell({
        [TYPECHECK]: { exit: 2, stderr: 'boom' },
        [TEST]: { exit: 0, stdout: '58 passed' },
        [BUILD]: { exit: 0, stdout: 'ok' },
      }),
      hooks: {
        async runVerificationFailed() {
          throw new Error('observer exploded');
        },
      },
    });
    expect(gate.blocked).toBe(true);
  });
});
