/**
 * K1.7 / F7 — non-strict turns must leave an honest verification.run.
 *
 * Hole: with strict off (and the pack off) runOneTurn writes no record, so
 * replay cannot tell "never evaluated" from "session never started" and the
 * resume/TUI summary stays silent. After the fix: verdict:null +
 * status:UNEVALUATED on the spine, and lastVerificationRun.summary is
 * `unverified-open`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { lastVerificationRun } from '@zelari/core/verification';
import { readSessionLog, resolveSessionsDir } from '@zelari/core/session';
import { runOneTurn } from '../headless/runOneTurn.js';
import { openHeadlessSpine } from '../headlessSpine.js';
import { resetKrakenCandidates } from './candidateRegistry.js';
import {
  honestUnevaluatedPayload,
  replayVerificationFlag,
  STRICT_OFF_REASON,
  UNEVALUATED_STATUS,
  UNVERIFIED_OPEN,
} from './verifyHonestVerdict.js';

const stubStream: ProviderStreamFn = async function* k17StubTurnStream() {
  yield { kind: 'text', delta: 'ok' };
  yield { kind: 'finish', reason: 'stop' };
};

const TASK = 'k17 honest-verdict probe: reply with exactly ok and nothing else';

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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-k17-'));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ZELARI_VERIFY_PACK = '0';
  process.env.ZELARI_EXTENSIONS = '0';
  process.env.ZELARI_SESSIONS_DIR = path.join(tmp, 'sessions');
  process.env.ZELARI_VERIFIER_REVIEW = '0';
  process.env.ZELARI_MEMORY = '0';
  process.env.ZELARI_STRICT_DONE = '0';
  delete process.env.ZELARI_MISSION_STRICT;
  resetKrakenCandidates();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetKrakenCandidates();
  // win32: cmd.exe can hold the tmp dir (EBUSY/EPERM) — never fail the suite
  // on cleanup; leak is isolated under os.tmpdir().
  void fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const tap = (s: string | Uint8Array, ..._rest: unknown[]): boolean => {
    chunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  };
  process.stdout.write = tap as typeof process.stdout.write;
  process.stderr.write = tap as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, lines: chunks.join('').split(/\r?\n/) };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('K1.7 honestUnevaluatedPayload', () => {
  it('is verdict:null + UNEVALUATED + strict-off, never a fake PASS', () => {
    const payload = honestUnevaluatedPayload('kraken');
    expect(payload.verdict).toBeNull();
    expect(payload.status).toBe(UNEVALUATED_STATUS);
    expect(payload.strict).toBe(false);
    expect(payload.reason).toBe(STRICT_OFF_REASON);
    expect(payload.surface).toBe('kraken');
    expect(payload.summary).toBe(UNVERIFIED_OPEN);
    expect(JSON.parse(JSON.stringify(payload)).verdict).toBeNull();
  });
});

describe('K1.7 replay lastVerificationRun → unverified-open', () => {
  it('spine round-trip of an UNEVALUATED record exposes unverified-open', async () => {
    const handle = await openHeadlessSpine({
      sessionId: 'k17-replay',
      baseDir: path.join(tmp, 'sessions'),
      quiet: true,
    });
    handle.verificationRun(honestUnevaluatedPayload('kraken'));
    await handle.spine.flush();

    const eventsPath = path.join(resolveSessionsDir({ baseDir: path.join(tmp, 'sessions') }), 'k17-replay', 'events.jsonl');
    const report = await readSessionLog(eventsPath);
    const raw = [...report.events].reverse().find((e) => e.kind === 'verification.run');
    expect(raw).toBeDefined();
    expect((raw!.data as { verdict: unknown }).verdict).toBeNull();
    expect((raw!.data as { status: string }).status).toBe(UNEVALUATED_STATUS);

    const snap = lastVerificationRun(report.events);
    expect(snap).not.toBeNull();
    expect(snap!.strict).toBe(false);
    expect(snap!.summary).toBe(UNVERIFIED_OPEN);
    expect(replayVerificationFlag(snap)).toBe(UNVERIFIED_OPEN);
    await handle.close('test-done');
  });
});

describe('K1.7 non-strict runOneTurn emits UNEVALUATED', () => {
  it('completed kraken BUILD with strictDone:false + pack off writes verification.run', async () => {
    const sessionId = 'k17-nonstrict-turn';
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
          resumeSessionId: sessionId,
        },
        'openai-compatible',
        'k17-fake',
        stubStream,
      ),
    );
    expect(code).toBe(0);

    const eventsPath = path.join(resolveSessionsDir({ env: process.env }), sessionId, 'events.jsonl');
    const report = await readSessionLog(eventsPath);
    const raw = [...report.events].reverse().find((e) => e.kind === 'verification.run');
    expect(raw, 'non-strict turn must append verification.run').toBeDefined();
    const data = raw!.data as Record<string, unknown>;
    expect(data.verdict).toBeNull();
    expect(data.status).toBe('UNEVALUATED');
    expect(data.strict).toBe(false);
    expect(data.reason).toBe('strict-off');

    const snap = lastVerificationRun(report.events);
    expect(snap).not.toBeNull();
    expect(snap!.summary).toBe('unverified-open');
    expect(replayVerificationFlag(snap)).toBe('unverified-open');
  }, 60_000);
});
