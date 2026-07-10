export type Role = "user" | "assistant" | "system" | "tool";

/** Mirrors CLI shift+tab modes. */
export type DispatchMode = "agent" | "council" | "zelari";

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
  meta?: string;
  /** Light run stats attached when a turn finishes. */
  stats?: MessageStats;
}

export interface MessageStats {
  durationMs?: number;
  toolCount?: number;
  charCount?: number;
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
}

export interface DiscoverModelsResult {
  ok?: boolean;
  provider?: string;
  models?: string[];
  fetchedAt?: number;
  baseUrl?: string;
  error?: string;
}

/** Subset of BrainEvent shapes we care about for the chat UI. */
export type AgentEvent =
  | { type: "message_delta"; delta?: string; text?: string; content?: string }
  | { type: "message_start"; role?: string }
  | { type: "message_end" }
  | { type: "thinking_delta"; delta?: string; text?: string }
  | {
      type: "tool_execution_start";
      toolName?: string;
      name?: string;
      tool?: string;
    }
  | {
      type: "tool_execution_end";
      toolName?: string;
      name?: string;
      success?: boolean;
    }
  | { type: "agent_start" }
  | { type: "agent_end"; reason?: string }
  | { type: "error"; message?: string; error?: string }
  | { type: "log"; message?: string }
  | { type: string; [key: string]: unknown };
