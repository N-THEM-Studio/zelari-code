/**
 * F3 emit-seam contract lock — the mission-close gate must anchor evidence.
 *
 * runHeadless.ts closes missions through evaluateStrictBuildGate with a spine
 * emit adapter. The core engine's emitEvidence
 * (packages/core/src/verification/engine.ts) reads the anchor as `out.seq`
 * (object field); the headless spine resolves the seq NUMBER. The mission
 * site used to pass the bare number: events still landed on the session log
 * but every EvidenceRef stayed unanchored (seq undefined), so the strict gate
 * could never PASS on the mission path — a green run degraded to a false
 * exit 4. runOneTurn.ts got the `{ seq }` wrapper in M1; the mission-close
 * site was the last bare one (P0 fix).
 *
 * Locks:
 * - behavioral: the adapter maps the spine seq NUMBER into `{ seq }` (and
 *   degrades to `{ seq: null }` when the spine cannot trace), and the REAL
 *   native pack driven through it anchors EvidenceRef.seq — while the
 *   pre-fix bare-number shape is pinned as leaving it undefined (the test
 *   bites: unknown ≠ pass);
 * - wiring: source-level pins on runHeadless.ts (legacyContextIsolation
 *   pattern) so the bare form cannot come back unnoticed.
 *
 * NOTE: the behavioral lock drives the pack with FAKE emitters (the
 * cachedShell.test.ts idiom), not a real openHeadlessSpine — the spine
 * mirror constructor is currently broken under this vitest environment
 * ("SessionLogCache is not a constructor", pre-existing: it already reddens
 * 3 tests in runHeadless.missionEventBack.test.ts on this machine). The
 * real-spine halves of the contract stay in the spine suites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateNativePack } from './kraken/nativeVerification.js';
import type { SessionEventInput } from '@zelari/core/session';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const readCli = (rel: string): string => readFileSync(path.join(cliDir, rel), 'utf8');

const TYPECHECK = 'fake-typecheck';
const TEST = 'fake-test';
const BUILD = 'fake-build';

/** Pack env idiom (strictGatePackIndependence.test.ts): fake commands only. */
function packEnv(): Record<string, string | undefined> {
  return {
    ZELARI_VERIFY_PACK: '1',
    ZELARI_VERIFY_TYPECHECK_CMD: TYPECHECK,
    ZELARI_VERIFY_TEST_CMD: TEST,
    ZELARI_VERIFY_BUILD_CMD: BUILD,
  };
}

/** Deterministic shell stub: map each command to a canned result (house idiom). */
function stubShell(
  byCommand: Record<string, { exit?: number; stdout?: string; stderr?: string }>,
): {
  exec: (
    command: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }>;
} {
  return {
    async exec(command: string) {
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

/** Same event shape the strict gate emits (verificationBridge anchoring). */
const evidenceEvent = (): SessionEventInput => ({
  kind: 'verification.evidence',
  actor: { type: 'system', role: 'verification' },
  data: { observation: 'command', command: TYPECHECK, exitCode: 0 },
});

/** Fake spine seam: exactly what runHeadless.ts wraps (number | null). */
type FakeSpine = { appendEvent: (input: SessionEventInput) => Promise<number | null> };

/** The adapter shape the FIXED mission site passes (runHeadless.ts). */
const anchoredAdapter =
  (spine: FakeSpine) =>
  async (input: SessionEventInput): Promise<{ seq: number | null }> => ({
    seq: await spine.appendEvent(input),
  });

/** First command-output EvidenceRef across the pack results, if any. */
const commandBackedRef = (results: unknown) => {
  const list = (results as { evidence?: { tier?: string; seq?: number }[] }[] | undefined) ?? [];
  for (const r of list) {
    const ref = r.evidence?.find((e) => e.tier === 'command-output');
    if (ref) return ref;
  }
  return undefined;
};

const SAVED_ENV = ['ZELARI_VERIFY_CACHE'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of SAVED_ENV) savedEnv.set(k, process.env[k]);
  process.env.ZELARI_VERIFY_CACHE = '0'; // hermetic: no shared command LRU
});

afterEach(() => {
  for (const k of SAVED_ENV) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('F3 adapter mapping (unit — the exact wrap the fix adds)', () => {
  it('maps the spine seq NUMBER into the { seq } object the engine reads', async () => {
    const spine: FakeSpine = { appendEvent: async () => 7 };
    const out = await anchoredAdapter(spine)(evidenceEvent());
    expect(out).toEqual({ seq: 7 });
  });

  it('degrades to { seq: null } when the spine cannot trace — engine treats it as unanchored', async () => {
    const spine: FakeSpine = { appendEvent: async () => null };
    const out = await anchoredAdapter(spine)(evidenceEvent());
    expect(out).toEqual({ seq: null });
    // engine.ts emitEvidence discipline: only a NUMBER seq anchors.
    expect(typeof (out as { seq?: unknown }).seq === 'number').toBe(false);
  });
});

describe('F3 pack anchoring — REAL native pack, fake emitters (cachedShell idiom)', () => {
  it('wrapped emitter → command-output EvidenceRef.seq is a number (anchored)', async () => {
    const events: SessionEventInput[] = [];
    const wrapped = async (input: SessionEventInput): Promise<{ seq: number }> => {
      events.push(input);
      return { seq: 1000 + events.length };
    };
    const evaluation = await evaluateNativePack({
      cwd: process.cwd(),
      env: packEnv(),
      shell: stubShell({
        [TYPECHECK]: { exit: 0, stdout: 'ok' },
        [TEST]: { exit: 0, stdout: '1 passed' },
        [BUILD]: { exit: 0, stdout: 'ok' },
      }),
      emit: wrapped,
    });
    expect(evaluation).not.toBeNull();
    const ref = commandBackedRef(evaluation?.results);
    expect(ref).toBeDefined();
    expect(typeof ref?.seq).toBe('number'); // THE lock: anchored, never undefined
    expect(events.length).toBeGreaterThanOrEqual(1); // evidence events flowed
  });

  it('RED documentation: bare-number emitter (pre-fix shape) → EvidenceRef.seq undefined', async () => {
    const events: SessionEventInput[] = [];
    const bare = async (input: SessionEventInput): Promise<number> => {
      events.push(input);
      return 1000 + events.length;
    };
    const evaluation = await evaluateNativePack({
      cwd: process.cwd(),
      env: packEnv(),
      shell: stubShell({ [TYPECHECK]: { exit: 0, stdout: 'ok' } }),
      emit: bare,
    });
    expect(evaluation).not.toBeNull();
    const ref = commandBackedRef(evaluation?.results);
    expect(ref).toBeDefined();
    expect(events.length).toBeGreaterThanOrEqual(1); // events still emitted…
    expect(ref?.seq).toBeUndefined(); // …but the engine cannot read a bare number
  });
});

describe('F3 mission-site wiring (source-level, legacyContextIsolation pattern)', () => {
  it('runHeadless mission gate passes the { seq } adapter — never the bare number', () => {
    const src = readCli('runHeadless.ts');
    expect(src).toContain('emit: async (input) => ({ seq: await spine.appendEvent(input) })');
    // the pre-fix bare form must not come back anywhere in the file
    expect(src).not.toContain('emit: (input) => spine.appendEvent(input)');
  });

  it('the runOneTurn family keeps its adapters (≥3 wrapped sites)', () => {
    const one = readCli(path.join('headless', 'runOneTurn.ts'));
    expect(one.match(/\{ seq: await spine\.appendEvent\(input\) \}/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
