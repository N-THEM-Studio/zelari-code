/**
 * Unified live-task model (Desktop).
 *
 * M1: only "session" tasks exist — the per-conversation mirror of the
 * todo_write / todo_read tool payloads. The shapes are envelope-ready so
 * M2 (run multiplexing, per-run event routing) and M3 (workspace project
 * tasks) can extend them without breaking the persisted Conversation
 * schema.
 */

/** Mirror of CLI session todo statuses (src/cli/sessionTodos.ts).
 * `blocked` is workspace-plan only (ADR-0018) and never persists on a
 * Conversation's sessionTasks. */
export type LiveTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "blocked";

/** Where a task comes from. */
export type LiveTaskSource = "session" | "project";

export interface LiveTask {
  id: string;
  content: string;
  status: LiveTaskStatus;
  source: LiveTaskSource;
  /**
   * Workspace-plan phase metadata (project tasks only, ADR-0018).
   * Absent on session tasks and on plans without `phases[]`; drives the
   * phase grouping of the Project panel.
   */
  phaseId?: string;
  phaseLabel?: string;
  phaseOrder?: number;
  /**
   * Hygiene flags of the workspace plan store ('reopened' | 'stale' |
   * 'overlap', t56+). Carried into the UI so a completed task that got
   * dirty again can re-appear with a badge instead of staying hidden
   * history (ADR-0018 + agenttrail "completed task that re-lights").
   */
  flags?: string[];
}

/**
 * Envelope every task mutation will travel with once run events carry
 * run/conversation identity (M2). Declared now so new call sites can be
 * written against it instead of raw todo payloads.
 */
export interface LiveTaskEvent {
  conversationId: string;
  source: LiveTaskSource;
  tasks: LiveTask[];
  /** todo_write merge=true semantics (upsert by id). */
  merge?: boolean;
}
