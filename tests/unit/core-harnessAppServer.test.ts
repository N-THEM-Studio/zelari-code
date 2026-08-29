/**
 * core-harnessAppServer.test.ts - t29 (Pilastro B) unit coverage for the
 * long-lived harness kernel (packages/core/src/harness/appServer.ts):
 *   (a) completion-proof writes survive a client disconnect — dispose()
 *       awaits them, never cancels;
 *   (b) two sessions on the SAME workspace reuse ONE services instance
 *       (spy factory called once — no respawn from zero), even when the
 *       root is spelled differently (resolve-keying);
 *   (c) sessions on DIFFERENT workspaces get different instances.
 * All factories are injected fakes — no LSP, no policy engine, no I/O.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { HarnessAppServer } from '@zelari/core/harness';
import type {
  RunTurnFn,
  WorkspaceServices,
} from '@zelari/core/harness';

const noopRunTurn: RunTurnFn = async () => ({ exitCode: 0 });

function makeServices(root: string, disposedFlag?: { flag: boolean }): WorkspaceServices {
  return {
    lspManager: {
      dispose: () => {
        if (disposedFlag) disposedFlag.flag = true;
      },
    },
    policyCache: { workspaceRoot: root, loadedAt: 1 },
    completionProofWriter: async () => {},
  };
}

describe('HarnessAppServer — proof durability (DoD: killing the client does not kill the proof)', () => {
  it('(a) an in-flight proof write completes even after the client stops listening; dispose awaits it', async () => {
    let writes = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new HarnessAppServer({
      createWorkspaceServices: (root) => ({
        policyCache: { workspaceRoot: root, loadedAt: 1 },
        completionProofWriter: async () => {
          await blocked; // simulate a slow atomic tmp→fsync→rename write
          writes++;
        },
      }),
    });
    const runTurn: RunTurnFn = async (_input, deps) => {
      // Turn fires the durable write and finishes WITHOUT awaiting it
      // (client disconnect = nobody is listening for the write).
      void deps.services.completionProofWriter({
        surface: 'kraken',
        baseDir: deps.session.workspaceRoot,
        payload: { ok: true },
      });
      return { exitCode: 0 };
    };
    const session = server.createSession({ workspaceRoot: os.tmpdir(), runTurn });
    await session.runTurn({});
    expect(server.pendingProofCount()).toBe(1);

    // "Disconnect": the transport is gone, nobody awaits the write. The
    // server must still complete it on teardown — never cancel it.
    release();
    await server.dispose();
    expect(writes).toBe(1);
    expect(server.pendingProofCount()).toBe(0);
  });

  it('(a2) a queued proof write is drained by dispose, and a failing write does not crash teardown', async () => {
    let writes = 0;
    const server = new HarnessAppServer({
      createWorkspaceServices: (root) => ({
        policyCache: { workspaceRoot: root, loadedAt: 1 },
        completionProofWriter: async () => {
          await new Promise((r) => setTimeout(r, 5));
          writes++;
          throw new Error('disk on fire'); // callers see the error; teardown must not
        },
      }),
    });
    const root0 = path.join(os.tmpdir(), 'zelari-t29-proof-fail');
    const runTurn: RunTurnFn = async (_input, deps) => {
      void deps.services
        .completionProofWriter({ surface: 'kraken', baseDir: root0, payload: {} })
        .catch(() => undefined); // turn-level containment
      return { exitCode: 4 };
    };
    const session = server.createSession({ workspaceRoot: root0, runTurn });
    const result = await session.runTurn({});
    expect(result.exitCode).toBe(4);
    await server.dispose(); // must not throw despite the writer rejection
    expect(writes).toBe(1);
  });
});

describe('HarnessAppServer — per-workspace service reuse (DoD: second run reuses managers, no respawn)', () => {
  it('(b) two sessions on the same workspace share ONE services instance (factory called once)', () => {
    const calls: string[] = [];
    const disposed = { flag: false };
    const server = new HarnessAppServer({
      createWorkspaceServices: (root) => {
        calls.push(root);
        return makeServices(root, disposed);
      },
    });
    const ws = path.join(os.tmpdir(), 'zelari-t29-wsA');
    const s1 = server.createSession({ workspaceRoot: ws, runTurn: noopRunTurn });
    // Same root, spelled with a trailing separator — still ONE cache entry.
    const s2 = server.createSession({ workspaceRoot: ws + path.sep, runTurn: noopRunTurn });
    expect(calls).toHaveLength(1);
    expect(s1.services).toBe(s2.services);
    expect(s1.id).not.toBe(s2.id);

    // Session teardown is refcounted: disposing s1 keeps shared services.
    void s1.dispose();
    expect(disposed.flag).toBe(false);
    expect(s2.services.lspManager).toBeDefined();
  });

  it('(c) sessions on different workspaces get different instances (factory called per root)', () => {
    const calls: string[] = [];
    const server = new HarnessAppServer({
      createWorkspaceServices: (root) => {
        calls.push(root);
        return makeServices(root);
      },
    });
    const a = server.createSession({ workspaceRoot: path.join(os.tmpdir(), 'zelari-t29-wsB'), runTurn: noopRunTurn });
    const b = server.createSession({ workspaceRoot: path.join(os.tmpdir(), 'zelari-t29-wsC'), runTurn: noopRunTurn });
    expect(calls).toHaveLength(2);
    expect(a.services).not.toBe(b.services);
    expect(a.services.policyCache.workspaceRoot).not.toBe(b.services.policyCache.workspaceRoot);
  });
});
