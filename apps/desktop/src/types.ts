export type Role = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  streaming?: boolean;
  toolName?: string;
  meta?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  council: boolean;
}

export interface CliStatus {
  ok: boolean;
  node?: string | null;
  cliPath?: string | null;
  cliVersion?: string | null;
  cwd: string;
  message: string;
}

export interface RunTaskArgs {
  prompt: string;
  council?: boolean;
  provider?: string;
  model?: string;
}

/** Subset of BrainEvent shapes we care about for the chat UI. */
export type AgentEvent =
  | { type: "message_delta"; delta?: string; text?: string; content?: string }
  | { type: "message_start"; role?: string }
  | { type: "message_end" }
  | { type: "thinking_delta"; delta?: string; text?: string }
  | { type: "tool_execution_start"; toolName?: string; name?: string; tool?: string }
  | { type: "tool_execution_end"; toolName?: string; name?: string; success?: boolean }
  | { type: "agent_start" }
  | { type: "agent_end"; reason?: string }
  | { type: "error"; message?: string; error?: string }
  | { type: "log"; message?: string }
  | { type: string; [key: string]: unknown };
