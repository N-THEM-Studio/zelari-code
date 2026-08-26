import type { LiveTask } from "./liveTasks/types";

export type Role = "user" | "assistant" | "system" | "tool";

/** Mirrors CLI shift+tab modes. */
/** Mirrors CLI shift+tab modes. `agent` is a legacy alias of `kraken`. */
export type DispatchMode = "kraken" | "council" | "zelari";

/** Mirrors CLI /plan /build phases. */
export type WorkPhase = "plan" | "build";

export type AppView = "chat" | "settings";

export type SessionFilter = "active" | "archived";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  streaming?: boolean;
  toolName?: string;
  /** Correlates start/end tool events from the CLI. */
  toolCallId?: string;
  toolStatus?: "running" | "done";
  toolOk?: boolean;
  toolDurationMs?: number;
  /** Short one-line summary derived from tool args (path, command, …). */
  toolSummary?: string;
  /** Council member display name (e.g. Caronte) when attributed. */
  memberName?: string;
  memberId?: string;
  meta?: string;
  /** Light run stats attached when a turn finishes. */
  stats?: MessageStats;
}

export interface MessageStats {
  durationMs?: number;
  toolCount?: number;
  charCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  mode: DispatchMode;
  phase: WorkPhase;
  provider?: string;
  model?: string;
  /** Working directory bound to this conversation (per-chat workspace).
   * Undefined = inherit the Tauri process cwd. Legacy chats are migrated
   * from the old global `zelari-desktop-workdir` key on load. */
  cwd?: string;
  archived?: boolean;
  archivedAt?: number;
  /** Session tasks (todo_write/todo_read mirror) scoped to this chat. */
  sessionTasks?: LiveTask[];
  /** 2.0 spine session owned by this conversation (E1.4). Captured from the
   * CLI `session_started` event on turn 1; passed back as --resume <id> on
   * every following runTask so the model context is derived from the spine
   * event log instead of replaying the 1.x history snapshot. */
  sessionId?: string;

  /** Rolling provider-side history snapshot emitted by the CLI. Replayed on
   * the next runTask so the headless agent keeps multi-turn context. */
  history?: AgentMessageLite[];
}

export interface CliStatus {
  ok: boolean;
  node?: string | null;
  cliPath?: string | null;
  cliVersion?: string | null;
  cwd: string;
  message: string;
}

export interface DesktopProviderInfo {
  id: string;
  displayName: string;
  hasKey: boolean;
  envVar: string;
  models: string[];
  defaultModel: string;
  endpoint?: string | null;
  baseUrl?: string | null;
  authKind?: "none" | "api_key" | "oauth";
  expiresAt?: number | null;
  hasRefreshToken?: boolean;
  oauthSupported?: boolean;
  thinking?: string;
  thinkingCapability?: {
    effort?: boolean;
    budget?: boolean;
    efforts?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  };
}

export interface DesktopConfig {
  activeProviderId: string;
  modelByProvider: Record<string, string>;
  providers: DesktopProviderInfo[];
  /** Kraken selection verifier override. null = inherit
   * (same as current model — the recommended default). */
  krakenVerifier?: { provider: string; model: string } | null;
  cliVersion: string;
  configPaths: {
    provider: string;
    keys: string;
  };
}

export interface RunTaskArgs {
  prompt: string;
  mode?: DispatchMode;
  phase?: WorkPhase;
  /** @deprecated prefer mode */
  council?: boolean;
  provider?: string;
  model?: string;
  /** Working directory chosen via "Open Folder". When set, the CLI agent runs
   * inside it. Undefined = inherit the Tauri process cwd. */
  cwd?: string;
  /** Conversation this run belongs to (multi-chat). Echoed by the host on
   * every event envelope so the UI can route deltas to the right chat. */
  conversationId?: string;
  /** 2.0 spine session to resume (E1.4): forwarded as --resume <id>; the
   * CLI derives model context from the event log. */
  sessionId?: string;

  /** JSON-encoded prior conversation turns, so the agent keeps multi-turn
   * context across the per-message process boundary. Built from the
   * chat UI (2.1 T9: CLI history_snapshot removed); degraded-spine fallback. */
  history?: AgentMessageLite[];
  /** Session todo list mirrored from todo_write/todo_read, replayed to the
   * CLI so the fresh per-message process keeps multi-turn tasks (todo_read
   * returns the prior state instead of empty). */
  todos?: Array<{ id: string; content: string; status: string }>;
  /**
   * When true, the prompt is planned + executed as a Kraken task graph
   * (`--kraken-graph <prompt>`) instead of a normal `--task` dispatch —
   * bypasses `mode` entirely. @since Kraken graph engine F6
   */
  krakenGraph?: boolean;
  /** Kraken graph "plan" phase: write the plan to disk without executing. */
  planOnly?: boolean;
  /** Kraken graph "build" phase after plan: execute the saved plan by id. */
  runPlan?: string;
  /** Capability profile (ADR-0022): minimal/v1 | kraken/v1 | council/v1 | mission/v1. */
  profile?: string;
  /** Evidence-based BUILD completion gate (`--strict-done` / ZELARI_STRICT_DONE=1). */
  strictDone?: boolean;
  /** Mission evidence gate (default on; ZELARI_MISSION_STRICT). */
  missionStrict?: boolean;
  /** Native criteria pack (ZELARI_VERIFY_PACK). */
  verifyPack?: boolean;
  /** Advisory verifier override; undefined preserves automatic model selection. */
  verifierReview?: boolean;
  /** Experimental Best-of-N (sets ZELARI_EXPERIMENTAL=bon on the spawned CLI). */
  bonAlpha?: boolean;
  /** Host-driven Gauntlet loop (`--gauntlet` / ZELARI_GAUNTLET=1). */
  gauntletLoop?: boolean;
  /** Model override for Kraken read-only / exploration tentacles. */
  krakenExploreModel?: string;
  /** Model override for Kraken general code-writing tentacles. */
  krakenGeneralModel?: string;
  /** Model override for Kraken verify tentacles. */
  krakenVerifyModel?: string;
  /** Model override for Kraken Graph planning. */
  krakenPlannerModel?: string;
  /** Kraken delegation policy (automatic|prefer|aggressive|lead-only). Omitted/automatic = CLI default. */
  krakenDelegation?: string;
}

/**
 * Mirror of the CLI's AgentMessage. We store snapshots of these per
 * conversation and replay them on the next runTask so the headless agent
 * has context (answers "procedi" / "sì" correctly instead of amnesia).
 */
export interface AgentMessageLite {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  /** DeepSeek/GLM thinking-mode echo field (must survive multi-turn history). */
  reasoningContent?: string;
}

export interface DiscoverModelsResult {
  ok?: boolean;
  provider?: string;
  models?: string[];
  fetchedAt?: number;
  baseUrl?: string;
  error?: string;
}

export interface UsageBreakdown {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Subset of BrainEvent shapes we care about for the chat UI. */
export type AgentEvent =
  | { type: "session_started"; sessionId?: string; spine?: string }


  | {
      type: "message_delta";
      delta?: string;
      text?: string;
      content?: string;
      memberName?: string;
      memberId?: string;
    }
  | {
      type: "message_start";
      role?: string;
      memberName?: string;
      memberId?: string;
    }
  | {
      type: "message_end";
      memberName?: string;
      memberId?: string;
      usage?: UsageBreakdown;
    }
  | { type: "thinking_delta"; delta?: string; text?: string }
  | {
      type: "tool_execution_start";
      toolName?: string;
      name?: string;
      tool?: string;
      toolCallId?: string;
      args?: Record<string, unknown>;
    }
  | {
      type: "tool_execution_end";
      toolName?: string;
      name?: string;
      toolCallId?: string;
      success?: boolean;
      isError?: boolean;
      result?: string;
      durationMs?: number;
    }
  | {
      type: "agent_start";
      memberName?: string;
      memberId?: string;
      model?: string;
      provider?: string;
    }
  | {
      type: "agent_end";
      reason?: string;
      memberName?: string;
      memberId?: string;
      durationMs?: number;
    }
  | {
      type: "member_cost";
      cost?: {
        memberId?: string;
        name?: string;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        durationMs?: number;
        toolCalls?: number;
        errored?: boolean;
      };
    }
  | { type: "error"; message?: string; error?: string }
  | { type: "log"; message?: string }
  | { type: "protocol_info"; version?: number; capabilities?: string[] }
  | { type: "control_accepted"; controlId?: string; controlType?: string }
  | { type: "control_applied"; controlId?: string; controlType?: string; boundary?: string }
  | { type: "control_rejected"; controlId?: string; reason?: string }
  | {
      type: "agent_spawned";
      runId?: string;
      agentId?: string;
      parentAgentId?: string;
      role?: string;
      model?: string;
      provider?: string;
      title?: string;
      scope?: string[];
      graphNodeId?: string;
      worktree?: string;
      ts?: number;
    }
  | {
      type: "agent_status";
      agentId?: string;
      status?: string;
      message?: string;
      ts?: number;
    }
  | {
      type: "agent_tool";
      agentId?: string;
      toolCallId?: string;
      tool?: string;
      status?: string;
      summary?: string;
      durationMs?: number;
      ts?: number;
    }
  | {
      type: "agent_ended";
      agentId?: string;
      reason?: string;
      durationMs?: number;
      tokenUsage?: { input?: number; output?: number };
      ts?: number;
    }
  | { type: string; [key: string]: unknown };

export interface GitFileChange {
  path: string;
  added: number | null;
  removed: number | null;
  untracked: boolean;
}

export interface GitStatusSnapshot {
  isRepo: boolean;
  branch: string | null;
  files: GitFileChange[];
  cwd: string;
  error?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface ListDirResult {
  path: string;
  entries: DirEntry[];
  error?: string;
}
