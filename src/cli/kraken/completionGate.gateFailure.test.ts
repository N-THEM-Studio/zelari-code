/**
 * t23 — the completion gate is fail-closed: a registry evaluation that
 * THROWS must produce a BLOCKED gate (unknown ≠ pass, §23 observation
 * integrity), never a green one. The strict-done headless path must then
 * surface it as exit 4 (STRICT_DONE_EXIT_CODE), not a warning or a pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellProvider, ShellResult } from '@zelari/core/runtime';
import { evaluateKrakenCompletionGate } from './completionGate.js';
import { resetKrakenCandidates, setKrakenSelection } from './candidateRegistry.js';
import { evaluateStrictBuildGate, strictGateExitCode } from './verificationBridge.js';

const CHECKS = ['check one passes', 'check two passes'];

/** Toggle-able failure injection (vi.hoisted so the vi.mock factory sees it). */
const failure = vi.hoisted(() => ({
  requiredChecks: null as null | (() => never),
  checkResults: null as null | (() => never),
}));

vi.mock('./candidateRegistry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./candidateRegistry.js')>();
  return {
    ...actual,
    krakenRequiredChecks: () => {
      if (failure.requiredChecks) failure.requiredChecks();
      return actual.krakenRequiredChecks();
    },
    getKrakenCheckResults: () => {
      if (failure.checkResults) failure.checkResults();
      return actual.getKrakenCheckResults();
    },
  };
});

function selectWithChecks(checks: string[]): void {
  resetKrakenCandidates();
  setKrakenSelection({
    status: 'selected',
    winnerIndex: 1,
    rationale: 'stronger evidence',
    requiredChecks: checks,
    degraded: false,
    verifier: null,
    judgedBy: 'llm',
  });
}

// Shell/env seams mirroring strictGatePackIndependence.test.ts so the pack
// evaluates deterministically (no real commands, no network, no fs).
const TYPECHECK = 'fake-typecheck';

function emitSeq(): (input: unknown) => Promise<{ seq: number }> {
  let n = 1;
  return async () => ({ seq: n++ });
}

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

function packEnv(): Record<string, string | undefined> {
  return {
    ZELARI_VERIFY_PACK: '1',
    ZELARI_VERIFY_TYPECHECK_CMD: TYPECHECK,
    ZELARI_VERIFY_TEST_CMD: '',
    ZELARI_VERIFY_BUILD_CMD: '',
  };
}

let prevStrict: string | undefined;
beforeEach(() => {
  prevStrict = process.env.ZELARI_STRICT_DONE;
});
afterEach(() => {
  failure.requiredChecks = null;
  failure.checkResults = null;
  if (prevStrict === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = prevStrict;
  resetKrakenCandidates();
});

describe('completionGate catch → BLOCKED (t23)', () => {
  it('registry results explode ⇒ BLOCKED with the required checks as unknown', () => {
    selectWithChecks(CHECKS);
    failure.checkResults = () => {
      throw new Error('registry exploded');
    };
    const gate = evaluateKrakenCompletionGate('build');
    expect(gate.blocked).toBe(true);
    expect(gate.selectionUsed).toBe(false);
    expect(gate.total).toBe(2);
    expect(gate.passed).toBe(0);
    expect(gate.unknownChecks).toEqual(CHECKS);
    expect(gate.failedChecks).toEqual([]);
  });

  it('required checks explode ⇒ BLOCKED (unknown ≠ pass), PLAN stays open', () => {
    selectWithChecks(CHECKS);
    failure.requiredChecks = () => {
      throw new Error('registry exploded');
    };
    const gate = evaluateKrakenCompletionGate('build');
    expect(gate.blocked).toBe(true);
    expect(gate.total).toBe(0);
    expect(gate.unknownChecks).toEqual([]);
    expect(evaluateKrakenCompletionGate('plan').blocked).toBe(false);
  });

  it('strict headless: throwing gate ⇒ exit 4 (STRICT_DONE_EXIT_CODE), not a green run', async () => {
    process.env.ZELARI_STRICT_DONE = '1';
    selectWithChecks(CHECKS);
    failure.checkResults = () => {
      throw new Error('registry exploded');
    };
    const evaluation = await evaluateStrictBuildGate('build', {
      env: packEnv(),
      shell: stubShell({ [TYPECHECK]: { exit: 0, stdout: 'ok' } }),
      emit: emitSeq() as never,
    });
    expect(evaluation.gate.blocked).toBe(true);
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.strict).toBe(true);
    expect(strictGateExitCode(evaluation)).toBe(4);
  });
});
