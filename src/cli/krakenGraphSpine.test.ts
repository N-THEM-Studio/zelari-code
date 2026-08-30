/**
 * W1 — the `--kraken-graph` headless path opens the ADR-0016 session spine.
 *
 * End-to-end IN-PROCESS via dispatchHeadlessTurn (same seam policyGate.test.ts
 * uses): planner/executor are the LLM seams and are stubbed; the spine is
 * REAL. Asserts the on-disk contract under `<workspace>/.zelari/sessions`:
 *   (a) a JSONL session log exists after the run;
 *   (b) session.started envelope + user.message carrying the graph goal;
 *   (c) session.ended with the right close reason (completed / cancelled);
 *   (d) ZELARI_KRAKEN_GRAPH=0 disables BEFORE the spine opens — no log left.
 *
 * Env discipline + stdout capture cribbed from runOneTurn.strictExit.test.ts;
 * spineLogs helper from policyGate.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { readSessionLog } from '@zelari/core/session';
import { dispatchHeadlessTurn } from './runHeadless.js';

const GOAL = 'w1 spine probe: add one function to src/util.ts';

// The planner is an LLM seam — a fixed graph keeps the run deterministic.
vi.mock('./kraken/planner.js', () => ({
  planTaskGraph: async () => ({ id: 'graph-w1', nodes: new Map() }),
}));

// Topology rendering is not under test — fixed strings decouple the run from
// the executor summary shape.
vi.mock('./kraken/graphStatus.js', () => ({
  formatKrakenGraphAscii: () => 'ascii',
  formatKrakenGraphDigest: () => 'digest',
}));

// Fake executor. `fireSigint` lets the cancelled-path test trigger the SAME
// process signal the real handler (process.once('SIGINT')) listens for, so
// the abort → close('cancelled') branch runs exactly as on a real Ctrl-C.
let fireSigint = false;
vi.mock('./kraken/executor.js', () => ({
  // Mirror the real kill-switch contract: only the literal '0' disables.
  isKrakenGraphEnabled: (env: NodeJS.ProcessEnv = process.env) => env.ZELARI_KRAKEN_GRAPH !== '0',
  KrakenGraphExecutor: class {
    constructor(_opts: { signal?: AbortSignal }) {}
    async execute() {
      if (fireSigint) process.emit('SIGINT');
      return {
        converged: !fireSigint,
        cancelled: fireSigint,
        graph: { id: 'graph-w1', nodes: new Map() },
        durationsMs: {},
        unresolvedFindings: [],
      };
    }
  },
}));

const ENV_KEYS = ['ZELARI_KRAKEN_GRAPH', 'ZELARI_SESSIONS_DIR', 'ZELARI_MEMORY'] as const;

let tmp: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zelari-w1-spine-'));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.ZELARI_KRAKEN_GRAPH; // engine enabled (default)
  // No env override: sessions must land under <workspace>/.zelari/sessions.
  delete process.env.ZELARI_SESSIONS_DIR;
  process.env.ZELARI_MEMORY = '0'; // memory v2 off (serviceFactory short-circuit)
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fireSigint = false;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/** Session spine logs under the tmp workspace (paths, per policyGate.test.ts). */
function spineLogs(root: string): string[] {
  const sessions = path.join(root, '.zelari', 'sessions');
  if (!fs.existsSync(sessions)) return [];
  return fs
    .readdirSync(sessions)
    .map((id) => path.join(sessions, id, 'events.jsonl'))
    .filter((p) => fs.existsSync(p));
}

/** Capture (and swallow) stdout+stderr while the run emits NDJSON. */
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
  const restore = (): void => {
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

function runGraph(): Promise<{ result: number; lines: string[] }> {
  const unreachableStream = (() => {
    throw new Error('provider stream must not be reached by the kraken-graph path');
  }) as unknown as ProviderStreamFn;
  return captureOutput(() =>
    dispatchHeadlessTurn(
      {
        task: GOAL,
        krakenGraph: GOAL,
        mode: 'kraken',
        phase: 'build',
        output: 'json',
        useCouncil: false,
        cwd: tmp,
      },
      'w1-provider',
      'w1-fake-model',
      unreachableStream,
      { policyGateDone: true }, // gate coverage is policyGate.test.ts's job
    ),
  );
}

describe('W1 — kraken-graph opens the ADR-0016 session spine', () => {
  it('success: session log under <workspace>/.zelari/sessions with envelope + goal, closed completed', async () => {
    const { result: code } = await runGraph();
    expect(code).toBe(0);

    // (a) exactly ONE session log, at the documented workspace location.
    const logs = spineLogs(tmp);
    expect(logs).toHaveLength(1);
    const events = (await readSessionLog(logs[0]!)).events;

    // (b) session envelope first + user message carrying the graph goal.
    expect(events[0]!.kind).toBe('session.started');
    const userMsg = events.find((e) => e.kind === 'user.message');
    expect(userMsg).toBeDefined();
    expect((userMsg!.data as { text?: string } | undefined)?.text).toBe(GOAL);

    // (c) clean close.
    const ended = events.at(-1)!;
    expect(ended.kind).toBe('session.ended');
    expect((ended.data as { reason?: string }).reason).toBe('completed');
  }, 30_000);

  it('SIGINT mid-graph closes the spine as cancelled (exit 3, ended log present)', async () => {
    fireSigint = true;
    const { result: code } = await runGraph();
    expect(code).toBe(3); // non-converged graph exit, spine stays out of it

    const logs = spineLogs(tmp);
    expect(logs).toHaveLength(1);
    const events = (await readSessionLog(logs[0]!)).events;
    const ended = events.at(-1)!;
    expect(ended.kind).toBe('session.ended');
    expect((ended.data as { reason?: string }).reason).toBe('cancelled');
  }, 30_000);

  it('ZELARI_KRAKEN_GRAPH=0: exit 1 and NO session file left behind', async () => {
    process.env.ZELARI_KRAKEN_GRAPH = '0';
    const { result: code } = await runGraph();
    expect(code).toBe(1);
    // (d) the kill-switch fires BEFORE the spine opens — nothing on disk.
    expect(spineLogs(tmp)).toHaveLength(0);
    expect(existsSync(path.join(tmp, '.zelari', 'sessions'))).toBe(false);
  }, 30_000);
});
