/**
 * harnessStateEmit — unit tests for the ONE shared harness_state emitter
 * (H1 inc.3). No spawn, no provider, no host loop: the session log is
 * materialized with SessionSpineMirror (same fixture style as
 * sessionSpine.test.ts's adopt/userMessage/close flow) and the emission is
 * observed through a captured sink + captured process.stderr.
 *
 * Covered (ADR-0023 R6 lifecycle-complete contract):
 *   - output 'json' → exactly one harness_state line with the derived
 *     sessionId / status 'completed' / one complete contract;
 *   - output 'plain' → strict no-op (no emit, no stderr);
 *   - unreadable session dir (events.jsonl as a DIRECTORY → EISDIR, never
 *     the ENOENT readSessionLog tolerates) → no throw, no emit, one stderr
 *     line containing 'harness_state unavailable'.
 *
 * Env discipline cribbed from runOneTurn.harnessState.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionSpineMirror } from '../sessionSpine.js';
import { emitHarnessStateEvent } from './harnessStateEmit.js';

const ENV_KEYS = ['ZELARI_SESSIONS_DIR', 'ZELARI_SESSION_SPINE'] as const;

let tmp: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-hstate-emit-'));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // resolveSessionsDir honors ZELARI_SESSIONS_DIR over workspaceRoot: pin it
  // to the tmp root so the helper's read and the fixture's write hit the
  // SAME dir regardless of the outer environment.
  process.env.ZELARI_SESSIONS_DIR = tmp;
  delete process.env.ZELARI_SESSION_SPINE; // spine mirror must be live
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  void fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

/** Materialize a minimal lifecycle-complete session log via the real mirror. */
async function writeCompletedSession(sessionId: string): Promise<void> {
  const mirror = await SessionSpineMirror.adopt(sessionId, {
    baseDir: process.env.ZELARI_SESSIONS_DIR!,
    quiet: true,
  });
  expect(mirror.status).toBe('active');
  mirror.userMessage('emit me');
  mirror.assistantMessage('done');
  await mirror.close('completed');
}

/** Capture stderr (and only stderr) around an async body. */
async function withCapturedStderr(fn: () => Promise<void>): Promise<{ text: string }> {
  const err = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = err;
  }
  return { text: chunks.join('') };
}

describe('emitHarnessStateEvent — shared harness_state final line (H1 inc.3)', () => {
  it('emits exactly one harness_state with the derived state when output is json', async () => {
    const sessionId = 'emit-happy';
    await writeCompletedSession(sessionId);

    const events: Array<Record<string, unknown>> = [];
    const { text } = await withCapturedStderr(async () => {
      await emitHarnessStateEvent({
        spine: { sessionId },
        workspaceRoot: tmp,
        output: 'json',
        emitEvent: (event) => events.push(event),
      });
    });

    expect(events).toHaveLength(1);
    const state = events[0] as {
      type: string;
      session: { sessionId: string; status: string };
      execution: {
        turnsTotal: number;
        contracts: Array<{ turn: number; complete: boolean; blockers: string[] }>;
      };
    };
    expect(state.type).toBe('harness_state');
    expect(state.session.sessionId).toBe(sessionId);
    expect(state.session.status).toBe('completed');
    // ADR-0023 R6: one turn, lifecycle-complete (user.message +
    // assistant.message, no tools, clean close), zero blockers.
    expect(state.execution.turnsTotal).toBe(1);
    expect(state.execution.contracts).toHaveLength(1);
    expect(state.execution.contracts[0]).toMatchObject({
      turn: 1,
      complete: true,
      blockers: [],
    });

    // Best-effort emission: nothing on stderr in the happy path.
    expect(text).not.toContain('harness_state unavailable');
  });

  it('is a strict no-op when output is not json — no emit, no stderr', async () => {
    const sessionId = 'emit-plain';
    await writeCompletedSession(sessionId);

    const events: Array<Record<string, unknown>> = [];
    const { text } = await withCapturedStderr(async () => {
      await emitHarnessStateEvent({
        spine: { sessionId },
        workspaceRoot: tmp,
        output: 'plain',
        emitEvent: (event) => events.push(event),
      });
    });

    expect(events).toHaveLength(0);
    expect(text).toBe('');
  });

  it('an unreadable session dir degrades to one stderr line — no throw, no emit', async () => {
    const sessionId = 'emit-unreadable';
    // events.jsonl as a DIRECTORY → readSessionLog rethrows EISDIR
    // (non-ENOENT, every platform) → readHarnessState propagates → the
    // helper must swallow it best-effort.
    await fs.mkdir(
      path.join(process.env.ZELARI_SESSIONS_DIR!, sessionId, 'events.jsonl'),
      { recursive: true },
    );

    const events: Array<Record<string, unknown>> = [];
    const { text } = await withCapturedStderr(async () => {
      await expect(
        emitHarnessStateEvent({
          spine: { sessionId },
          workspaceRoot: tmp,
          output: 'json',
          emitEvent: (event) => events.push(event),
        }),
      ).resolves.toBeUndefined(); // never throws
    });

    expect(events).toHaveLength(0);
    // ONE stderr line, exactly the promised format (prefix + message + \n).
    expect(text).toMatch(/^\[zelari-code --headless\] harness_state unavailable: .+\n$/);
  });
});
