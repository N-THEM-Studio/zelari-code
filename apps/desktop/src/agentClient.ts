import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentEvent,
  CliStatus,
  DesktopConfig,
  DiscoverModelsResult,
  GitStatusSnapshot,
  ListDirResult,
  RunTaskArgs,
} from "./types";

export async function getCliStatus(): Promise<CliStatus> {
  return invoke<CliStatus>("get_cli_status");
}

export async function getAppConfig(): Promise<DesktopConfig> {
  return invoke<DesktopConfig>("get_app_config");
}

export async function setAppConfig(args: {
  provider?: string;
  model?: string;
  endpoint?: string;
  endpointClear?: boolean;
}): Promise<{ ok?: boolean; message?: string }> {
  return invoke("set_app_config", { args });
}

export async function setApiKey(args: {
  provider: string;
  key: string;
}): Promise<{ ok?: boolean; provider?: string; masked?: string }> {
  return invoke("set_api_key", { args });
}

export async function discoverModels(args: {
  provider?: string;
}): Promise<DiscoverModelsResult> {
  return invoke("discover_models", { args });
}

export interface CliUpdateCheck {
  installed?: string | null;
  npmLatest?: string | null;
  updateAvailable: boolean;
  message: string;
}

export async function checkCliUpdate(): Promise<CliUpdateCheck> {
  return invoke<CliUpdateCheck>("check_cli_update");
}

export async function updateCli(args?: {
  version?: string;
}): Promise<{ ok?: boolean; installed?: string; output?: string; package?: string }> {
  return invoke("update_cli", { args: args ?? {} });
}

export async function runTask(args: RunTaskArgs): Promise<string> {
  // Rust expects `history` as a JSON string (Option<String>) that it forwards
  // verbatim to the CLI as `--history <json>`. The desktop works in typed
  // arrays; serialize here so the boundary stays clean.
  const payload = args.history
    ? { ...args, history: JSON.stringify(args.history) }
    : { ...args, history: undefined };
  return invoke<string>("run_task", { args: payload });
}

export async function cancelRun(): Promise<void> {
  return invoke("cancel_run");
}

export async function getGitStatus(args?: {
  cwd?: string | null;
}): Promise<GitStatusSnapshot> {
  return invoke<GitStatusSnapshot>("get_git_status", {
    args: { cwd: args?.cwd ?? null },
  });
}

export async function listDir(args?: {
  path?: string | null;
  cwd?: string | null;
}): Promise<ListDirResult> {
  return invoke<ListDirResult>("list_dir", {
    args: {
      path: args?.path ?? null,
      cwd: args?.cwd ?? null,
    },
  });
}

export interface McpServerEntryDto {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  scope: "user" | "project";
  path: string;
}

export interface McpConfigSnapshot {
  userPath: string;
  projectPath: string | null;
  servers: McpServerEntryDto[];
  merged: Record<string, unknown>;
}

export async function printMcp(args?: {
  cwd?: string | null;
}): Promise<McpConfigSnapshot> {
  return invoke<McpConfigSnapshot>("print_mcp", {
    args: { cwd: args?.cwd ?? null },
  });
}

export async function setMcp(args: {
  name: string;
  command: string;
  args?: string[];
  scope?: "user" | "project";
  enabled?: boolean;
  cwd?: string | null;
}): Promise<{ ok?: boolean; path?: string; name?: string; scope?: string }> {
  return invoke("set_mcp", {
    args: {
      name: args.name,
      command: args.command,
      args: args.args ?? null,
      scope: args.scope ?? "user",
      enabled: args.enabled ?? true,
      cwd: args.cwd ?? null,
    },
  });
}

export async function removeMcp(args: {
  name: string;
  scope?: "user" | "project";
  cwd?: string | null;
}): Promise<{ ok?: boolean; path?: string }> {
  return invoke("remove_mcp", {
    args: {
      name: args.name,
      scope: args.scope ?? "user",
      cwd: args.cwd ?? null,
    },
  });
}

export interface SshTargetDto {
  id: string;
  name: string;
  host: string;
  port?: number;
  user: string;
  auth: "agent" | "keyPath" | "password";
  /** Local private key path (never key bytes). */
  keyPath?: string;
  /** Local .pub path for display/copy to authorized_keys. */
  publicKeyPath?: string;
  /**
   * One-shot on save only — never returned by list.
   * Stored in ~/.zelari-code/ssh-secrets.json
   */
  password?: string;
  /** True if a password is stored for this target (list only). */
  hasPassword?: boolean;
  defaultRemotePath?: string;
  tags?: string[];
  allowedCommands?: string[];
  enabled?: boolean;
  notes?: string;
}

export async function printSshTargets(): Promise<{
  path: string;
  targets: SshTargetDto[];
}> {
  return invoke("print_ssh_targets");
}

export async function setSshTarget(
  target: SshTargetDto,
): Promise<{ ok?: boolean; id?: string }> {
  return invoke("set_ssh_target", {
    args: { json: JSON.stringify(target) },
  });
}

export async function removeSshTarget(id: string): Promise<{ ok?: boolean }> {
  return invoke("remove_ssh_target", { args: { id } });
}

export async function testSshTarget(
  id: string,
): Promise<{ ok: boolean; message: string }> {
  return invoke("test_ssh_target", { args: { id } });
}

export async function printSshPubkey(path: string): Promise<
  | { ok: true; path: string; content: string }
  | { ok: false; error: string }
> {
  return invoke("print_ssh_pubkey", { args: { path } });
}

export async function onAgentEvent(
  handler: (event: AgentEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentEvent>("agent-event", (e) => handler(e.payload));
}

export async function onAgentStderr(
  handler: (line: string) => void,
): Promise<UnlistenFn> {
  return listen<{ line: string }>("agent-stderr", (e) =>
    handler(e.payload.line),
  );
}

export async function onRunFinished(
  handler: (payload: {
    runId: string;
    exitCode: number;
    cancelled: boolean;
  }) => void,
): Promise<UnlistenFn> {
  return listen("run-finished", (e) =>
    handler(
      e.payload as { runId: string; exitCode: number; cancelled: boolean },
    ),
  );
}

export function extractDelta(ev: AgentEvent): string {
  if (ev.type === "message_delta" || ev.type === "thinking_delta") {
    const any = ev as Record<string, unknown>;
    const candidates = [any.delta, any.text, any.content, any.chunk];
    for (const c of candidates) {
      if (typeof c === "string" && c.length) return c;
    }
  }
  return "";
}

export function extractToolName(ev: AgentEvent): string {
  const any = ev as Record<string, unknown>;
  for (const k of ["toolName", "name", "tool", "tool_name"]) {
    const v = any[k];
    if (typeof v === "string" && v) return v;
  }
  return "tool";
}

export function extractToolCallId(ev: AgentEvent): string | undefined {
  const any = ev as Record<string, unknown>;
  // Do not use bare "id" — BrainEventBase.id is the event UUID, not toolCallId.
  for (const k of ["toolCallId", "tool_call_id", "callId"]) {
    const v = any[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/** One-line summary from tool args (path, command, query, …). Max ~80 chars. */
export function summarizeToolArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args || typeof args !== "object") return "";
  const lower = toolName.toLowerCase();
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number" || typeof v === "boolean") return String(v);
    }
    return "";
  };

  let raw = "";
  if (
    lower.includes("bash") ||
    lower.includes("shell") ||
    lower === "exec" ||
    lower.includes("run")
  ) {
    raw = pick("command", "cmd", "script", "code");
  } else if (
    lower.includes("read") ||
    lower.includes("write") ||
    lower.includes("edit") ||
    lower.includes("cat")
  ) {
    raw = pick("path", "file", "file_path", "filepath", "target", "filename");
  } else if (
    lower.includes("grep") ||
    lower.includes("search") ||
    lower.includes("find")
  ) {
    raw =
      pick("pattern", "query", "q", "search") ||
      pick("path", "directory", "dir", "glob");
  } else {
    raw =
      pick(
        "path",
        "file",
        "file_path",
        "command",
        "query",
        "pattern",
        "url",
        "name",
        "prompt",
        "message",
      ) || "";
  }

  if (!raw) {
    // First short string value as last resort
    for (const v of Object.values(args)) {
      if (typeof v === "string" && v.trim() && v.length < 120) {
        raw = v.trim();
        break;
      }
    }
  }

  if (!raw) return "";
  // Prefer basename for long paths
  if (raw.length > 48 && /[/\\]/.test(raw) && !raw.includes(" ")) {
    const base = raw.replace(/\\/g, "/").split("/").filter(Boolean).pop();
    if (base) raw = base;
  }
  return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
}

export function extractToolResult(ev: AgentEvent): string {
  const any = ev as Record<string, unknown>;
  for (const k of ["result", "output", "content", "message"]) {
    const v = any[k];
    if (typeof v === "string") return v;
  }
  return "";
}

export function extractToolIsError(ev: AgentEvent): boolean {
  const any = ev as Record<string, unknown>;
  if (typeof any.isError === "boolean") return any.isError;
  if (typeof any.success === "boolean") return !any.success;
  if (typeof any.ok === "boolean") return !any.ok;
  return false;
}

export function extractToolDurationMs(ev: AgentEvent): number | undefined {
  const any = ev as Record<string, unknown>;
  const v = any.durationMs ?? any.duration_ms ?? any.duration;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return undefined;
}

/** Truncate tool result for compact card preview. */
export function truncateToolPreview(text: string, maxLines = 5, maxChars = 320): string {
  if (!text) return "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sliced = lines.slice(0, maxLines).join("\n");
  if (sliced.length > maxChars) return `${sliced.slice(0, maxChars - 1)}…`;
  if (lines.length > maxLines) return `${sliced}\n…`;
  return sliced;
}
