/**
 * M1-EXIT — product-level bank proof, IN-PROCESS (no spawn of the CLI, no
 * live keys — the provider stream is injected, the only deterministic seam
 * runOneTurn has):
 *
 *   RED:   kraken BUILD over a fixture whose REAL test command fails
 *          (`node slug.test.mjs`, the anchor's slug fixture) → the gate arms
 *          (ZELARI_VERIFY_PACK) → exactly ONE automatic repair pass (budget
 *          = 1, structural) → still blocked → exit 4. The provider stream is
 *          invoked EXACTLY twice (initial pass + the single repair — waiting
 *          afterwards cannot mint a third pass), and the repair prompt
 *          carries the SHORT capped fail excerpt (M1.6), never the full log.
 *   GREEN: after the one-line fix (slug.js gains .toLowerCase()) the SAME
 *          command passes the gate → exit 0 with the stream invoked EXACTLY
 *          once: the verify path never calls the model — zero tokens on the
 *          green path.
 *
 * Hermetic by construction (discipline of runOneTurn.strictExit.test.ts):
 * `cwd` is a fresh mkdtemp (MUST exist — an absent cwd hangs shell-backed
 * commands on win32); the strict knobs ride opts (strictEnvOverlay), never
 * process.env; ZELARI_SESSIONS_DIR isolates each run's session spine; the
 * fixture ships its own package.json ("type":"module") so `slug.js` ESM
 * syntax parses on every Node without relying on module-syntax detection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { runOneTurn } from './runOneTurn.js';
import { resetKrakenCandidates } from '../kraken/candidateRegistry.js';

/** Buggy fixture (anchor blueprint): slugify WITHOUT the lowercase step. */
const SLUG_BUGGY = 'export function slug(text) {\n  return text.trim().replace(/\\s+/g, \'-\');\n}\n';
/** The one-line fix under test: lowercase added. */
const SLUG_FIXED = 'export function slug(text) {\n  return text.trim().replace(/\\s+/g, \'-\').toLowerCase();\n}\n';
const SLUG_TEST =
  "import { strict as assert } from 'node:assert';\n" +
  "import { slug } from './slug.js';\n" +
  "assert.strictEqual(slug('Hello World'), 'hello-world');\n" +
  "assert.strictEqual(slug('  already  dashed  '), 'already-dashed');\n" +
  "console.log('ok');\n";

// Task wording avoids EVERY expectsDiskImplementation cue (implement/write/
// edit/fix/build/…): the stub makes no tool calls, so buildLiveness must not
// demand disk mutations — the pass has to close completed/exit-0 for the
// strict gate to arm at all.
const TASK = 'M1-EXIT bench probe: reply with exactly ok and nothing else';

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

/** Stream invocation counter + last user prompts (the repair directive lands here). */
interface BenchStreamLog {
  count: number;
  prompts: string[];
}

/**
 * Stream FACTORY reference, not a consumed generator: runOneTurn invokes it
 * once per pass and the harness iterates the returned generator per pass.
 */
function makeCountingStream(log: BenchStreamLog): ProviderStreamFn {
  return async function* exitBenchStream(params) {
    log.count += 1;
    const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
    const content = lastUser?.content;
    log.prompts.push(typeof content === 'string' ? content : JSON.stringify(content ?? ''));
    yield { kind: 'text', delta: 'ok' };
    yield { kind: 'finish', reason: 'stop' };
  };
}

let tmp: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  // mkdtemp CREATES the dir: an absent cwd makes the pack's shell-backed
  // command execution hang (observed >30s on win32) instead of failing fast.
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-exit-bench-'));
  await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
  await fs.writeFile(path.join(tmp, 'slug.js'), SLUG_BUGGY, 'utf-8');
  await fs.writeFile(path.join(tmp, 'slug.test.mjs'), SLUG_TEST, 'utf-8');
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Native pack ON with the REAL test command relative to the gate's cwd
  // (NodeShellProvider resolves commands against the workspace root); the
  // typecheck/build slots are explicitly off ('' = disabled).
  process.env.ZELARI_VERIFY_PACK = '1';
  process.env.ZELARI_VERIFY_TYPECHECK_CMD = '';
  process.env.ZELARI_VERIFY_TEST_CMD = 'node slug.test.mjs';
  process.env.ZELARI_VERIFY_BUILD_CMD = '';
  process.env.ZELARI_VERIFY_TIMEOUT_MS = '10000';
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

describe('M1-EXIT — kraken headless bank: red exits 4 after ONE repair, green exits 0 model-free', () => {
  it(
    'red: failing test → 4 with exactly 2 stream calls and the capped excerpt; green: fixed test → 0 with 1 call',
    async () => {
      // --- RED RUN: the fixture's real test command fails (slug lacks the lowercase).
      const red: BenchStreamLog = { count: 0, prompts: [] };
      const { result: redCode, lines: redLines } = await captureOutput(() =>
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
          'm1-exit-fake',
          makeCountingStream(red),
        ),
      );

      // The heart of M1-EXIT: STRICT_DONE_EXIT_CODE, never the error exit (3).
      expect(redCode).toBe(4);

      // Provenance: the 4 comes from the strict path over the REAL command.
      const redEvents = parseNdjson(redLines);
      const redRun = redEvents.find((e) => e.type === 'verification_run') as
        | { strict?: boolean; verdict?: string; engine?: string }
        | undefined;
      expect(redRun, 'the strict gate must have emitted verification_run').toBeDefined();
      expect(redRun!.strict).toBe(true);
      expect(redRun!.verdict).not.toBe('PASS');
      expect(String(redRun!.engine)).toContain('criteria-pack');

      // Budget = 1 proven by the model-call counter: initial pass + ONE repair.
      expect(red.count).toBe(2);
      const redJoined = redLines.join('');
      expect(redJoined).toContain('forcing repair pass');
      expect(redJoined).toContain('still blocked after repair pass');

      // M1.6: the repair directive carried the SHORT capped fail excerpt —
      // the engine detail (`exit N (expected 0) — stderr: <tail>`) is the
      // captured fail, bounded far below the full command log.
      const repairPrompt = red.prompts[red.prompts.length - 1] ?? '';
      expect(repairPrompt).toContain('Failure excerpt (tail, capped 2000 chars)');
      expect(repairPrompt).toContain('exit 1 (expected 0)');
      expect(repairPrompt).toContain('The test suite passes');
      expect(repairPrompt.length).toBeLessThan(12_000);

      // No third pass can appear after the fact: the counter is final.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(red.count).toBe(2);

      // --- GREEN RUN: the one-line fix lands; the SAME command must pass the
      // gate WITHOUT any further model call (stream invoked exactly once —
      // the verify path is deterministic, zero tokens).
      await fs.writeFile(path.join(tmp, 'slug.js'), SLUG_FIXED, 'utf-8');
      // Fresh session spine: a new run must not inherit the blocked verdict.
      process.env.ZELARI_SESSIONS_DIR = path.join(tmp, 'sessions-green');
      const green: BenchStreamLog = { count: 0, prompts: [] };
      const { result: greenCode, lines: greenLines } = await captureOutput(() =>
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
          'm1-exit-fake',
          makeCountingStream(green),
        ),
      );

      const greenEvents = parseNdjson(greenLines);
      expect(greenCode).toBe(0);
      const greenRun = greenEvents.find((e) => e.type === 'verification_run') as
        | { strict?: boolean; verdict?: string }
        | undefined;
      expect(greenRun, 'the strict gate must have emitted verification_run').toBeDefined();
      expect(greenRun!.strict).toBe(true);
      expect(greenRun!.verdict).toBe('PASS');
      // Zero tokens on the verify path: no model call beyond the initial pass.
      expect(green.count).toBe(1);
      expect(greenLines.join('')).not.toContain('forcing repair pass');
    },
    60_000,
  );
});
