/**
 * Kraken Activity model (Desktop, PHASE 3 §38–39).
 *
 * Mirrors the activity BrainEvents emitted by the CLI (`agent_spawned`,
 * `agent_status`, `agent_tool`, `agent_ended`) plus the PHASE 2 control
 * acknowledgements. Structurally typed locally so the panel does not
 * depend on the CLI package build.
 */

export type ActivityAgentRole =
  | "lead"
  | "explore"
  | "general"
  | "verify"
  | "planner"
  | "council"
  | "mission"
  | string;

export type ActivityAgentStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface ActivityToolEvent {
  id: string;
  tool: string;
  status: "started" | "completed" | "failed";
  summary?: string;
  durationMs?: number;
  ts?: number;
}

export interface ActivityAgent {
  id: string;
  parentId?: string;
  role: ActivityAgentRole;
  title?: string;
  model?: string;
  provider?: string;
  status: ActivityAgentStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  reason?: string;
  tokenUsage?: { input?: number; output?: number };
  scope?: string[];
  worktree?: string;
  graphNodeId?: string;
  currentTool?: string;
  tools: ActivityToolEvent[];
}

export interface ActivityWarning {
  code: string;
  message: string;
  agentId?: string;
  ts?: number;
}

export type ControlState = "accepted" | "applied" | "rejected";

export interface ControlAttempt {
  id: string;
  type: string;
  state: ControlState;
  boundary?: string;
  reason?: string;
}

export interface RunActivityState {
  runId?: string;
  /** Insertion order of agent ids (stable listing). */
  agentOrder: string[];
  agents: Record<string, ActivityAgent>;
  warnings: ActivityWarning[];
  controls: ControlAttempt[];
}

export const MAX_TOOLS_PER_AGENT = 40;
export const MAX_WARNINGS = 20;
export const MAX_CONTROLS = 30;

export const ACTIVITY_STATUSES: readonly ActivityAgentStatus[] = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
];
