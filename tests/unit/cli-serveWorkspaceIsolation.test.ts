/**
 * cli-serveWorkspaceIsolation.test.ts — cross-conversation contamination
 * tripwire for the long-lived `--serve-harness` sidecar.
 *
 * Reported symptom: two Desktop conversations opened on DIFFERENT folders
 * wrote their spines into ONE `.zelari/sessions` dir and both recorded
 * `session.started.workspace` = the sidecar's process.cwd() (the app install
 * dir), i.e. the session workspaceRoot never reached the turn. ADR-0016: the
 * session spine is PER WORKSPACE; the sidecar cannot `chdir` (N parallel
 * sessions share one process), so every path must be derived from the session
 * root, never from process.cwd().
 *
 * This drives the REAL NDJSON transport + the REAL `bindHarnessTurnOptions`
 * glue (no provider, no LSP, no child process) and asserts, per session:
 *   - `deps.session.workspaceRoot` is THIS session's workspace;
 *   - the bound `opts.cwd` handed to runOneTurn is THIS session's workspace;
 *   - `resolveSessionsDir({ workspaceRoot })` lands under THIS workspace;
 *   - one services instance per resolved root (never one shared set);
 *   - a real spine opened at that resolved location records `workspace` = it,
 *     and the OTHER workspace stays untouched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { startHarnessServer, bindHarnessTurnOptions } from '../../src/cli/serve/harnessServer.js';
import { openHeadlessSpine } from '../../src/cli/headlessSpine.js';
import { readSessionLog, resolveSessionsDir } from '@zelari/core/session';
import type { RunTurnFn } from '@zelari/core/harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Envelope = Record<string, any>;

const ENV_KEYS = ['ZELARI_SESSIONS_DIR', 'ZELARI_SESSION_SPINE'] as const;

const roots: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

async function workspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = {};
  // Windows: a recursive rmdir can race with the writer's append chain —
  // retry instead of failing the suite with ENOTEMPTY.
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/** In-memory duplex `--serve-harness` host (same bytes as the stdio deployment). */
function startFakeServer(runTurn: RunTurnFn, serviceRoots: string[]) {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const lines: Envelope[] = [];
  const waiters: Array<{ pred: (e: Envelope) => boolean; resolve: (e: Envelope) => void }> = [];
  const rl = createInterface({ input: serverToClient });
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    const envelope = JSON.parse(line) as Envelope;
    lines.push(envelope);
    const idx = waiters.findIndex((w) => w.pred(envelope));
    if (idx >= 0) waiters.splice(idx, 1)[0].resolve(envelope);
  });
  const started = startHarnessServer({
    io: { input: clientToServer, output: serverToClient as unknown as typeof process.stdout },
    runTurn,
    createWorkspaceServices: (root) => {
      serviceRoots.push(root);
      return {
        policyCache: { workspaceRoot: root, loadedAt: 1 },
        completionProofWriter: async () => {},
      };
    },
  });
  const send = (obj: unknown) => clientToServer.write(JSON.stringify(obj) + '\n');
  const waitFor = (pred: (e: Envelope) => boolean): Promise<Envelope> => {
    const found = lines.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise<Envelope>((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for envelope')), 5000);
    });
  };
  return {
    send,
    waitFor,
    close: async () => {
      rl.close();
      await started.close();
    },
  };
}

interface ObservedTurn {
  sessionId: string;
  workspaceRoot: string;
  cwd: string;
  sessionsDir: string;
}

describe('--serve-harness: every session keeps its OWN workspace (ADR-0016)', () => {
  it('threads workspaceRoot A/B into deps, opts.cwd and the sessions dir — no cwd() fallback', async () => {
    const a = await workspace('zelari-serve-ws-a-');
    const b = await workspace('zelari-serve-ws-b-');
    const observed: ObservedTurn[] = [];
    // The REAL serve glue: session workspaceRoot → HeadlessOptions.cwd, which
    // runOneTurn then uses for tools, memory, spine and the work-dir prompt.
    const runTurn: RunTurnFn = async (input, deps) => {
      const opts = bindHarnessTurnOptions(input, deps.session.workspaceRoot);
      observed.push({
        sessionId: deps.session.id,
        workspaceRoot: deps.session.workspaceRoot,
        cwd: opts.cwd ?? '',
        sessionsDir: resolveSessionsDir({ workspaceRoot: opts.cwd ?? '' }),
      });
      return { exitCode: 0 };
    };
    const serviceRoots: string[] = [];
    const h = startFakeServer(runTurn, serviceRoots);
    try {
      await h.waitFor((e) => e.type === 'protocol_info');
      h.send({ id: 1, method: 'session.create', params: { workspaceRoot: a } });
      h.send({ id: 2, method: 'session.create', params: { workspaceRoot: b } });
      const createdA = await h.waitFor((e) => e.id === 1);
      const createdB = await h.waitFor((e) => e.id === 2);
      const sessionA = createdA.result.sessionId as string;
      const sessionB = createdB.result.sessionId as string;
      expect(sessionA).not.toBe(sessionB);

      h.send({ id: 3, method: 'run.turn', params: { sessionId: sessionA, task: 'list A files' } });
      h.send({ id: 4, method: 'run.turn', params: { sessionId: sessionB, task: 'list B files' } });
      expect((await h.waitFor((e) => e.id === 3)).ok).toBe(true);
      expect((await h.waitFor((e) => e.id === 4)).ok).toBe(true);

      // 1. The session deps carry the session's own root — A stays A, B stays B.
      const turnA = observed.find((t) => t.sessionId === sessionA)!;
      const turnB = observed.find((t) => t.sessionId === sessionB)!;
      expect(turnA.workspaceRoot).toBe(a);
      expect(turnB.workspaceRoot).toBe(b);
      expect(turnA.workspaceRoot).not.toBe(turnB.workspaceRoot);

      // 2. …and that root IS the bound opts.cwd runOneTurn receives.
      expect(turnA.cwd).toBe(a);
      expect(turnB.cwd).toBe(b);
      expect(turnA.cwd).not.toBe(path.resolve(process.cwd()));
      expect(turnB.cwd).not.toBe(path.resolve(process.cwd()));

      // 3. The spine dir resolves under EACH workspace (never the sidecar cwd).
      expect(turnA.sessionsDir).toBe(path.join(a, '.zelari', 'sessions'));
      expect(turnB.sessionsDir).toBe(path.join(b, '.zelari', 'sessions'));
      expect(turnA.sessionsDir).not.toBe(turnB.sessionsDir);

      // 4. Per-workspace services: one factory call per distinct root.
      expect(serviceRoots).toEqual([path.resolve(a), path.resolve(b)]);
    } finally {
      await h.close();
    }
  });

  it('writes each spine under its own workspace root and records THAT workspace', async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    // The spine must resolve from the workspace root, not from an env redirect.
    delete process.env.ZELARI_SESSIONS_DIR;
    delete process.env.ZELARI_SESSION_SPINE;

    const a = await workspace('zelari-serve-spine-a-');
    const b = await workspace('zelari-serve-spine-b-');
    const observed: ObservedTurn[] = [];
    const runTurn: RunTurnFn = async (input, deps) => {
      const opts = bindHarnessTurnOptions(input, deps.session.workspaceRoot);
      observed.push({
        sessionId: deps.session.id,
        workspaceRoot: deps.session.workspaceRoot,
        cwd: opts.cwd ?? '',
        sessionsDir: resolveSessionsDir({ workspaceRoot: opts.cwd ?? '' }),
      });
      return { exitCode: 0 };
    };
    const h = startFakeServer(runTurn, []);
    try {
      await h.waitFor((e) => e.type === 'protocol_info');
      h.send({ id: 11, method: 'session.create', params: { workspaceRoot: a } });
      h.send({ id: 12, method: 'session.create', params: { workspaceRoot: b } });
      const sessionA = (await h.waitFor((e) => e.id === 11)).result.sessionId as string;
      const sessionB = (await h.waitFor((e) => e.id === 12)).result.sessionId as string;
      h.send({ id: 13, method: 'run.turn', params: { sessionId: sessionA, task: 'A' } });
      h.send({ id: 14, method: 'run.turn', params: { sessionId: sessionB, task: 'B' } });
      await h.waitFor((e) => e.id === 13);
      await h.waitFor((e) => e.id === 14);

      // Open the REAL spine exactly where the turn would (workspaceRoot, no
      // baseDir override) and close it, so the log is on disk.
      for (const turn of observed) {
        const spine = await openHeadlessSpine({
          sessionId: turn.sessionId,
          workspace: turn.cwd,
          quiet: true,
        });
        expect(spine.spine.status).toBe('active');
        await spine.close('workspace-isolation-test');
      }

      const logA = path.join(a, '.zelari', 'sessions', sessionA, 'events.jsonl');
      const logB = path.join(b, '.zelari', 'sessions', sessionB, 'events.jsonl');
      expect(await fs.readFile(logA, 'utf8').then(() => true, () => false)).toBe(true);
      expect(await fs.readFile(logB, 'utf8').then(() => true, () => false)).toBe(true);
      // No cross-write: A's session dir must not exist under B's workspace.
      expect(await fs.readFile(path.join(b, '.zelari', 'sessions', sessionA, 'events.jsonl'), 'utf8').then(() => true, () => false)).toBe(false);
      expect(await fs.readFile(path.join(a, '.zelari', 'sessions', sessionB, 'events.jsonl'), 'utf8').then(() => true, () => false)).toBe(false);

      // The exact production symptom: both logs recorded the sidecar's cwd.
      const startedA = (await readSessionLog(logA)).events.find((e) => e.kind === 'session.started');
      const startedB = (await readSessionLog(logB)).events.find((e) => e.kind === 'session.started');
      expect((startedA?.data as { workspace?: string } | undefined)?.workspace).toBe(a);
      expect((startedB?.data as { workspace?: string } | undefined)?.workspace).toBe(b);
      expect(logA).not.toBe(logB);
    } finally {
      await h.close();
    }
  });

  it('refuses a blank / relative workspaceRoot instead of adopting the sidecar cwd', async () => {
    const observed: ObservedTurn[] = [];
    const runTurn: RunTurnFn = async (input, deps) => {
      const opts = bindHarnessTurnOptions(input, deps.session.workspaceRoot);
      observed.push({
        sessionId: deps.session.id,
        workspaceRoot: deps.session.workspaceRoot,
        cwd: opts.cwd ?? '',
        sessionsDir: resolveSessionsDir({ workspaceRoot: opts.cwd ?? '' }),
      });
      return { exitCode: 0 };
    };
    const serviceRoots: string[] = [];
    const h = startFakeServer(runTurn, serviceRoots);
    try {
      await h.waitFor((e) => e.type === 'protocol_info');
      h.send({ id: 31, method: 'session.create', params: {} });
      h.send({ id: 32, method: 'session.create', params: { workspaceRoot: '   ' } });
      h.send({ id: 33, method: 'session.create', params: { workspaceRoot: '.' } });
      h.send({ id: 34, method: 'session.create', params: { workspaceRoot: 'relative/project' } });
      for (const id of [31, 32, 33, 34]) {
        const refused = await h.waitFor((e) => e.id === id);
        expect(refused.ok).toBe(false);
        expect(refused.error.code).toBe('bad_request');
      }
      // No session, no workspace services, no cwd-derived workspace: the
      // server never traded an explicit root for the app install dir.
      expect(observed).toEqual([]);
      expect(serviceRoots).toEqual([]);

      // The very next VALID create still works (no poisoned state).
      const a = await workspace('zelari-serve-refuse-a-');
      h.send({ id: 35, method: 'session.create', params: { workspaceRoot: a } });
      const created = await h.waitFor((e) => e.id === 35);
      expect(created.ok).toBe(true);
      h.send({ id: 36, method: 'run.turn', params: { sessionId: created.result.sessionId, task: 'x' } });
      await h.waitFor((e) => e.id === 36);
      expect(observed[0]?.cwd).toBe(a);
      expect(observed[0]?.sessionsDir).toBe(path.join(a, '.zelari', 'sessions'));
    } finally {
      await h.close();
    }
  });
});
