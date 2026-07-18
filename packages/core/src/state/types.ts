/**
 * Durable state contract — provider-neutral, zero-dependency types.
 *
 * Inspired by Palmer (2026) "State, Not Tokens": discoveries are durable
 * system objects (committed after verification), not prompt text.
 * The CLI ships a file-backed store under `.zelari/state/`; this interface
 * is the seam so callers (mission, council, slash commands) stay free of I/O.
 *
 * Only types live here so `@zelari/core` stays lean (same pattern as memory).
 */

/** Short id for a state commit (uuid or truncated hash). */
export type StateCommitId = string;

/** How the agent run that produced this commit was dispatched. */
export type StateCommitMode = 'agent' | 'council' | 'zelari';

/** Kind of materialised discovery (accumulation unit). */
export type DiscoveryKind =
  | 'file_change'
  | 'decision'
  | 'api_export'
  | 'test_result'
  | 'lesson'
  | 'note';

/**
 * A single verified discovery. Reusable discoveries are injected into the
 * *volatile* prompt section for successor workers (zero-LLM re-query path).
 */
export interface Discovery {
  id: string;
  kind: DiscoveryKind;
  summary: string;
  /** Relative project paths touched or referenced. */
  paths?: string[];
  /** Evidence string (command, exit code, cite path). */
  evidence?: string;
  /** When true, included by materializeContext(). */
  reusable: boolean;
}

export interface StateCommitVerification {
  ok: boolean;
  ran: boolean;
  /** Relative path under artifacts/ or absolute report path. */
  reportPath?: string;
}

/**
 * Immutable commit metadata (HEAD of the durable accumulation chain).
 * Artifacts (discoveries, summary) live beside this record on disk.
 */
export interface StateCommitMeta {
  id: StateCommitId;
  parentId: StateCommitId | null;
  createdAt: number;
  sessionId?: string;
  mode: StateCommitMode;
  /** Logical layer, e.g. mission:impl-2 or plan:task-3. */
  layer?: string;
  label: string;
  /** Linked git working-tree checkpoint id (refs/zelari/checkpoints/…). */
  workspaceCheckpointId?: string;
  verification: StateCommitVerification;
  /** Relative paths materialised by this commit. */
  changedPaths: string[];
  /** Hash of the stable prompt pack at commit time (cache coordination). */
  stablePromptHash?: string;
  discoveryCount: number;
}

/** Input for DurableStateStore.commit (id/parent/createdAt assigned by store). */
export interface StateCommitInput {
  mode: StateCommitMode;
  label: string;
  layer?: string;
  sessionId?: string;
  workspaceCheckpointId?: string;
  verification: StateCommitVerification;
  changedPaths?: string[];
  stablePromptHash?: string;
  discoveries?: Discovery[];
  /** Optional human summary (defaults to label + discovery bullets). */
  summary?: string;
  /**
   * Soft commit: allow even when verification.ok is false (manual /state commit).
   * Auto paths should leave this false so unverified work does not become HEAD.
   */
  force?: boolean;
}

/**
 * Durable accumulation store — commit verified layers, re-query discoveries
 * without an LLM call, materialise compact context for successor workers.
 */
export interface DurableStateStore {
  /** Prepare storage for a project. Idempotent. */
  init(projectRoot: string): Promise<void>;
  /**
   * Authoritative commit after verification (or force). Advances HEAD.
   * Throws or returns structured error implementations may choose fail-open
   * wrappers instead; the file backend throws only on hard I/O failures.
   */
  commit(input: StateCommitInput): Promise<StateCommitMeta>;
  /** Current HEAD metadata, or null if no commits yet. */
  head(): Promise<StateCommitMeta | null>;
  get(id: StateCommitId): Promise<StateCommitMeta | null>;
  list(limit?: number): Promise<StateCommitMeta[]>;
  /**
   * Point HEAD at an existing commit (does not rewrite artifacts).
   * Used by `/state restore` and mid-mission resume. Throws if id unknown.
   */
  setHead(id: StateCommitId): Promise<StateCommitMeta>;
  /** Zero-LLM re-query of discoveries (HEAD if id omitted). */
  loadDiscoveries(id?: StateCommitId): Promise<Discovery[]>;
  /**
   * Compact text block for the volatile prompt section.
   * Caps length so it cannot blow context.
   */
  materializeContext(id?: StateCommitId, maxChars?: number): Promise<string>;
  close(): Promise<void>;
}
