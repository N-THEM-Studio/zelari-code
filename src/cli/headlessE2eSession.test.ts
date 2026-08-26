/**
 * F11 / Exit-3.6 — headless session smoke, end-to-end (doc §14).
 *
 * Product-level chain, executed against the REAL `runHeadless` pipeline for
 * both Kraken and Council:
 *
 *   headless run → session_started (NDJSON) → session id → --resume second
 *   turn → --export-session → fresh reader/replay → same semantic trajectory
 *
 * The ONLY mocked seam is `provider/resolveStream.js` (deterministic echo
 * stream — "provider fake/deterministici dove possibile"): key resolution,
 * spine open/resume, dual-write, export and replay are all the real product
 * code paths a Desktop host exercises.
 *
 * Trajectory equality: deriveMessages() over (a) the log after turn 2,
 * (b) a second fresh readSessionLog (new reader), (c) the exported
 * zelari-session-export/1 events — all three must be deep-equal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveMessages, readSessionLog } from '@zelari/core/session';

vi.mock('./provider/resolveStream.js', () => ({
  // Deterministic provider: reply echoes the tail of the last user message,
  // so turn 1 and turn 2 replies differ deterministically. Pure text — no
  // tool calls — which is exactly the Desktop Q&A turn shape.
  buildProviderStream: () =>
    async function* fakeDeterministicStream(params: {
      messages: Array<{ role: string; content: unknown }>;
    }) {
      const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
      const raw = lastUser?.content;
      const text =
        typeof raw === 'string' ? raw : JSON.stringify(raw ?? 'no-user');
      yield { kind: 'text', delta: `e2e-reply:${text.slice(-48)}` };
      yield { kind: 'finish', reason: 'stop' };
    },
}));

import { runHeadless } from './runHeadless.js';

let tmp: string;
let sessionsDir: string;
let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = [
  'OPENAI_API_KEY',
  'ZELARI_SESSIONS_DIR',
  'ZELARI_LOCAL_CLI',
  'ZELARI_STRICT_DONE',
  'ZELARI_VERIFY_PACK',
  'ZELARI_PERM_SOCKET',
] as const;

beforeEach(() => {
  tmp = path.join(os.tmpdir(), `zelari-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sessionsDir = path.join(tmp, 'sessions');
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.OPENAI_API_KEY = 'e2e-deterministic-key';
  process.env.ZELARI_SESSIONS_DIR = sessionsDir;
  // Never let a developer-machine environment leak into the product path.
  delete process.env.ZELARI_LOCAL_CLI;
  process.env.ZELARI_STRICT_DONE = '0'; // P0.1 default ON — keep e2e hermetic
  process.env.ZELARI_VERIFY_PACK = '0'; // P0.2 default ON — keep e2e hermetic
  delete process.env.ZELARI_PERM_SOCKET;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fs.rm(tmp, { recursive: true, force: true });
});

/** Capture (and swallow) stdout+stderr while the headless run emits NDJSON. */
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

function parseNdjson(lines: string[]): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    for (const part of line.split('\n')) {
      const t = part.trim();
      if (!t.startsWith('{')) continue;
      try {
        events.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        /* not JSON — ignore */
      }
    }
  }
  return events;
}

function trajectory(events: Awaited<ReturnType<typeof readSessionLog>>['events']): string[] {
  return deriveMessages(events).map((m) => `${m.role}:${m.content}`);
}

/**
 * The full §14 chain for one mode. Everything asserted here is the contract
 * a Desktop host depends on: stable session id across turns, seq continuity,
 * export round-trip, replay determinism.
 */
async function runModeChain(mode: 'kraken' | 'council'): Promise<void> {
  const base = {
    mode,
    phase: 'build',
    useCouncil: false,
    output: 'json',
    provider: 'openai-compatible',
    model: 'e2e-fake-model',
  } as const;

  // --- Turn 1: fresh run → session_started → session id -------------------
  const t1 = await captureOutput(() =>
    runHeadless({ ...base, task: `e2e smoke ${mode} turn one question` }),
  );
  expect(t1.result, `${mode} turn 1 must exit 0`).toBe(0);
  const started = parseNdjson(t1.lines).find((e) => e.type === 'session_started');
  expect(started, `${mode} turn 1 must emit session_started NDJSON`).toBeDefined();
  const sessionId = String(started!.sessionId);
  expect(sessionId.length).toBeGreaterThan(0);

  const logPath = path.join(sessionsDir, sessionId, 'events.jsonl');
  const after1 = await readSessionLog(logPath);
  expect(after1.ok).toBe(true);
  expect(after1.issues).toEqual([]);
  expect(after1.events.some((e) => e.kind === 'session.started')).toBe(true);
  expect(after1.events.some((e) => e.kind === 'user.message')).toBe(true);
  expect(after1.events.some((e) => e.kind === 'assistant.message')).toBe(true);

  // --- Turn 2: resume SAME id + export ------------------------------------
  const exportPath = path.join(tmp, `export-${mode}.json`);
  const t2 = await captureOutput(() =>
    runHeadless({
      ...base,
      task: `e2e smoke ${mode} turn two question`,
      resumeSessionId: sessionId,
      exportSessionPath: exportPath,
    }),
  );
  expect(t2.result, `${mode} turn 2 (resume) must exit 0`).toBe(0);

  const after2 = await readSessionLog(logPath);
  expect(after2.ok).toBe(true);
  expect(after2.issues).toEqual([]);
  expect(after2.events.some((e) => e.kind === 'session.resumed')).toBe(true);
  // Same log, seq still monotonic from 1 — resume adopts, never rewrites.
  after2.events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  expect(after2.events.length).toBeGreaterThan(after1.events.length);

  // Both turns are in the canonical trajectory, in order.
  const users = trajectory(after2.events).filter((t) => t.startsWith('user:'));
  const i1 = users.findIndex((u) => u.includes('turn one question'));
  const i2 = users.findIndex((u) => u.includes('turn two question'));
  expect(i1, 'turn one prompt must be in the derived trajectory').toBeGreaterThanOrEqual(0);
  expect(i2, 'turn two prompt must be in the derived trajectory').toBeGreaterThan(i1);

  // --- Export round-trip (zelari-session-export/1) ------------------------
  const exported = JSON.parse(await fs.readFile(exportPath, 'utf8')) as {
    events: Awaited<ReturnType<typeof readSessionLog>>['events'];
  };
  expect(exported.events.length).toBe(after2.events.length);

  // --- Fresh reader/replay → same semantic trajectory ---------------------
  const freshRead = await readSessionLog(logPath);
  expect(freshRead.ok).toBe(true);
  const fromLog = trajectory(after2.events);
  const fromFresh = trajectory(freshRead.events);
  const fromExport = trajectory(exported.events);
  expect(fromFresh, 'two fresh replays must be deep-equal').toEqual(fromLog);
  expect(fromExport, 'export must carry the same semantic trajectory').toEqual(fromLog);
  expect(fromLog.some((t) => t.startsWith('assistant:e2e-reply:'))).toBe(true);
}

describe('Exit-3.6 — headless session e2e smoke (run → resume → export → replay)', () => {
  it('kraken: full chain preserves the semantic trajectory', async () => {
    await runModeChain('kraken');
    // 90s: the kraken chain cold-imports the whole headless pipeline in-process;
    // under full-suite parallel load (341 files on vitest 4) 30s proved too
    // tight — in isolation the whole file runs in ~11s.
  }, 90_000);

  it('council: full chain preserves the semantic trajectory', async () => {
    await runModeChain('council');
  }, 30_000);
});
