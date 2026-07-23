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
  archived?: boolean;
  archivedAt?: number;
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
}

export interface DesktopConfig {
  activeProviderId: string;
  modelByProvider: Record<string, string>;
  providers: DesktopProviderInfo[];
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
  /** JSON-encoded prior conversation turns, so the agent keeps multi-turn
   * context across the per-message process boundary. Built from the
   * `history_snapshot` events emitted by the CLI. */
  history?: AgentMessageLite[];
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
  | { type: "history_snapshot"; messages: AgentMessageLite[] }
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
