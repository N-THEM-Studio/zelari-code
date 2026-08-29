/**
 * HarnessAppServer (t29, Pilastro B) — a long-lived, transport-free kernel
 * that owns harness sessions and their per-workspace services.
 *
 * Why: today every headless turn is a fresh process (policy load, LSP
 * spawn, provider handshake from zero each time), and killing the client
 * kills the run. This kernel inverts the ownership:
 *   - the SERVER owns per-workspace services: one LspManager / policy
 *     cache per RESOLVED workspace root, reused by later sessions on the
 *     same workspace (no respawn from zero);
 *   - the SERVER owns completion-proof persistence: a client disconnect
 *     never cancels an in-flight/queued proof write; dispose() awaits the
 *     pending writes before tearing services down;
 *   - the transport (stdio NDJSON in the CLI, HTTP later, in-memory
 *     PassThrough in tests) is a replaceable client. No React, no CLI
 *     imports — dependency injection only (see appServerTypes.ts).
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  CompletionProofWriteRequest,
  CompletionProofWriter,
  HarnessTurnDeps,
  HarnessTurnResult,
  RunTurnFn,
  WorkspaceServices,
  WorkspaceServicesFactory,
} from './appServerTypes.js';

export type {
  CompletionProofWriteRequest,
  CompletionProofWriter,
  HarnessTurnDeps,
  HarnessTurnResult,
  LspManagerLike,
  PolicyCacheLike,
  RunTurnFn,
  WorkspaceServices,
  WorkspaceServicesFactory,
} from './appServerTypes.js';

export interface HarnessSession {
  readonly id: string;
  readonly workspaceRoot: string;
  /** Shared per-workspace services (same instance across sessions). */
  readonly services: WorkspaceServices;
  runTurn(input: Record<string, unknown>): Promise<HarnessTurnResult>;
  /** Ends this session; shared services survive while other sessions use them. */
  dispose(): Promise<void>;
}

export interface CreateSessionOptions {
  workspaceRoot: string;
  runTurn: RunTurnFn;
  /** Overrides the server-level factory for this session's workspace. */
  createWorkspaceServices?: WorkspaceServicesFactory | undefined;
  sessionId?: string | undefined;
}

export class HarnessAppServer {
  private readonly sessions = new Map<string, HarnessSession>();
  private readonly workspaceServices = new Map<string, WorkspaceServices>();
  private readonly sessionCounts = new Map<string, number>();
  private readonly defaultServicesFactory: WorkspaceServicesFactory | undefined;
  /**
   * Server-owned proof-write tracking: every completionProofWriter call is
   * recorded here as a SETTLED shadow promise, so dispose() can await
   * durability without ever throwing, and a disconnecting client (which
   * only awaits the turn result) cannot cancel the write.
   */
  private readonly pendingProofWrites = new Set<Promise<void>>();

  constructor(options: { createWorkspaceServices?: WorkspaceServicesFactory } = {}) {
    this.defaultServicesFactory = options.createWorkspaceServices;
  }

  createSession(options: CreateSessionOptions): HarnessSession {
    const root = resolve(options.workspaceRoot);
    const factory = options.createWorkspaceServices ?? this.defaultServicesFactory;
    if (!factory) {
      throw new Error('HarnessAppServer: createWorkspaceServices factory is required');
    }
    const id = options.sessionId ?? randomUUID();
    if (this.sessions.has(id)) {
      throw new Error(`HarnessAppServer: session '${id}' already exists`);
    }

    let services = this.workspaceServices.get(root);
    if (!services) {
      services = factory(root);
      this.workspaceServices.set(root, services);
    }
    const shared: WorkspaceServices = services;

    const server = this;
    const count = this.sessionCounts.get(root) ?? 0;
    this.sessionCounts.set(root, count + 1);

    const runTurn = options.runTurn;
    const session: HarnessSession = {
      id,
      workspaceRoot: root,
      services: shared,
      runTurn(input: Record<string, unknown>): Promise<HarnessTurnResult> {
        // Track proof writes server-side so they outlive the transport.
        const deps: HarnessTurnDeps = {
          session: { id, workspaceRoot: root },
          services: {
            ...shared,
            completionProofWriter: server.trackProofWriter(shared.completionProofWriter),
          },
        };
        return runTurn(input, deps);
      },
      dispose(): Promise<void> {
        server.sessions.delete(id);
        const remaining = (server.sessionCounts.get(root) ?? 1) - 1;
        server.sessionCounts.set(root, remaining);
        if (remaining <= 0) {
          server.sessionCounts.delete(root);
          const shared = server.workspaceServices.get(root);
          server.workspaceServices.delete(root);
          try {
            shared?.lspManager?.dispose();
          } catch {
            /* host disposal issues must not break teardown */
          }
        }
        return Promise.resolve();
      },
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): HarnessSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): string[] {
    return [...this.sessions.keys()];
  }

  /** How many proof writes are in flight (diagnostics + tests). */
  pendingProofCount(): number {
    return this.pendingProofWrites.size;
  }

  /**
   * Wrap a host writer so every call is tracked server-side. The caller
   * (turn) still sees the real result/rejection; the tracked shadow only
   * observes settlement so dispose() can await it.
   */
  private trackProofWriter(raw: CompletionProofWriter): CompletionProofWriter {
    const server = this;
    return (request: CompletionProofWriteRequest) => {
      const result = raw(request);
      const shadow = result.then(
        () => undefined,
        () => undefined,
      );
      server.pendingProofWrites.add(shadow);
      void shadow.then(() => server.pendingProofWrites.delete(shadow));
      return result;
    };
  }

  /**
   * Full teardown: awaits ALL pending proof writes (never cancels them),
   * disposes every remaining session, then the orphaned workspace services.
   */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.pendingProofWrites]);
    this.pendingProofWrites.clear();
    for (const id of [...this.sessions.keys()]) {
      await this.sessions.get(id)?.dispose();
    }
  }
}
