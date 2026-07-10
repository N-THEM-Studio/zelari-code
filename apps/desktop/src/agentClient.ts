import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentEvent,
  CliStatus,
  DesktopConfig,
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
}): Promise<{ ok?: boolean; message?: string }> {
  return invoke("set_app_config", { args });
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
