/**
 * HarnessState on the wire — headless one-shot (runOneTurn, JSON surface).
 *
 * Product-level chain, IN-PROCESS (same seam discipline as
 * runOneTurn.strictExit.test.ts: the provider stream is injected, no spawn,
 * no live keys):
 *
 *   runOneTurn(kraken BUILD, output json, pack/strict off) → one clean pass →
 *   spine closes 'completed' → readHarnessState(<sessions>/<id>) derives the
 *   ADR-0023 read-model → ONE final NDJSON `harness_state` line on stdout:
 *   session.status 'completed', execution.contracts length 1, contract
 *   complete (user.message + assistant.message, no tools, clean close).
 *
 * Safety: when the session log is unreadable (here: events.jsonl exists as a
 * DIRECTORY under a pinned resumeSessionId — EISDIR/EPERM, never the ENOENT
 * readSessionLog tolerates), the emission degrades to a stderr warning and
 * the exit code is unchanged.
 *
 * Env discipline cribbed from runOneTurn.strictExit.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { runOneTurn } from './runOneTurn.js';
import { resetKrakenCandidates } from '../kraken/candidateRegistry.js';

const stubStream: ProviderStreamFn = async function* harnessStateStubStream() {
  yield { kind: 'text', delta: 'ok' };
  yield { kind: 'finish', reason: 'stop' };
};

// Task wording avoids EVERY expectsDiskImplementation cue (implement/write/
// edit/fix/build/…): the stub makes no tool calls, so buildLiveness must not
// demand disk mutations — the pass closes completed/exit-0.
const TASK = 'harness_state wire probe: reply with exactly ok and nothing else';

const ENV_KEYS = [
  'ZELARI_VERIFY_PACK',
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-hstate-'));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Pack OFF + strictDone:false ⇒ the strict gate never arms: one clean pass,
  // no repair, no verification.run — the evidence-less complete-by-lifecycle
  // contract of ADR-0023 (R6).
  process.env.ZELARI_VERIFY_PACK = '0';
  process.env.ZELARI_EXTENSIONS = '0';
  // Isolate the session spine on disk (the harness_state read resolves the
  // SAME dir via resolveSessionsDir({ workspaceRoot: cwd })).
  process.env.ZELARI_SESSIONS_DIR = path.join(tmp, 'sessions');
  process.env.ZELARI_VERIFIER_REVIEW = '0'; // 2.1 T4 advisory review: OFF
  process.env.ZELARI_MEMORY = '0'; // memory v2 off (serviceFactory short-circuit)
  delete process.env.ZELARI_STRICT_DONE;
  delete process.env.ZELARI_MISSION_STRICT;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  void fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

interface Captured {
  result: number;
  stdout: string[];
  stderr: string[];
}

async function captureOutput(fn: () => Promise<number>): Promise<Captured> {
  const out = process.stdout.write;
  const err = process.stderr.write;
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

function parseNdjson(chunks: string[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of chunks) {
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

function runTurn(resumeSessionId?: string): Promise<number> {
  return runOneTurn(
    {
      task: TASK,
      mode: 'kraken',
      phase: 'build',
      output: 'json',
      useCouncil: false,
      cwd: tmp,
      strictDone: false,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    },
    'openai-compatible',
    'hstate-fake',
    stubStream,
  );
}

describe('runOneTurn — harness_state as the final NDJSON line (json surface)', () => {
  it('a clean turn ends with one harness_state: completed session, one complete contract', async () => {
    resetKrakenCandidates();
    const { result: code, stdout, stderr } = await captureOutput(() => runTurn());

    expect(code).toBe(0);

    const events = parseNdjson(stdout);
    const state = events[events.length - 1] as {
      type: string;
      session: { sessionId: string; status: string };
      execution: {
        turnsTotal: number;
        contracts: Array<{ turn: number; complete: boolean; blockers: string[] }>;
      };
    };

    // The LAST NDJSON line of the turn is the harness read-model…
    expect(state.type).toBe('harness_state');
    expect(events.filter((e) => e.type === 'harness_state')).toHaveLength(1);
    // …for THIS spine session (same id the run announced in session_started)…
    const started = events.find((e) => e.type === 'session_started') as
      | { sessionId?: string }
      | undefined;
    expect(state.session.sessionId).toBe(started?.sessionId);
    // …with the session lens closed 'completed' and the ADR-0023 contract:
    // one turn, evidence-less but lifecycle-complete (R6), zero blockers.
    expect(state.session.status).toBe('completed');
    expect(state.execution.turnsTotal).toBe(1);
    expect(state.execution.contracts).toHaveLength(1);
    expect(state.execution.contracts[0]).toMatchObject({
      turn: 1,
      complete: true,
      blockers: [],
    });

    // Best-effort emission: nothing on stderr in the happy path.
    expect(stderr.join('')).not.toContain('harness_state unavailable');
  }, 30_000);

  it('an unreadable session log degrades to a stderr warning — exit code unchanged', async () => {
    resetKrakenCandidates();
    // Pin the session id and pre-create its events.jsonl as a DIRECTORY:
    // readSessionLog rethrows non-ENOENT errors (EISDIR/EPERM on every
    // platform), the spine degrades silently (adopt never throws), and the
    // harness_state emission must swallow the failure best-effort.
    const pinnedId = 'hstate-unreadable';
    await fs.mkdir(
      path.join(process.env.ZELARI_SESSIONS_DIR!, pinnedId, 'events.jsonl'),
      { recursive: true },
    );
    const { result: code, stdout, stderr } = await captureOutput(() => runTurn(pinnedId));

    // The turn outcome is untouched by the read failure…
    expect(code).toBe(0);
    // …no harness_state line was emitted…
    expect(parseNdjson(stdout).some((e) => e.type === 'harness_state')).toBe(false);
    // …and the failure is visible on stderr only.
    expect(stderr.join('')).toContain('harness_state unavailable');
  }, 30_000);
});
