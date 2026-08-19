/**
 * runtime/providers.ts — execution seam interfaces (ADR-0022).
 *
 * Minimal, injectable, workspace-jailed seams. Core ships node + in-memory
 * implementations; the CLI injects the real subagent provider. Providers are
 * reached ONLY via ToolRegistry.invoke or the internal verification services
 * — never as a side door around P2.
 */

import path from 'node:path';

/** Thrown when a relative path escapes the workspace root (path jail). */
export class WorkspacePathEscapeError extends Error {
  readonly code = 'WORKSPACE_PATH_ESCAPE';
  constructor(
    public readonly root: string,
    public readonly attempted: string,
  ) {
    super(`Path escapes workspace root: ${attempted} (root: ${root})`);
    this.name = 'WorkspacePathEscapeError';
  }
}

export interface WorkspaceProvider {
  readonly kind: 'local' | 'worktree' | 'memory' | 'remote';
  /** Absolute root every relative path is jailed to. */
  readonly root: string;
  /** Resolve a workspace-relative path; throws on escape. */
  resolve(rel: string): string;
  /** Optional teardown (worktree removal, remote disconnect). */
  dispose?(): Promise<void>;
}

/**
 * Treat backslash as a path separator on every OS before resolving, so a
 * relative path like `..\file` cannot smuggle out of the jail on POSIX
 * (where `\` is an ordinary filename character).
 */
export function resolveJailed(root: string, rel: string): string {
  const normalized = rel.split('\\').join('/');
  const absolute = path.resolve(root, normalized);
  const rootAbs = path.resolve(root);
  if (absolute !== rootAbs && !absolute.startsWith(rootAbs + path.sep)) {
    throw new WorkspacePathEscapeError(rootAbs, rel);
  }
  return absolute;
}

/** Path-jailed local workspace directory. */
export class LocalWorkspace implements WorkspaceProvider {
  readonly kind = 'local' as const;

  constructor(readonly root: string) {}

  resolve(rel: string): string {
    return resolveJailed(this.root, rel);
  }
}

export interface FsProvider {
  readFile(rel: string): Promise<string>;
  writeFile(rel: string, data: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  /** Recursive listing of files (relative paths), bounded. */
  list(rel?: string): Promise<string[]>;
}

export interface ShellResult {
  /** null when the process was killed by a signal/timeout. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ShellExecOptions {
  /** Workspace-relative cwd (default: workspace root). */
  cwd?: string;
  timeoutMs?: number;
  /** Output cap per stream (tail kept). Default 200k chars. */
  maxOutputChars?: number;
}

export interface ShellProvider {
  exec(command: string, options?: ShellExecOptions): Promise<ShellResult>;
}

export interface SubagentTask {
  goal: string;
  scope?: string[];
  acceptance?: string[];
  agent?: string;
}

export interface SubagentResult {
  ok: boolean;
  conclusion: string;
  artifacts?: string[];
}

export interface SubagentProvider {
  /** False when delegation is unavailable (core no-op default). */
  readonly available: boolean;
  runTask(task: SubagentTask): Promise<SubagentResult>;
}

/** Core default: delegation is a CLI-injected capability, never faked here. */
export class NoopSubagentProvider implements SubagentProvider {
  readonly available = false;

  async runTask(task: SubagentTask): Promise<SubagentResult> {
    return {
      ok: false,
      conclusion: `Subagent delegation is not available in this context (goal: ${task.goal}).`,
    };
  }
}

export const NOOP_SUBAGENT_PROVIDER: SubagentProvider = new NoopSubagentProvider();
