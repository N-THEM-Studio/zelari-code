/**
 * nativeVerification tests — F2 / Exit-2.4: the Zelari Coding Criteria Pack
 * runs natively in the Kraken strict-build path.
 *
 * Locks the composition contract:
 *  - pack is opt-in (ZELARI_VERIFY_PACK=1), default off during the alpha;
 *  - env overrides replace `npm run <script>` binding (hermetic tests);
 *  - required criteria without a bound command are DROPPED, not unknowned;
 *  - a failing pack command forces REPAIR_REQUIRED even when every selection
 *    check passed with verify-agent evidence (deterministic beats narrative);
 *  - all-pass pack + all-pass selection → PASS, and the spine payload
 *    carries the native results with command digests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShellProvider, ShellResult } from '@zelari/core/runtime';
import {
  buildNativeCriteria,
  evaluateNativePack,
  nativePackEnabled,
  packTimeoutMs,
  resolvePackCommands,
} from './nativeVerification.js';
import {
  evaluateStrictBuildGate,
  strictGateEventPayload,
} from './verificationBridge.js';
import { resetKrakenCandidates, setKrakenCheckResults, setKrakenSelection } from './candidateRegistry.js';

const CHECKS = ['session survives concurrent refresh'];

function emitSeq(): (input: unknown) => Promise<{ seq: number }> {
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

const TYPECHECK = 'fake-typecheck';
const TEST = 'fake-test';
const BUILD = 'fake-build';

function packEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ZELARI_VERIFY_PACK: '1',
    ZELARI_VERIFY_TYPECHECK_CMD: TYPECHECK,
    ZELARI_VERIFY_TEST_CMD: TEST,
    ZELARI_VERIFY_BUILD_CMD: BUILD,
    ...overrides,
  };
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

describe('nativePackEnabled (alpha opt-in)', () => {
  it('is OFF by default and only enabled by explicit flags', () => {
    expect(nativePackEnabled({})).toBe(false);
    expect(nativePackEnabled({ ZELARI_VERIFY_PACK: '1' })).toBe(true);
    expect(nativePackEnabled({ ZELARI_VERIFY_PACK: 'on' })).toBe(true);
    expect(nativePackEnabled({ ZELARI_VERIFY_PACK: 'true' })).toBe(true);
    expect(nativePackEnabled({ ZELARI_VERIFY_PACK: '0' })).toBe(false);
    expect(nativePackEnabled({ ZELARI_VERIFY_PACK: 'yes' })).toBe(false);
  });
});

describe('resolvePackCommands', () => {
  it('binds npm scripts present in package.json', () => {
    const cmds = resolvePackCommands({}, { typecheck: 'tsc -p .', test: 'vitest run' });
    expect(cmds.typecheckCommand).toBe('npm run typecheck');
    expect(cmds.testCommand).toBe('npm run test');
    expect(cmds.buildCommand).toBeNull(); // script absent → unbound
  });

  it('env override wins; empty string explicitly disables', () => {
    const cmds = resolvePackCommands(
      { ZELARI_VERIFY_TYPECHECK_CMD: 'tsc --noEmit', ZELARI_VERIFY_TEST_CMD: '' },
      { typecheck: 'x', test: 'y', build: 'z' },
    );
    expect(cmds.typecheckCommand).toBe('tsc --noEmit');
    expect(cmds.testCommand).toBeNull();
    expect(cmds.buildCommand).toBe('npm run build');
  });

  it('packTimeoutMs clamps to [1, 3600000] and defaults to 600000', () => {
    expect(packTimeoutMs({})).toBe(600_000);
    expect(packTimeoutMs({ ZELARI_VERIFY_TIMEOUT_MS: '5000' })).toBe(5_000);
    expect(packTimeoutMs({ ZELARI_VERIFY_TIMEOUT_MS: '-3' })).toBe(600_000);
    expect(packTimeoutMs({ ZELARI_VERIFY_TIMEOUT_MS: '99999999' })).toBe(3_600_000);
  });
});

describe('buildNativeCriteria', () => {
  it('drops required criteria without a bound command; keeps advisory ones', () => {
    const criteria = buildNativeCriteria(
      { typecheckCommand: 'tsc', testCommand: null, buildCommand: null },
      1_000,
    );
    const ids = criteria.map((c) => c.id);
    expect(ids).toContain('correctness.error-signals');
    expect(ids).not.toContain('correctness.specification');
    expect(ids).not.toContain('correctness.observable-output');
    // advisories stay even unbound — they surface as honest `unknown`
    expect(ids).toContain('evidence.verification-quality');
  });
});

describe('evaluateNativePack', () => {
  it('returns null when disabled or when no command is bound', async () => {
    expect(await evaluateNativePack({ env: {}, shell: stubShell({}) })).toBeNull();
    expect(
      await evaluateNativePack({
        env: { ZELARI_VERIFY_PACK: '1' },
        cwd: 'Z:/__no_such_repo__',
        shell: stubShell({}),
      }),
    ).toBeNull();
  });

  it('runs bound commands through the core engine and returns digested evidence', async () => {
    const pack = await evaluateNativePack({
      env: packEnv(),
      shell: stubShell({
        [TYPECHECK]: { exit: 0, stdout: 'no errors' },
        [TEST]: { exit: 0, stdout: '58 passed' },
        [BUILD]: { exit: 0, stdout: 'bundled' },
      }),
    });
    expect(pack).not.toBeNull();
    const byId = new Map(pack!.results.map((r) => [r.criterionId, r]));
    expect(byId.get('correctness.error-signals')?.status).toBe('pass');
    expect(byId.get('correctness.specification')?.status).toBe('pass');
    const ev = byId.get('correctness.specification')?.evidence[0];
    expect(ev?.tier).toBe('command-output');
    expect(ev?.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('evaluateStrictBuildGate × native pack (F2 lock)', () => {
  it('failing typecheck forces REPAIR_REQUIRED even when every selection check passes with notes', async () => {
    selectWithChecks(CHECKS);
    setKrakenCheckResults([{ check: CHECKS[0], status: 'pass', note: 'vitest 58/58' }]);
    const gate = await evaluateStrictBuildGate('build', {
      env: packEnv(),
      emit: emitSeq(),
      shell: stubShell({
        [TYPECHECK]: { exit: 2, stderr: 'TS2345: argument of type...' },
        [TEST]: { exit: 0, stdout: '58 passed' },
        [BUILD]: { exit: 0, stdout: 'ok' },
      }),
    });
    expect(gate.strict).toBe(true);
    expect(gate.native).not.toBeNull();
    expect(gate.evaluation!.verdict).toBe('REPAIR_REQUIRED');
    expect(gate.blocked).toBe(true);
    const failed = gate.evaluation!.unsatisfied.find((u) => u.id === 'correctness.error-signals');
    expect(failed?.status).toBe('fail');
  });

  it('all-pass pack + all-pass selection → PASS with native results in the payload', async () => {
    selectWithChecks(CHECKS);
    setKrakenCheckResults([{ check: CHECKS[0], status: 'pass', note: 'vitest 58/58' }]);
    const gate = await evaluateStrictBuildGate('build', {
      env: packEnv(),
      emit: emitSeq(),
      shell: stubShell({
        [TYPECHECK]: { exit: 0 },
        [TEST]: { exit: 0, stdout: '58 passed' },
        [BUILD]: { exit: 0 },
      }),
    });
    expect(gate.evaluation!.verdict).toBe('PASS');
    expect(gate.blocked).toBe(false);
    const payload = strictGateEventPayload(gate);
    expect(payload.engine).toBe('kraken-legacy+completion-policy+criteria-pack');
    expect(payload.native).toMatchObject({ packId: 'zelari-coding/v1' });
    const results = (payload.native as { results: Array<{ criterionId: string; status: string }> }).results;
    expect(results.filter((r) => r.status === 'pass').length).toBeGreaterThanOrEqual(3);
  });

  it('pack disabled (default) → native null and identical legacy-only verdict', async () => {
    selectWithChecks(CHECKS);
    setKrakenCheckResults([{ check: CHECKS[0], status: 'pass', note: 'vitest 58/58' }]);
    const gate = await evaluateStrictBuildGate('build', { env: {}, emit: emitSeq(), shell: stubShell({}) });
    expect(gate.native).toBeNull();
    expect(gate.evaluation!.verdict).toBe('PASS');
    expect(strictGateEventPayload(gate).engine).toBe('kraken-legacy+completion-policy');
  });

  it('a pack criterion timing out is unknown — blockers add, unknown never passes silently', async () => {
    selectWithChecks(CHECKS);
    setKrakenCheckResults([{ check: CHECKS[0], status: 'pass', note: 'ok' }]);
    const timeoutShell: ShellProvider = {
      async exec(command: string): Promise<ShellResult> {
        if (command === TEST) {
          return { exitCode: null, stdout: '', stderr: '', durationMs: 9, timedOut: true };
        }
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
      },
    };
    const gate = await evaluateStrictBuildGate('build', { env: packEnv(), emit: emitSeq(), shell: timeoutShell });
    expect(gate.evaluation!.verdict).toBe('BLOCKED'); // unknown ≠ pass
    expect(gate.blocked).toBe(true);
  });
});
