/**
 * headless-verify-pack-default.test.ts — HARNESS-10 §6.4 coverage on the
 * headless BUILD surface. runHeadless.ts opens the strict BUILD gate with
 * the predicate `(isKrakenSelectionEnabled() || nativePackEnabled())` and
 * then joins the native pack inside evaluateStrictBuildGate('build').
 *
 * Locks the DEFAULT on that exact seam (no process.env pack variable set):
 *  - the pack is ON by default (P0.2) → the strict gate evaluates it;
 *  - `ZELARI_VERIFY_PACK=0` turns it off explicitly → native null and the
 *    gate degrades to the legacy contract (strict false with no selection).
 *
 * Deterministic: env overrides bind a fake typecheck command and the shell
 * seam is a stub — no real npm/tsc command ever runs (same pattern as
 * nativeVerification.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateNativePack, nativePackEnabled } from '../../src/cli/kraken/nativeVerification.js';
import { evaluateStrictBuildGate, strictDoneEnabled } from '../../src/cli/kraken/verificationBridge.js';
import { resetKrakenCandidates } from '../../src/cli/kraken/candidateRegistry.js';
import type { ShellProvider } from '@zelari/core/runtime';

const TYPECHECK = 't31-fake-typecheck';

/** Deterministic shell stub: every command succeeds. */
function stubShell(): ShellProvider {
  return {
    async exec(_command: string) {
      return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
    },
  };
}

/** Env override surface WITHOUT any explicit ZELARI_VERIFY_PACK (default). */
function packEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ZELARI_VERIFY_TYPECHECK_CMD: TYPECHECK,
    ZELARI_VERIFY_TEST_CMD: '',
    ZELARI_VERIFY_BUILD_CMD: '',
    ...overrides,
  };
}

let root = '';
let prevStrict: string | undefined;
let prevPack: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'zelari-headless-pack-'));
  prevStrict = process.env.ZELARI_STRICT_DONE;
  prevPack = process.env.ZELARI_VERIFY_PACK;
  // Headless default posture: NO explicit opt-out variable is set.
  delete process.env.ZELARI_STRICT_DONE;
  delete process.env.ZELARI_VERIFY_PACK;
  resetKrakenCandidates();
});

afterEach(() => {
  if (prevStrict === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = prevStrict;
  if (prevPack === undefined) delete process.env.ZELARI_VERIFY_PACK;
  else process.env.ZELARI_VERIFY_PACK = prevPack;
  resetKrakenCandidates();
  rmSync(root, { recursive: true, force: true });
});

describe('headless BUILD: native pack default (HARNESS-10 §6.4)', () => {
  it('the headless gate predicate is ON by default (no env needed)', () => {
    // runHeadless.ts: `(isKrakenSelectionEnabled() || nativePackEnabled())`
    expect(nativePackEnabled()).toBe(true);
    expect(nativePackEnabled(process.env)).toBe(true);
  });

  it('the strict-done overlay is ON by default on the kraken surface', () => {
    expect(strictDoneEnabled()).toBe(true);
    expect(strictDoneEnabled('kraken')).toBe(true);
  });

  it('evaluateStrictBuildGate("build") joins the native pack by default', async () => {
    const gate = await evaluateStrictBuildGate('build', {
      cwd: root,
      env: packEnv(), // no ZELARI_VERIFY_PACK → default ON
      shell: stubShell(),
    });
    expect(gate.native).not.toBeNull();
    expect(gate.native?.results.length).toBeGreaterThan(0);
    expect(gate.strict).toBe(true);
    // The bound fake typecheck ran through the engine seam and PASSED.
    expect(gate.native?.results.some((r) => r.status === 'pass')).toBe(true);
  });

  it('ZELARI_VERIFY_PACK=0 turns the pack off explicitly on the same surface', async () => {
    expect(nativePackEnabled({ ZELARI_VERIFY_PACK: '0' })).toBe(false);
    const off = await evaluateNativePack({
      cwd: root,
      env: packEnv({ ZELARI_VERIFY_PACK: '0' }),
      shell: stubShell(),
    });
    expect(off).toBeNull();
    const gate = await evaluateStrictBuildGate('build', {
      cwd: root,
      env: packEnv({ ZELARI_VERIFY_PACK: '0' }),
      shell: stubShell(),
    });
    // No selection, no contract, pack off → nothing strict to evaluate.
    expect(gate.native).toBeNull();
    expect(gate.strict).toBe(false);
  });
});
