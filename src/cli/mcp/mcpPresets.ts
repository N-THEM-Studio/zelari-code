/**
 * Named MCP presets for optional capabilities (Cua Driver, Composio Connect).
 * Does not vendor binaries — only writes ~/.zelari-code/mcp.json (or project).
 *
 * Presets are FACTORIES: env-dependent config (e.g. COMPOSIO_API_KEY) is read
 * at apply time, never captured at module load.
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

/**
 * Composio Connect MCP preset (composio.dev). 500+ app integrations exposed
 * as MCP tools via `npx composio-mcp`. The API key passes through env
 * (never written into argv/mcp.json args) and is read at APPLY time.
 */
export function buildComposioPreset(): McpPreset {
  return {
    id: "composio",
    servers: {
      composio: {
        command: "npx",
        args: ["-y", "composio-mcp@latest"],
        env: process.env.COMPOSIO_API_KEY
          ? { COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY }
          : {},
        enabled: true,
      },
    },
    notes: [
      "Composio Connect — 500+ app integrations (GitHub, Slack, Notion, ...) as MCP tools.",
      "Set COMPOSIO_API_KEY before applying: export COMPOSIO_API_KEY=<key>",
      "Connect apps at https://composio.dev — each connected account becomes a tool.",
      "The key is stored in mcp.json env, never in argv.",
      "Kill switch: disable the composio server in mcp.json or ZELARI_MCP=0",
    ],
  };
}

/**
 * Qwen-MM-Plugins MCP preset (QwenLM/Qwen-MM-Plugins). Multimodal tools
 * (vision, video, audio, 3D, web search) served over stdio via `uvx`.
 * The capability is selected at APPLY time through QWEN_MM_PLUGIN (default
 * `qwen-mm-plugins-core`); API keys pass through env, never argv.
 *
 * The package is NOT published to PyPI — `uvx qwen-mm-plugins-core` fails to
 * resolve. uvx needs a PEP 508 direct reference to the immutable GitHub
 * release tag (mirrors upstream install.sh cap_spec / CAP_VERSIONS).
 * PYTHONIOENCODING=utf-8 fixes a cp1252 UnicodeEncodeError on Windows
 * consoles (the system-check table prints U+2717); native Windows is
 * verified working.
 */
export function buildQwenMmPreset(): McpPreset {
  const plugin = process.env.QWEN_MM_PLUGIN?.trim() || "qwen-mm-plugins-core";
  const cap = plugin.replace(/^qwen-mm-plugins-/, "");
  const spec = `qwen-mm-plugins[${cap}] @ git+https://github.com/QwenLM/Qwen-MM-Plugins.git@${plugin}-v1.0.1`;
  return {
    id: "qwen-mm-plugins",
    servers: {
      "qwen-mm-plugins": {
        command: "uvx",
        args: ["--from", spec, plugin],
        env: {
          PYTHONIOENCODING: "utf-8",
          ...(process.env.DASHSCOPE_API_KEY
            ? { DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY }
            : {}),
          ...(process.env.SERPER_API_KEY
            ? { SERPER_API_KEY: process.env.SERPER_API_KEY }
            : {}),
        },
        enabled: true,
      },
    },
    notes: [
      "Qwen-MM-Plugins — multimodal capabilities (core / video-memory / video-edit / blender / freecad) as MCP tools.",
      "Installs via uvx from the GitHub release tag (qwen-mm-plugins-<cap>-v1.0.1); first launch downloads ~70 packages.",
      "Windows: verified working natively with PYTHONIOENCODING=utf-8 (WSL2 also supported upstream).",
      "Pick a capability: export QWEN_MM_PLUGIN=qwen-mm-plugins-video-memory (default: qwen-mm-plugins-core).",
      "API keys read at apply time: DASHSCOPE_API_KEY, SERPER_API_KEY (native reading works without them).",
      "Blender/FreeCAD variants: start the host app before invoking tools.",
      "Kill switch: disable the qwen-mm-plugins server in mcp.json or ZELARI_MCP=0",
    ],
  };
}

const PRESETS: Record<string, () => McpPreset> = {
  cua: () => CUA_DRIVER_PRESET,
  "cua-driver": () => CUA_DRIVER_PRESET,
  composio: buildComposioPreset,
  "qwen-mm-plugins": buildQwenMmPreset,
  "qwen-mm": buildQwenMmPreset,
};

export function listMcpPresetIds(): string[] {
  return Object.keys(PRESETS).filter(
    (k) => k === "cua" || k === "composio" || k === "qwen-mm-plugins",
  ); // canonical ids only
}

export function getMcpPreset(id: string): McpPreset | null {
  const factory = PRESETS[id.trim().toLowerCase()];
  return factory ? factory() : null;
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
