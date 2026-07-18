/**
 * Named MCP presets for optional capabilities (Cua Driver, …).
 * Does not vendor binaries — only writes ~/.zelari-code/mcp.json (or project).
 */

import type { McpServerConfig } from "./mcpClient.js";
import {
  upsertMcpServer,
  type McpConfigScope,
} from "./mcpConfigIo.js";

export interface McpPreset {
  id: string;
  /** Config keys written under mcpServers. */
  servers: Record<string, McpServerConfig>;
  /** Human install / permission notes printed after apply. */
  notes: string[];
}

/** Official Cua Driver MCP entry (trycua/cua). Binary must be on PATH. */
export const CUA_DRIVER_PRESET: McpPreset = {
  id: "cua",
  servers: {
    "cua-driver": {
      command: "cua-driver",
      args: ["mcp"],
      enabled: true,
    },
  },
  notes: [
    "Install the binary first: https://cua.ai/docs/how-to-guides/driver/install",
    "  /bin/bash -c \"$(curl -fsSL https://cua.ai/driver/install.sh)\"",
    "Verify: cua-driver --version  &&  cua-driver doctor",
    "macOS: grant Accessibility + Screen Recording (cua-driver permissions grant)",
    "Kill switch: ZELARI_CUA=0  (or disable the server / ZELARI_MCP=0)",
    "Council: Cua tools are skipped for specialists unless ZELARI_CUA_COUNCIL=1",
  ],
};

const PRESETS: Record<string, McpPreset> = {
  cua: CUA_DRIVER_PRESET,
  "cua-driver": CUA_DRIVER_PRESET,
};

export function listMcpPresetIds(): string[] {
  return Object.keys(PRESETS).filter((k) => k === "cua"); // canonical ids only
}

export function getMcpPreset(id: string): McpPreset | null {
  return PRESETS[id.trim().toLowerCase()] ?? null;
}

export function applyMcpPreset(opts: {
  presetId: string;
  scope?: McpConfigScope;
  projectRoot?: string | null;
}):
  | { ok: true; path: string; preset: McpPreset; servers: string[] }
  | { ok: false; error: string } {
  const preset = getMcpPreset(opts.presetId);
  if (!preset) {
    return {
      ok: false,
      error: `Unknown preset "${opts.presetId}". Known: ${listMcpPresetIds().join(", ")}`,
    };
  }
  const scope = opts.scope ?? "user";
  let lastPath = "";
  const names: string[] = [];
  for (const [name, config] of Object.entries(preset.servers)) {
    const r = upsertMcpServer({
      scope,
      name,
      config,
      projectRoot: opts.projectRoot,
    });
    if (!r.ok) return { ok: false, error: r.error };
    lastPath = r.path;
    names.push(name);
  }
  return { ok: true, path: lastPath, preset, servers: names };
}

/** Server names treated as Cua Driver (for kill switch / council filter). */
export function isCuaMcpServerName(name: string): boolean {
  const n = name.toLowerCase();
  return n === "cua-driver" || n === "cua" || n.startsWith("cua-");
}

/** When true, skip loading Cua MCP servers entirely. */
export function isCuaDisabled(): boolean {
  return process.env["ZELARI_CUA"] === "0";
}

/**
 * When false (default), Cua MCP tools are not registered for council
 * specialist-heavy turns. Set ZELARI_CUA_COUNCIL=1 to allow.
 * Agent mode always registers Cua when MCP is on and Cua is installed.
 */
export function isCuaAllowedForCouncil(): boolean {
  return process.env["ZELARI_CUA_COUNCIL"] === "1";
}
