import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentEvent,
  CliStatus,
  DesktopConfig,
  DiscoverModelsResult,
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
  return invoke<string>("run_task", { args });
}

export async function cancelRun(): Promise<void> {
  return invoke("cancel_run");
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
