/**
 * H10-fix1 — strict-done knobs per RUN via an env OVERLAY (sidecar level).
 *
 * The `--serve-harness` sidecar dispatches turns CONCURRENTLY inside one
 * process, so a per-turn process.env write is a race. The knobs must ride
 * HeadlessOptions (bound from the wire by bindHarnessTurnOptions) into a
 * fresh per-invocation overlay (strictEnvOverlay) that the strict gate
 * consults INSTEAD of process.env.
 *
 * These tests drive the REAL production pieces end-to-end minus the provider
 * (a full turn would need live key material): the NDJSON `run.turn` input is
 * bound by the real bindHarnessTurnOptions, the overlay is the real
 * strictEnvOverlay, the verdict is a real evaluateStrictBuildGate, and the
 * assertion lands INSIDE the `{ok:true}` result envelope — never on process
 * exit codes. Source-level guards pin the dispatch wiring (same pattern as
 * legacyContextIsolation.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindHarnessTurnOptions, startHarnessServer } from '../serve/harnessServer.js';
import type { RunTurnFn } from '@zelari/core/harness';
import {
  evaluateStrictBuildGate,
  strictEnvOverlay,
  strictGateExitCode,
} from './verificationBridge.js';
import { resetKrakenCandidates, setKrakenSelection } from './candidateRegistry.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Envelope = Record<string, any>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readCli(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli', rel), 'utf8');
}

const CHECKS = ['overlay turn keeps the spine replayable'];

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

/** NDJSON harness cribbed from tests/unit/cli-harnessServer.test.ts. */
function startFakeServer(runTurn: RunTurnFn) {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const waiters: Array<{ pred: (e: Envelope) => boolean; resolve: (e: Envelope) => void }> = [];
  serverToClient.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      let envelope: Envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        continue;
      }
      const idx = waiters.findIndex((w) => w.pred(envelope));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(envelope);
    }
  });
  const started = startHarnessServer({
    io: { input: clientToServer, output: serverToClient as unknown as typeof process.stdout },
    runTurn,
    createWorkspaceServices: (root) => ({
      policyCache: { workspaceRoot: root, loadedAt: 1 },
      completionProofWriter: async () => {},
    }),
  });
  const send = (obj: Envelope) => clientToServer.write(JSON.stringify(obj) + '\n');
  const waitFor = (pred: (e: Envelope) => boolean) =>
    new Promise<Envelope>((resolve) => waiters.push({ pred, resolve }));
  const close = async () => {
    clientToServer.end();
    await started.close();
  };
  return { send, waitFor, close };
}

/**
 * The REAL sidecar turn composition minus the provider stream: wire input →
 * bindHarnessTurnOptions → strictEnvOverlay → evaluateStrictBuildGate →
 * strictGateExitCode → `{exitCode}` envelope result.
 */
function gateTurnRunTurn(): RunTurnFn {
  return async (input, deps) => {
    const opts = bindHarnessTurnOptions(input, deps.session.workspaceRoot);
    const gate = await evaluateStrictBuildGate('build', {
      env: strictEnvOverlay(opts),
      emit: async () => ({ seq: 1 }),
    });
    return { exitCode: strictGateExitCode(gate) };
  };
}

let tmpRoot: string;
let prevPack: string | undefined;
let prevKraken: string | undefined;
let prevMission: string | undefined;

beforeEach(() => {
  prevKraken = process.env.ZELARI_STRICT_DONE;
  prevMission = process.env.ZELARI_MISSION_STRICT;
  prevPack = process.env.ZELARI_VERIFY_PACK;
  // Hermetic: strict defaults ON (selection below is unresolved ⇒ BLOCK),
  // native pack OFF so the strictDone knob is the only gate switch.
  delete process.env.ZELARI_STRICT_DONE;
  delete process.env.ZELARI_MISSION_STRICT;
  process.env.ZELARI_VERIFY_PACK = '0';
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-strict-overlay-'));
  selectWithChecks(CHECKS);
});

afterEach(() => {
  if (prevKraken === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = prevKraken;
  if (prevMission === undefined) delete process.env.ZELARI_MISSION_STRICT;
  else process.env.ZELARI_MISSION_STRICT = prevMission;
  if (prevPack === undefined) delete process.env.ZELARI_VERIFY_PACK;
  else process.env.ZELARI_VERIFY_PACK = prevPack;
  resetKrakenCandidates();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function runOneTurnOverWire(params: Record<string, unknown>): Promise<Envelope> {
  const h = startFakeServer(gateTurnRunTurn());
  try {
    h.send({ id: 1, method: 'session.create', params: { workspaceRoot: tmpRoot } });
    const created = await h.waitFor((e) => e.id === 1 && e.ok === true);
    const sessionId = (created.result as { sessionId: string }).sessionId;
    h.send({ id: 2, method: 'run.turn', params: { sessionId, task: 'x', mode: 'kraken', ...params } });
    return await h.waitFor((e) => e.id === 2);
  } finally {
    await h.close();
  }
}

describe('H10-fix1: the strict verdict rides the {ok:true} run.turn envelope', () => {
  it('strictDone:false on the wire opts THIS turn out — result.exitCode !== 4 inside {ok:true}', async () => {
    const envelope = await runOneTurnOverWire({ strictDone: false });
    expect(envelope.ok).toBe(true);
    const exitCode = (envelope.result as { exitCode: number }).exitCode;
    expect(exitCode).not.toBe(4); // the strict gate never closed the run…
    expect(exitCode).toBe(0); // …and strict-off enforcement is a no-op (ADR-0025)
  }, 15000);

  it('control: the same turn WITHOUT the knob stays strict-BLOCKED — exitCode 4 inside {ok:true}', async () => {
    const envelope = await runOneTurnOverWire({});
    expect(envelope.ok).toBe(true);
    // Proves the envelope CAN carry 4 (unresolved required checks, strict ON
    // by default) — so the !== 4 above is the overlay's doing, not a vacuous pass.
    expect((envelope.result as { exitCode: number }).exitCode).toBe(4);
  }, 15000);
});

describe('H10-fix1: dispatch wiring (source-level, legacyContextIsolation pattern)', () => {
  it('runOneTurn builds the overlay once and feeds BOTH strict gate evaluations', () => {
    const src = readCli(path.join('headless', 'runOneTurn.ts'));
    expect(src).toContain('const strictEnv = strictEnvOverlay(opts);');
    expect(src.match(/env: strictEnv/g)?.length).toBe(2);
  });

  it('runHeadless no longer mutates ZELARI_STRICT_DONE; the mission gate consumes the overlay', () => {
    const src = readCli('runHeadless.ts');
    expect(src).not.toContain('process.env.ZELARI_STRICT_DONE');
    expect(src).toContain('env: strictEnvOverlay(opts),');
  });

  it('the CLI parser maps --no-strict-done to the option, never to process.env', () => {
    const src = readCli('headless.ts');
    expect(src).not.toContain('process.env.ZELARI_MISSION_STRICT');
    expect(src).toContain("arg === '--no-strict-done'");
  });
});
