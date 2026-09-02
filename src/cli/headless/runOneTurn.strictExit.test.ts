/**
 * t39 — Exit-4 end-to-end via runOneTurn (one-shot strict gate).
 *
 * Product-level chain, IN-PROCESS (no spawn of the CLI, no live keys — the
 * provider stream is injected, the only deterministic seam runOneTurn has):
 *
 *   runOneTurn(kraken BUILD, strictDone) → pass completes cleanly →
 *   native criteria pack (ZELARI_VERIFY_PACK) joins the strict gate with a
 *   REAL executed command whose required criterion cannot anchor event-backed
 *   evidence in this run (a pure-text stub never produces session tool
 *   results) → evaluateStrictBuildGate BLOCKED ("pass without event-backed
 *   evidence") → mandatory repair pass (LLM) → second evaluation still
 *   BLOCKED → strictGateExitCode → 4 (STRICT_DONE_EXIT_CODE — distinct from
 *   transport error 3 / usage error 2)
 *
 * Hermetic by construction:
 * - `cwd` is a fresh mkdtemp WITHOUT package.json, so the repo-adaptive pack
 *   adapter binds nothing and the ONLY command comes from the env override
 *   ZELARI_VERIFY_TYPECHECK_CMD=`node -e "process.exit(1)"` — instant and
 *   deterministic on every machine. The directory MUST exist: an absent cwd
 *   hangs the shell-backed command execution (observed on win32).
 * - The strict knobs ride opts (strictEnvOverlay), never process.env:
 *   ZELARI_STRICT_DONE / ZELARI_MISSION_STRICT are deleted (defaults ON).
 * - ZELARI_SESSIONS_DIR isolates the session spine; ZELARI_EXTENSIONS=0
 *   skips the loader; ZELARI_VERIFIER_REVIEW=0 forces the advisory review
 *   off; ZELARI_MEMORY=0 keeps memory v2 off regardless of machine flags.
 *
 * Negative control: with strictDone:false AND ZELARI_VERIFY_PACK=0 the run
 * closes 0 — proving the 4 above comes from the strict gate (the pack is an
 * AUTONOMOUS strict switch: kept on, it fails 4 even with --no-strict-done).
 *
 * Env discipline + stdout capture cribbed from headlessE2eSession.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { runOneTurn } from './runOneTurn.js';
import { resetKrakenCandidates } from '../kraken/candidateRegistry.js';
import { resetTaskVerifyObligation, seedTaskVerifyObligation } from '../tools/taskTool.js';

/**
 * Stream FACTORY reference, not a consumed generator: runOneTurn invokes it
 * TWICE (initial pass + forced repair pass) and the harness may iterate the
 * returned generator once per invocation.
 */
const stubStream: ProviderStreamFn = async function* t39StubTurnStream() {
  yield { kind: 'text', delta: 'ok' };
  yield { kind: 'finish', reason: 'stop' };
};

// Task wording avoids EVERY expectsDiskImplementation cue (implement/write/
// edit/fix/build/…): the stub makes no tool calls, so buildLiveness must not
// demand disk mutations — the pass has to close completed/exit-0 for the
// strict gate to arm at all.
const TASK = 't39 strict-done gate probe: reply with exactly ok and nothing else';

const ENV_KEYS = [
  'ZELARI_VERIFY_PACK',
  'ZELARI_VERIFY_TYPECHECK_CMD',
  'ZELARI_VERIFY_TEST_CMD',
  'ZELARI_VERIFY_BUILD_CMD',
  'ZELARI_VERIFY_TIMEOUT_MS',
  'ZELARI_EXTENSIONS',
  'ZELARI_SESSIONS_DIR',
  'ZELARI_VERIFIER_REVIEW',
  'ZELARI_MEMORY',
  'ZELARI_STRICT_DONE',
  'ZELARI_MISSION_STRICT',
] as const;

let tmp: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  // mkdtemp CREATES the dir: an absent cwd makes the pack's shell-backed
  // command execution hang (observed >30s on win32) instead of failing fast.
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-t39-'));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Native pack ON with a deterministic-failing typecheck; test/build slots
  // disabled ('' = explicitly off); tiny timeout (default is 10 minutes).
  process.env.ZELARI_VERIFY_PACK = '1';
  process.env.ZELARI_VERIFY_TYPECHECK_CMD = 'node -e "process.exit(1)"';
  process.env.ZELARI_VERIFY_TEST_CMD = '';
  process.env.ZELARI_VERIFY_BUILD_CMD = '';
  process.env.ZELARI_VERIFY_TIMEOUT_MS = '5000';
  // Skip the extension loader; isolate the session spine on disk.
  process.env.ZELARI_EXTENSIONS = '0';
  process.env.ZELARI_SESSIONS_DIR = path.join(tmp, 'sessions');
  // Never let a developer-machine environment leak into the product path.
  process.env.ZELARI_VERIFIER_REVIEW = '0'; // 2.1 T4 advisory review: OFF
  process.env.ZELARI_MEMORY = '0'; // memory v2 off (serviceFactory short-circuit)
  // Strict defaults ON (kraken surface) — the knobs ride opts, not env.
  delete process.env.ZELARI_STRICT_DONE;
  delete process.env.ZELARI_MISSION_STRICT;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetKrakenCandidates();
  return fs.rm(tmp, { recursive: true, force: true });
});

/** Capture (and swallow) stdout+stderr while the turn emits NDJSON. */
async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  const collect = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  process.stdout.write = collect as typeof process.stdout.write;
  process.stderr.write = collect as typeof process.stderr.write;
  const restore = () => {
    process.stdout.write = out;
    process.stderr.write = err;
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    restore();
  }
}

function parseNdjson(lines: string[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    for (const chunk of line.split('\n')) {
      const trimmed = chunk.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        events.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        /* non-NDJSON stdout noise */
      }
    }
  }
  return events;
}

describe('t39 — one-shot strict gate closes runOneTurn with exit 4 (e2e, in-process)', () => {
  it('kraken BUILD + strictDone + failing native pack → 4 after the mandatory repair pass', async () => {
    const { result: code, lines } = await captureOutput(() =>
      runOneTurn(
        {
          task: TASK,
          mode: 'kraken',
          phase: 'build',
          output: 'json',
          useCouncil: false,
          cwd: tmp,
          strictDone: true,
        },
        'openai-compatible',
        't39-fake',
        stubStream,
      ),
    );

    // The heart of t39: STRICT_DONE_EXIT_CODE, NOT the error exit (3).
    expect(code).toBe(4);

    // Provenance: the 4 must come from the STRICT path, not another failure.
    // 1) the gate really ran with the native pack and really BLOCKED;
    const events = parseNdjson(lines);
    const verificationRun = events.find((e) => e.type === 'verification_run') as
      | { strict?: boolean; verdict?: string; engine?: string }
      | undefined;
    expect(verificationRun, 'the strict gate must have emitted verification_run').toBeDefined();
    expect(verificationRun!.strict).toBe(true);
    expect(verificationRun!.verdict).not.toBe('PASS');
    expect(String(verificationRun!.engine)).toContain('criteria-pack');
    // 2) the mandatory repair pass ran and the gate stayed blocked.
    const joined = lines.join('');
    expect(joined).toContain('forcing repair pass');
    expect(joined).toContain('still blocked after repair pass');
  }, 30_000);

  it('control: strictDone:false + ZELARI_VERIFY_PACK=0 → the same run does NOT close 4', async () => {
    // The pack is an autonomous strict switch: with it off AND the knob off,
    // the gate never arms and the clean pass exit survives untouched.
    process.env.ZELARI_VERIFY_PACK = '0';
    const { result: code } = await captureOutput(() =>
      runOneTurn(
        {
          task: TASK,
          mode: 'kraken',
          phase: 'build',
          output: 'json',
          useCouncil: false,
          cwd: tmp,
          strictDone: false,
        },
        'openai-compatible',
        't39-fake',
        stubStream,
      ),
    );
    expect(code).not.toBe(4);
    // Sharper than the contract above: with both switches off this is a
    // clean success, so the positive test's 4 cannot be a boot artifact.
    expect(code).toBe(0);
  }, 30_000);
});

describe('t78 — open general⇒verify obligation closes runOneTurn with exit 4', () => {
  afterEach(() => {
    resetTaskVerifyObligation();
  });

  it('kraken BUILD + seeded unverified general (no extra flag) → 4', async () => {
    // Isolate the t78 debt gate from the t39 native-pack path.
    process.env.ZELARI_VERIFY_PACK = '0';
    seedTaskVerifyObligation({
      description: 'fix foo',
      detail: 'VERDICT: FAIL after rework',
    });
    const { result: code, lines } = await captureOutput(() =>
      runOneTurn(
        {
          task: TASK,
          mode: 'kraken',
          phase: 'build',
          output: 'json',
          useCouncil: false,
          cwd: tmp,
          // no extra flag — strict done is the default
        },
        'openai-compatible',
        't78-fake',
        stubStream,
      ),
    );
    expect(code).toBe(4);
    const joined = lines.join('');
    expect(joined).toContain('fix foo');
    expect(joined).toMatch(/without a passing verify/);
  }, 30_000);

  it('opt-out ZELARI_STRICT_DONE=0 does not close 4 on the same debt', async () => {
    process.env.ZELARI_VERIFY_PACK = '0';
    process.env.ZELARI_STRICT_DONE = '0';
    seedTaskVerifyObligation({ description: 'fix foo', detail: 'VERDICT: FAIL' });
    const { result: code } = await captureOutput(() =>
      runOneTurn(
        {
          task: TASK,
          mode: 'kraken',
          phase: 'build',
          output: 'json',
          useCouncil: false,
          cwd: tmp,
          strictDone: false,
        },
        'openai-compatible',
        't78-fake',
        stubStream,
      ),
    );
    expect(code).not.toBe(4);
    expect(code).toBe(0);
  }, 30_000);
});
