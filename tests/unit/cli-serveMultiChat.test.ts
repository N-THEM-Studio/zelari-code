/**
 * cli-serveMultiChat.test.ts — several chats on the SAME workspace inside one
 * `--serve-harness` process (2026-09-24 multi-chat support).
 *
 * Drives the REAL NDJSON transport with two sessions on one folder whose
 * turns overlap in time, and asserts per session:
 *   - the boot `protocol_info` advertises `session-routing`;
 *   - every line a turn emits carries ITS `harnessSessionId` (the Desktop
 *     routes by it — no spine-bind guess, no cross-chat attribution);
 *   - phase / todos / env overlay set by one turn are invisible to the other;
 *   - session.dispose releases the session's scoped state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import type { RunTurnFn } from '@zelari/core/harness';
import { startHarnessServer } from '../../src/cli/serve/harnessServer.js';
import { emitEvent } from '../../src/cli/headless.js';
import { getPhase, setPhase } from '../../src/cli/phaseState.js';
import { listSessionTodos, writeSessionTodos } from '../../src/cli/sessionTodos.js';
import { applyTurnPermissionPreset } from '../../src/cli/serve/permissionBridge.js';
import { activePermissionPreset } from '../../src/cli/safety/toolPermissions.js';
import { liveSessionScopeCount } from '../../src/cli/sessionScope.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Envelope = Record<string, any>;

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function startServer(runTurn: RunTurnFn) {
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
    if (idx >= 0) waiters.splice(idx, 1)[0]!.resolve(envelope);
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
  const waitFor = (pred: (e: Envelope) => boolean): Promise<Envelope> => {
    const found = lines.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise<Envelope>((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for envelope')), 5000);
    });
  };
  return { send, waitFor, close: async () => { rl.close(); await started.close(); } };
}

describe('--serve-harness: several chats on ONE workspace, concurrently', () => {
  it('routes, scopes and disposes per session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-multichat-'));
    roots.push(root);

    // Turn stdout (emitEvent) is the process stdout — the same stream the
    // Desktop sidecar reads. Capture it.
    const stdout: Envelope[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) stdout.push(JSON.parse(l));
      return true;
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = 0;
    const runTurn: RunTurnFn = async (input) => {
      const chat = String(input.task);
      setPhase(chat === 'A' ? 'plan' : 'build');
      writeSessionTodos([{ id: 't1', content: `todo of ${chat}` }]);
      applyTurnPermissionPreset({ permissionPreset: chat === 'A' ? 'strict' : 'yolo' });
      // Both turns are in flight before either reads its state back.
      entered += 1;
      if (entered === 2) release();
      await gate;
      emitEvent({
        type: 'probe',
        chat,
        phase: getPhase(),
        todos: listSessionTodos().map((t) => t.content),
        preset: activePermissionPreset(),
      });
      return { exitCode: 0 };
    };

    const h = startServer(runTurn);
    try {
      const boot = await h.waitFor((e) => e.type === 'protocol_info');
      expect(boot.capabilities).toContain('session-routing');

      h.send({ id: 1, method: 'session.create', params: { workspaceRoot: root } });
      h.send({ id: 2, method: 'session.create', params: { workspaceRoot: root } });
      const sa = (await h.waitFor((e) => e.id === 1)).result.sessionId as string;
      const sb = (await h.waitFor((e) => e.id === 2)).result.sessionId as string;
      const scopesBefore = liveSessionScopeCount();

      h.send({ id: 3, method: 'run.turn', params: { sessionId: sa, task: 'A' } });
      h.send({ id: 4, method: 'run.turn', params: { sessionId: sb, task: 'B' } });
      expect((await h.waitFor((e) => e.id === 3)).ok).toBe(true);
      expect((await h.waitFor((e) => e.id === 4)).ok).toBe(true);

      const probeA = stdout.find((e) => e.type === 'probe' && e.chat === 'A')!;
      const probeB = stdout.find((e) => e.type === 'probe' && e.chat === 'B')!;
      expect(probeA).toMatchObject({ harnessSessionId: sa, phase: 'plan', todos: ['todo of A'], preset: 'strict' });
      expect(probeB).toMatchObject({ harnessSessionId: sb, phase: 'build', todos: ['todo of B'], preset: 'yolo' });
      expect(process.env.ZELARI_PERMISSION_PRESET).toBeUndefined();

      h.send({ id: 5, method: 'session.dispose', params: { sessionId: sa } });
      h.send({ id: 6, method: 'session.dispose', params: { sessionId: sb } });
      await h.waitFor((e) => e.id === 5);
      await h.waitFor((e) => e.id === 6);
      expect(liveSessionScopeCount()).toBeLessThanOrEqual(scopesBefore);
    } finally {
      await h.close();
    }
  });
});
