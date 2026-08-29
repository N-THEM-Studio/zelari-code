/**
 * HarnessAppServer types (t29, Pilastro B) — the long-lived kernel contract.
 *
 * Dependency direction: this module (and appServer.ts) live in @zelari/core
 * and MUST NOT import CLI or React code. The host (zelari-code CLI) injects
 * the real implementations — runOneTurn, LspManager, the completion-proof
 * writer — the same DI pattern used by createBashTool(spawnSeam).
 */

/** Minimal structural shape the kernel needs from a per-workspace LSP manager. */
export interface LspManagerLike {
  dispose(): void;
}

/**
 * Per-workspace policy cache, opaque to the kernel beyond its identity.
 * The host decides what "policy loaded" means; the kernel only guarantees
 * ONE instance per resolved workspace root is created and reused across
 * sessions (no respawn from zero on the second run).
 */
export interface PolicyCacheLike {
  readonly workspaceRoot: string;
  readonly loadedAt: number;
}

/** Request for a durable completion-proof write (gate payload stays opaque). */
export interface CompletionProofWriteRequest {
  surface: string;
  sessionId?: string | undefined;
  baseDir: string;
  payload: Record<string, unknown>;
}

export type CompletionProofWriter = (
  request: CompletionProofWriteRequest,
) => Promise<void>;

/** Services shared by every session on the same resolved workspace root. */
export interface WorkspaceServices {
  lspManager?: LspManagerLike | undefined;
  policyCache: PolicyCacheLike;
  completionProofWriter: CompletionProofWriter;
}

/**
 * Host factory for per-workspace services. Called AT MOST ONCE per resolved
 * workspace root for the lifetime of the server (cache keyed by
 * `path.resolve(workspaceRoot)`). Synchronous by design: construction is
 * cheap and lazy (e.g. LspManager spawns servers on first use, not here).
 */
export type WorkspaceServicesFactory = (
  workspaceRoot: string,
) => WorkspaceServices;

/** What an injected turn implementation receives from the kernel. */
export interface HarnessTurnDeps {
  readonly session: { readonly id: string; readonly workspaceRoot: string };
  readonly services: WorkspaceServices;
}

export interface HarnessTurnResult {
  exitCode: number;
  [key: string]: unknown;
}

/**
 * The turn implementation, injected by the host. `input` stays opaque on
 * purpose: the CLI passes its HeadlessOptions-shaped single-turn request.
 */
export type RunTurnFn = (
  input: Record<string, unknown>,
  deps: HarnessTurnDeps,
) => Promise<HarnessTurnResult>;
