/**
 * S2 — deterministic MISSION end-to-end smoke: slice-from-plan + strict-done.
 *
 * The product chain, IN-PROCESS (no CLI spawn, no live keys — the provider
 * stream is injected, the only deterministic seam the mission path has):
 *
 *   fixture `.zelari/plan.json` (2 pending tasks) → dispatchHeadlessTurn (mode
 *   'zelari') → buildMissionBrief chunks the open plan task ids →
 *   runZelariMission starts on slices[0] = 'slice-mvp' bound to those ids → ONE
 *   implementation slice (ZELARI_MISSION_MAX_ITER=1) writes a real project file
 *   → mission claims `success` → the mission-close strict gate
 *   (evaluateStrictBuildGate surface 'mission', native criteria pack ON):
 *
 *   RED   pack command fails → blocked → strictGateExitCode → 4
 *   GREEN same fixture/run, only that command's exit status flipped
 *         → PASS with spine-anchored evidence → 0
 *
 * Both cases first assert the mission really claimed done (`.zelari/
 * mission-state.json` status 'success'): the 4 is the strict verdict on a
 * success CLAIM, not a mission that merely stopped — `stopped`/`stalled` close 0.
 *
 * Hermetic: `cwd` is a fresh mkdtemp WITHOUT package.json (the repo-adaptive
 * pack binds nothing beyond ZELARI_VERIFY_TYPECHECK_CMD — `exit 0`/`exit 1` are
 * shell builtins, win32-proof — and the project smoke skips instead of spawning
 * npm); the slice's write goes through the REAL write_file registry so
 * `writeCount > 0` (a hard gate in zelariMission.driveMission) is earned; and
 * ZELARI_SESSIONS_DIR isolates the session spine (the evidence count the claim
 * site reads) while the strict knobs stay ON.
 *
 * Env discipline + stdout capture cribbed from runOneTurn.strictExit.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { dispatchHeadlessTurn } from '../runHeadless.js';
import { STRICT_DONE_EXIT_CODE } from '../kraken/verificationBridge.js';

/** File the stub writes into the fixture workspace (real write_file call). */
const FIXTURE_WRITE = 'fixture-slice.md';

/**
 * Stream FACTORY reference, not a consumed generator: the harness invokes it
 * once per provider round-trip. Turn 1 performs THE one real project write the
 * mission slice needs (0 writes is a hard non-green gate), every later turn is
 * a pure-text close, so the tool loop terminates deterministically.
 */
function stubStream(writePath: string = FIXTURE_WRITE): ProviderStreamFn {
  let calls = 0;
  return async function* s2MissionStubStream() {
    calls += 1;
    if (calls === 1) {
      yield {
        kind: 'tool_call',
        toolCallId: 's2-write-1',
        toolName: 'write_file',
        args: { path: writePath, content: '# s2 fixture slice\n' },
      };
      yield { kind: 'finish', reason: 'tool_calls' };
      return;
    }
    yield { kind: 'text', delta: 'ok' };
    yield { kind: 'finish', reason: 'stop' };
  };
}

// 'fix …plan tasks' → resolveCouncilRunMode implementation (no design-phase
// pass), and no expectsDiskImplementation mismatch: the stub really writes.
const TASK = 'fix the two pending plan tasks in this fixture workspace';

const ENV_KEYS = [
  'ZELARI_VERIFY_PACK',
  'ZELARI_VERIFY_TYPECHECK_CMD',
  'ZELARI_VERIFY_TEST_CMD',
  'ZELARI_VERIFY_BUILD_CMD',
  'ZELARI_VERIFY_TIMEOUT_MS',
  'ZELARI_EXTENSIONS',
  'ZELARI_SESSIONS_DIR',
  'ZELARI_SESSION_SPINE',
  'ZELARI_VERIFIER_REVIEW',
  'ZELARI_MEMORY',
  'ZELARI_STRICT_DONE',
  'ZELARI_MISSION_STRICT',
  'ZELARI_MISSION_MAX_ITER',
  'ZELARI_CHECKPOINT',
  'ZELARI_COUNCIL_MODE',
  'ZELARI_ALLOW_UNVERIFIED',
] as const;

/** The plan task ids the fixture opens — the slice EXPECTED to be derived. */
const PLAN_TASK_IDS = ['t1', 't2'];

let tmp: string;
let savedEnv: Record<string, string | undefined>;

/** `.zelari/plan.json` with 2 PENDING tasks → the mission derives slice-mvp. */
async function writePlanFixture(root: string): Promise<void> {
  const tasks = PLAN_TASK_IDS.map((id, i) => ({
    id,
    title: `Fixture task ${i + 1}`,
    status: 'pending',
  }));
  const plan = { schemaVersion: 1, counter: tasks.length, tasks };
  await fs.mkdir(path.join(root, '.zelari'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.zelari', 'plan.json'),
    JSON.stringify(plan, null, 2) + '\n',
    'utf8',
  );
}

beforeEach(async () => {
  // mkdtemp CREATES the dir: an absent cwd makes the pack's shell-backed
  // command execution hang (observed on win32) instead of failing fast.
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-s2-mission-'));
  await writePlanFixture(tmp);
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Native criteria pack ON; the red case overwrites the typecheck command.
  process.env.ZELARI_VERIFY_PACK = '1';
  process.env.ZELARI_VERIFY_TYPECHECK_CMD = 'exit 1';
  process.env.ZELARI_VERIFY_TEST_CMD = '';
  process.env.ZELARI_VERIFY_BUILD_CMD = '';
  process.env.ZELARI_VERIFY_TIMEOUT_MS = '5000';
  // Skip the extension loader; isolate the session spine (and the
  // verification.evidence count) inside the temp dir.
  process.env.ZELARI_EXTENSIONS = '0';
  process.env.ZELARI_SESSIONS_DIR = path.join(tmp, 'sessions');
  process.env.ZELARI_SESSION_SPINE = '1';
  process.env.ZELARI_VERIFIER_REVIEW = '0';
  process.env.ZELARI_MEMORY = '0';
  // One implementation slice: bounded runtime, one write, one gate.
  process.env.ZELARI_MISSION_MAX_ITER = '1';
  process.env.ZELARI_CHECKPOINT = '0'; // no git checkpoint inside the fixture
  // Never let a developer-machine environment leak into the product path.
  delete process.env.ZELARI_STRICT_DONE;
  delete process.env.ZELARI_MISSION_STRICT;
  delete process.env.ZELARI_COUNCIL_MODE;
  delete process.env.ZELARI_ALLOW_UNVERIFIED;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Bounded cleanup: maxRetries is the canonical win32 EBUSY/EPERM remedy, the
  // race caps the wait so a locked dir is left behind instead of stalling.
  try {
    await Promise.race([
      fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    /* win32 EBUSY / already gone — leftover %TEMP% dirs are OK */
  }
}, 5_000);

/** Capture (and swallow) stdout+stderr while the mission emits NDJSON. */
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
  try {
    return { result: await fn(), lines };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

function parseNdjson(lines: string[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const chunk of lines.join('').split('\n')) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      /* non-NDJSON stdout noise */
    }
  }
  return events;
}

/** One whole mission run on the current fixture; returns the exit code. */
async function runMission(): Promise<{ code: number; lines: string[] }> {
  const { result, lines } = await captureOutput(() =>
    dispatchHeadlessTurn(
      { task: TASK, mode: 'zelari', phase: 'build', output: 'json', cwd: tmp },
      'openai-compatible',
      's2-fake',
      stubStream(),
    ),
  );
  return { code: result, lines };
}

type GateResult = {
  criterionId: string;
  status?: string;
  detail?: string;
  evidence?: Array<{ tier?: string; ref?: string; seq?: number }>;
};

/** The `verification_run` NDJSON payload of the mission-close strict gate. */
type GatePayload = {
  strict?: boolean;
  verdict?: string;
  engine?: string;
  unverified?: boolean;
  native?: {
    packId?: string;
    criteria?: Array<{ id: string; required?: boolean }>;
    results?: GateResult[];
  };
};

function gatePayload(lines: string[]): GatePayload {
  const event = parseNdjson(lines).find((e) => e.type === 'verification_run');
  expect(event, 'the strict gate must have emitted verification_run').toBeDefined();
  return event as GatePayload;
}

/**
 * Result of the native pack's REQUIRED criterion — in this fixture the pack
 * (`zelari-coding/v1`) binds ZELARI_VERIFY_TYPECHECK_CMD to it, and that
 * command's exit status is the ONLY input differing between RED and GREEN.
 */
function requiredResult(payload: GatePayload): GateResult {
  const required = (payload.native?.criteria ?? []).filter((c) => c.required).map((c) => c.id);
  expect(required.length, 'the native pack must bind a required criterion').toBeGreaterThan(0);
  const hit = (payload.native?.results ?? []).find((r) => required.includes(r.criterionId));
  expect(hit, `required criterion ${required.join(', ')} must be evaluated`).toBeDefined();
  return hit!;
}

/**
 * Slice-from-plan lock, read from the persisted mission state (a product
 * artifact): the mission started on 'slice-mvp' bound to the fixture's PENDING
 * task ids and CLAIMED success.
 */
async function assertMissionClaimedDoneOnMvpSlice(): Promise<void> {
  const raw = await fs.readFile(path.join(tmp, '.zelari', 'mission-state.json'), 'utf8');
  const state = JSON.parse(raw) as {
    status: string;
    currentSliceId: string;
    brief: { slices: Array<{ id: string; taskIds?: string[] }> };
  };
  expect(state.status, 'the mission must CLAIM done — otherwise nothing is gated').toBe('success');
  expect(state.currentSliceId).toBe('slice-mvp');
  expect(state.brief.slices[0].id).toBe('slice-mvp');
  expect(state.brief.slices[0].taskIds).toEqual(PLAN_TASK_IDS);
  // The slice's real write landed on disk (writeCount > 0 was earned).
  await expect(fs.readFile(path.join(tmp, FIXTURE_WRITE), 'utf8')).resolves.toContain('s2 fixture');
}

describe('S2 — mission e2e: slice-from-plan + strict-done (in-process)', () => {
  it('RED: mission claims done, native pack fails → exit 4 (STRICT_DONE_EXIT_CODE)', async () => {
    const { code, lines } = await runMission();

    // The heart of the smoke: STRICT_DONE_EXIT_CODE, not transport (3)/usage (2).
    expect(code).toBe(STRICT_DONE_EXIT_CODE);
    expect(code).toBe(4);

    // Provenance: the 4 comes from the mission-close strict gate, which really
    // ran the native pack, really BLOCKED, and blocked on an EVALUATED
    // criterion (an `unverified` block would mean nothing was bound at all).
    const payload = gatePayload(lines);
    expect(payload.strict).toBe(true);
    expect(payload.verdict).not.toBe('PASS');
    expect(String(payload.engine)).toContain('criteria-pack');
    expect(payload.unverified, 'RED blocks on a real command, not on "nothing to evaluate"').toBeUndefined();
    expect(payload.native?.results?.length ?? 0).toBeGreaterThan(0);
    const evaluated = requiredResult(payload);
    expect(evaluated.status).toBe('fail');
    // …and the failing command really is the injected one.
    expect(String(evaluated.detail)).toContain('exit 1');

    await assertMissionClaimedDoneOnMvpSlice();
  }, 60_000);

  it('GREEN: same fixture, same claim, pack command passes → exit 0', async () => {
    // ONLY the criteria-pack outcome flips: strict stays ON, pack stays ON,
    // strictDone is never opted out — the contract, not an escape hatch.
    process.env.ZELARI_VERIFY_TYPECHECK_CMD = 'exit 0';

    const { code, lines } = await runMission();

    const payload = gatePayload(lines);
    expect(payload.strict).toBe(true);
    expect(payload.verdict).toBe('PASS');
    const evaluated = requiredResult(payload);
    expect(evaluated.status).toBe('pass');
    // Event-backed: the passing command anchored on the session spine (seq) and
    // the evidence ref names the very command that ran…
    const refs = (evaluated.evidence ?? []).map((e) => String(e.ref ?? '')).join(' ');
    expect(refs).toContain('exit 0');
    // …which is what lets the mission claim site count ≥1 verification.evidence.
    expect(evaluated.evidence?.some((e) => typeof e.seq === 'number')).toBe(true);

    expect(code).toBe(0);
    await assertMissionClaimedDoneOnMvpSlice();
  }, 60_000);

  it('CONTROL: pack off + explicit waiver → the same red fixture does NOT close 4', async () => {
    // The pack is an autonomous strict switch, so the waiver must cover both
    // surfaces to disarm the gate: pack off (nothing evaluable) + the recorded
    // --allow-unverified hatch. Same fixture, same claim, same failing command
    // in the env — only the STRICT CONTRACT is withdrawn.
    process.env.ZELARI_VERIFY_PACK = '0';
    process.env.ZELARI_ALLOW_UNVERIFIED = '1';

    const { code } = await runMission();

    expect(code).not.toBe(STRICT_DONE_EXIT_CODE);
    expect(code).toBe(0);
    // Sharper: the run is still a full success claim on the MVP slice, so the
    // 4 of the RED case cannot be a boot/stop artifact of this fixture.
    await assertMissionClaimedDoneOnMvpSlice();
  }, 60_000);
});
