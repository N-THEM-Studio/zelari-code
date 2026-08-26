/**
 * strictGatePackIndependence tests — 2.1 T6: the native criteria pack is
 * independent of Kraken Selection.
 *
 * Locks the new composition rule in evaluateStrictBuildGate:
 *  - ZELARI_VERIFY_PACK=1 evaluates the pack even when the turn NEVER ran
 *    kraken_select (no selection contract, registry empty) AND even when
 *    ZELARI_STRICT_DONE is off — the pack is its own strict switch;
 *  - a failing pack command blocks the turn (exit 4 path) without any
 *    selection criteria existing at all;
 *  - pack enabled but nothing bound → honest non-strict "open", never an
 *    empty PASS.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShellProvider, ShellResult } from '@zelari/core/runtime';
import {
  evaluateStrictBuildGate,
  strictGateEventPayload,
  strictGateExitCode,
} from './verificationBridge.js';
import { resetKrakenCandidates } from './candidateRegistry.js';

const TYPECHECK = 'fake-typecheck';

function emitSeq(): (input: unknown) => Promise<{ seq: number }> {
  let n = 1;
  return async () => ({ seq: n++ });
}

/** Deterministic shell stub: map each command to a canned ShellResult. */
function stubShell(byCommand: Record<string, { exit?: number; stdout?: string; stderr?: string }>): ShellProvider {
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

function packEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ZELARI_VERIFY_PACK: '1',
    ZELARI_VERIFY_TYPECHECK_CMD: TYPECHECK,
    ZELARI_VERIFY_TEST_CMD: '',
    ZELARI_VERIFY_BUILD_CMD: '',
    ...overrides,
  };
}

let strictPrev: string | undefined;
beforeEach(() => {
  // T6 proof precondition: strict-done OFF (the 1.x/2.0 default) — the pack
  // must still drive the gate on its own.
  strictPrev = process.env.ZELARI_STRICT_DONE;
  process.env.ZELARI_STRICT_DONE = '0'; // P0.1 default ON — this suite locks pack independence with strict off
  resetKrakenCandidates();
});
afterEach(() => {
  if (strictPrev === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = strictPrev;
  resetKrakenCandidates();
});

describe('evaluateStrictBuildGate — pack without selection', () => {
  it('ZELARI_VERIFY_PACK=1 evaluates the pack with NO selection and strict-done OFF', async () => {
    const evaluation = await evaluateStrictBuildGate('build', {
      env: packEnv(),
      shell: stubShell({ [TYPECHECK]: { exit: 0, stdout: 'ok' } }),
      emit: emitSeq() as never,
    });
    expect(evaluation.gate.selectionUsed).toBe(false);
    expect(evaluation.gate.total).toBe(0);
    expect(evaluation.strict).toBe(true);
    expect(evaluation.evaluation).not.toBeNull();
    expect(evaluation.native).not.toBeNull();
    expect(evaluation.blocked).toBe(false);
    const payload = strictGateEventPayload(evaluation);
    expect(String(payload.engine)).toContain('criteria-pack');
    expect(payload.native).not.toBeNull();
  });

  it('a failing pack command blocks the turn with exit 4 — no selection needed', async () => {
    const evaluation = await evaluateStrictBuildGate('build', {
      env: packEnv(),
      shell: stubShell({ [TYPECHECK]: { exit: 1, stderr: 'boom' } }),
      emit: emitSeq() as never,
    });
    expect(evaluation.strict).toBe(true);
    expect(evaluation.evaluation?.verdict).toBe('REPAIR_REQUIRED');
    expect(evaluation.blocked).toBe(true);
    expect(strictGateExitCode(evaluation)).toBe(4);
  });

  it('pack enabled but nothing bound → honest non-strict open, never an empty PASS', async () => {
    const evaluation = await evaluateStrictBuildGate('build', {
      env: { ZELARI_VERIFY_PACK: '1' },
      cwd: '/nonexistent-zelari-test-repo',
      shell: stubShell({}),
      emit: emitSeq() as never,
    });
    expect(evaluation.strict).toBe(false);
    expect(evaluation.evaluation).toBeNull();
    expect(evaluation.blocked).toBe(false);
    expect(evaluation.summary).toBe('open (native pack bound no command)');
  });

  it('pack opt-out + no selection stays exactly the 2.0 early-return', async () => {
    const evaluation = await evaluateStrictBuildGate('build', {
      env: { ZELARI_VERIFY_PACK: '0' },
      shell: stubShell({}),
    });
    expect(evaluation.strict).toBe(false);
    expect(evaluation.evaluation).toBeNull();
    expect(evaluation.native).toBeNull();
    expect(evaluation.blocked).toBe(false);
  });
});
