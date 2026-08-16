/**
 * Run multiplexing model (Desktop, M2).
 *
 * The Rust host (src-tauri) stamps every emitted event
 * (`agent-event`, `agent-stderr`, `run-finished`, `run-started`) with
 * run identity: `runId`, `conversationId`, `cwd`. These types mirror
 * that envelope and back the RunRegistry on the frontend.
 */

export type RunStatus = "starting" | "running" | "finished" | "error" | "cancelled";

export interface RunRuntime {
  runId: string;
  conversationId: string;
  cwd?: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  /** Completion not yet viewed in the sidebar (cleared on chat select). */
  unseenResult?: boolean;
}

export interface RunRegistryState {
  runsById: Record<string, RunRuntime>;
  runIdByConversation: Record<string, string>;
}

/** Identity fields read from an enveloped backend event payload. */
export interface RunEnvelope {
  runId?: string;
  conversationId?: string;
  cwd?: string;
}

/** Max finished runs kept in the registry (leak guard). */
export const MAX_RETAINED_FINISHED_RUNS = 12;

export function readRunEnvelope(ev: unknown): RunEnvelope {
  const any = ev as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v ? v : undefined;
  return {
    runId: str(any?.runId),
    conversationId: str(any?.conversationId),
    cwd: str(any?.cwd),
  };
}
