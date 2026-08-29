/**
 * cli-harnessServer.test.ts - t29 (Pilastro B) NDJSON protocol coverage for
 * `--serve-harness` (src/cli/serve/harnessServer.ts), driven over an
 * in-memory duplex stream (node:stream PassThrough — no process spawn):
 *   (d) session.create → run.turn → session.dispose roundtrip on the
 *       EXISTING headless protocol v2 (boot protocol_info.version === 2),
 *       plus typed error envelopes for unknown method / unknown session;
 *   (e) a malformed JSON line is answered with a bad_json envelope and the
 *       server keeps serving (the process never dies on bad input).
 * runTurn + workspace services are injected fakes — no provider, no LSP.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { startHarnessServer } from '../../src/cli/serve/harnessServer.js';
import {
  getLiveTurnControl,
  registerLiveTurnControl,
  runWithSession,
} from '../../src/cli/serve/sessionControl.js';
import { RuntimeControlQueue } from '@zelari/core/runtime';
import { HEADLESS_PROTOCOL_VERSION } from '../../src/cli/headless/protocol.js';
import type { RunTurnFn } from '@zelari/core/harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Envelope = Record<string, any>;

function startFakeServer(runTurn: RunTurnFn) {
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
    createWorkspaceServices: (root) => ({
      policyCache: { workspaceRoot: root, loadedAt: 1 },
      completionProofWriter: async () => {},
    }),
  });
  const send = (obj: unknown) => clientToServer.write(JSON.stringify(obj) + '\n');
  const sendRaw = (raw: string) => clientToServer.write(raw + '\n');
  const waitFor = (pred: (e: Envelope) => boolean): Promise<Envelope> => {
    const found = lines.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise<Envelope>((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for envelope')), 3000);
    });
  };
  return {
    started,
    send,
    sendRaw,
    waitFor,
    close: async () => {
      rl.close();
      await started.close();
    },
  };
}

describe('harnessServer NDJSON protocol (protocol v2 unchanged)', () => {
  it('(d) create → turn → dispose roundtrip + protocol_info version 2 + typed errors', async () => {
    const runTurn: RunTurnFn = async (input) => ({ exitCode: 7, echo: input.task });
    const h = startFakeServer(runTurn);
    try {
      // Boot handshake: same protocol_info envelope `--headless` emits.
      const boot = await h.waitFor((e) => e.type === 'protocol_info');
      expect(boot.version).toBe(HEADLESS_PROTOCOL_VERSION);
      expect(boot.version).toBe(2);

      h.send({ id: 1, method: 'session.create', params: { workspaceRoot: path.join(os.tmpdir(), 'zelari-t29-proto') } });
      const created = await h.waitFor((e) => e.id === 1);
      expect(created.ok).toBe(true);
      const sessionId = created.result.sessionId as string;
      expect(typeof sessionId).toBe('string');

      h.send({ id: 2, method: 'run.turn', params: { sessionId, task: 'echo-me' } });
      const turned = await h.waitFor((e) => e.id === 2);
      expect(turned.ok).toBe(true);
      expect(turned.result.exitCode).toBe(7);
      expect(turned.result.echo).toBe('echo-me');

      h.send({ id: 3, method: 'definitely.not_a_method' });
      const unknown = await h.waitFor((e) => e.id === 3);
      expect(unknown.ok).toBe(false);
      expect(unknown.error.code).toBe('unknown_method');

      h.send({ id: 4, method: 'run.turn', params: { sessionId: 'nope', task: 'x' } });
      const noSession = await h.waitFor((e) => e.id === 4);
      expect(noSession.ok).toBe(false);
      expect(noSession.error.code).toBe('unknown_session');

      h.send({ id: 5, method: 'session.dispose', params: { sessionId } });
      const disposed = await h.waitFor((e) => e.id === 5);
      expect(disposed.ok).toBe(true);
      expect(disposed.result.disposed).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('(e) a malformed JSON line gets a bad_json envelope and the server keeps serving', async () => {
    const h = startFakeServer(async () => ({ exitCode: 0 }));
    try {
      await h.waitFor((e) => e.type === 'protocol_info');
      h.sendRaw('this is { not json');
      const bad = await h.waitFor((e) => e.error?.code === 'bad_json');
      expect(bad.id).toBeNull();
      // The very next valid request still works — no crash, no deadlock.
      h.send({ id: 11, method: 'session.create', params: { workspaceRoot: os.tmpdir() } });
      const created = await h.waitFor((e) => e.id === 11);
      expect(created.ok).toBe(true);
      expect(typeof created.result.sessionId).toBe('string');
    } finally {
      await h.close();
    }
  });
});

describe('harnessServer session.steer / session.cancel (t32, session-scoped control plane)', () => {
  it('steer reaches the live turn queue; cancel applies; terminated/unknown sessions get explicit outcomes (protocol v2 unchanged)', async () => {
    const queue = new RuntimeControlQueue();
    let registered = false;
    let drainedSteerIds: string[] = [];
    let cancelCalls = 0;
    let releaseTurn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    // The fake turn registers EXACTLY like runOneTurn does in serve mode —
    // via AsyncLocalStorage only. If the server did not wrap session.runTurn
    // in the session dispatch context, `registered` stays false and the test
    // fails on the §24 flow below.
    const runTurn: RunTurnFn = async () => {
      const unregister = registerLiveTurnControl({
        queue,
        cancel: () => {
          cancelCalls++;
          return true;
        },
      });
      registered = unregister !== undefined;
      try {
        await gate;
        drainedSteerIds = queue.drainSteers().map((s) => s.id);
        return { exitCode: 0 };
      } finally {
        unregister?.();
      }
    };
    const h = startFakeServer(runTurn);
    try {
      await h.waitFor((e) => e.type === 'protocol_info');
      h.send({ id: 20, method: 'session.create', params: { workspaceRoot: path.join(os.tmpdir(), 'zelari-t32-ctrl') } });
      const created = await h.waitFor((e) => e.id === 20);
      const sessionId = created.result.sessionId as string;

      h.send({ id: 21, method: 'run.turn', params: { sessionId, task: 'long turn' } });
      await vi.waitFor(() => expect(registered).toBe(true));

      // §24 steer: accepted in the response + control_accepted event on the
      // wire (controlType/cID mirroring the stdin bridge acks).
      h.send({ id: 22, method: 'session.steer', params: { sessionId, text: 'keep the schema', controlId: 's1' } });
      const steered = await h.waitFor((e) => e.id === 22);
      expect(steered.ok).toBe(true);
      expect(steered.result).toMatchObject({ accepted: true, controlType: 'steer', controlId: 's1' });
      const acceptedEv = await h.waitFor((e) => e.type === 'control_accepted' && e.controlId === 's1');
      expect(acceptedEv.controlType).toBe('steer');
      // The control event really landed in the turn's RuntimeControlQueue
      // (server → turn bridge), where SteeringObserver will drain it.
      expect(queue.size).toBe(1);

      // Cancel: cooperative hook applied + control_applied ack (boundary cancel).
      h.send({ id: 23, method: 'session.cancel', params: { sessionId, reason: 'user stop', controlId: 'c1' } });
      const cancelled = await h.waitFor((e) => e.id === 23);
      expect(cancelled.ok).toBe(true);
      expect(cancelled.result).toMatchObject({ accepted: true, delivered: true, controlType: 'cancel' });
      expect(cancelCalls).toBe(1);
      const appliedEv = await h.waitFor((e) => e.type === 'control_applied' && e.controlId === 'c1');
      expect(appliedEv.boundary).toBe('cancel');

      releaseTurn();
      const turned = await h.waitFor((e) => e.id === 21);
      expect(turned.ok).toBe(true);
      expect(drainedSteerIds).toEqual(['s1']);

      // Known session, turn over → EXPLICIT already_finished noop (no crash,
      // no fake acceptance).
      h.send({ id: 24, method: 'session.steer', params: { sessionId, text: 'late steer', controlId: 's2' } });
      const late = await h.waitFor((e) => e.id === 24);
      expect(late.ok).toBe(true);
      expect(late.result).toMatchObject({ accepted: false, outcome: 'already_finished' });
      h.send({ id: 25, method: 'session.cancel', params: { sessionId } });
      const lateCancel = await h.waitFor((e) => e.id === 25);
      expect(lateCancel.ok).toBe(true);
      expect(lateCancel.result.outcome).toBe('already_finished');

      // steer without text → bad_request (same shape rule as controlReader).
      h.send({ id: 26, method: 'session.steer', params: { sessionId } });
      const missingText = await h.waitFor((e) => e.id === 26);
      expect(missingText.ok).toBe(false);
      expect(missingText.error.code).toBe('bad_request');

      // Disposed session → unknown_session (existing typed convention).
      h.send({ id: 27, method: 'session.dispose', params: { sessionId } });
      await h.waitFor((e) => e.id === 27);
      h.send({ id: 28, method: 'session.cancel', params: { sessionId } });
      const gone = await h.waitFor((e) => e.id === 28);
      expect(gone.ok).toBe(false);
      expect(gone.error.code).toBe('unknown_session');

      // Never-known session → unknown_session.
      h.send({ id: 29, method: 'session.steer', params: { sessionId: 'nope', text: 'x' } });
      const unknown = await h.waitFor((e) => e.id === 29);
      expect(unknown.ok).toBe(false);
      expect(unknown.error.code).toBe('unknown_session');
    } finally {
      await h.close();
    }
  });

  it('registerLiveTurnControl returns undefined outside a session dispatch (plain --headless keeps the stdin control plane)', () => {
    expect(
      registerLiveTurnControl({ queue: new RuntimeControlQueue(), cancel: () => false }),
    ).toBeUndefined();
    expect(getLiveTurnControl('whatever')).toBeUndefined();
  });

  it('runWithSession scopes registrations to the dispatch context; unregister is identity-guarded', () => {
    const queue = new RuntimeControlQueue();
    let unregister: (() => void) | undefined;
    const seen = runWithSession('sess-1', () => {
      unregister = registerLiveTurnControl({ queue, cancel: () => false });
      return getLiveTurnControl('sess-1');
    });
    expect(seen).toBeDefined();
    expect(getLiveTurnControl('sess-1')).toBeDefined();
    unregister?.();
    expect(getLiveTurnControl('sess-1')).toBeUndefined();
    // Double-unregister (identity guard) is a no-op, never a wrong deletion.
    unregister?.();
    expect(getLiveTurnControl('sess-1')).toBeUndefined();
  });
});
