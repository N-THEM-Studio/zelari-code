/**
 * Pure parsing/validation for the "add / edit custom MCP server" form.
 *
 * The Desktop never writes mcp.json itself: it ships a payload to `set_mcp`,
 * which lands in `upsertMcpServer` (src/cli/mcp/mcpConfigIo.ts). The rules here
 * mirror that boundary on purpose — same name charset, command required for a
 * stdio entry — so the user sees the error inline instead of a failed CLI
 * round-trip.
 */
import type { McpServerEntryDto } from "../agentClient";

export type McpScope = "user" | "project";

export interface McpServerDraft {
  name: string;
  command: string;
  argsText: string;
  envText: string;
  scope: McpScope;
}

export interface McpCustomServerPayload {
  name: string;
  command: string;
  args: string[];
  /** undefined → no env channel for this draft (field left empty). */
  env?: Record<string, string>;
  scope: McpScope;
}

export interface McpDraftErrors {
  name?: string;
  command?: string;
  env?: string;
  /** Whole-form failure (scope without workdir, CLI error on save). */
  form?: string;
}

/** Same charset upsertMcpServer enforces. */
const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const COMMAND_PREVIEW_MAX = 56;

export function emptyDraft(scope: McpScope = "user"): McpServerDraft {
  return { name: "", command: "", argsText: "", envText: "", scope };
}

/** Prefill for "Edit": one argument per line, one KEY=VALUE per line. */
export function draftFromEntry(entry: McpServerEntryDto): McpServerDraft {
  return {
    name: entry.name,
    command: entry.command ?? "",
    argsText: (entry.args ?? []).join("\n"),
    envText: Object.entries(entry.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    scope: entry.scope === "project" ? "project" : "user",
  };
}

/** One argument per line, blanks dropped (as in Claude Desktop's JSON array). */
export function parseArgsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * `KEY=VALUE` per line. `#` starts a comment line, surrounding double quotes on
 * a value are stripped (dotenv-style), blank lines are ignored.
 */
export function parseEnvText(
  text: string,
): { env?: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (eq < 0 || !ENV_KEY_RE.test(key)) {
      return { error: `Invalid env line "${line}" — use KEY=VALUE.` };
    }
    const value = line.slice(eq + 1);
    env[key] = value.replace(/^"(.*)"$/, "$1");
  }
  return { env: Object.keys(env).length > 0 ? env : undefined };
}

/** Description fallback for a server that has no catalog entry. */
export function commandPreview(
  command: string,
  args: string[] | undefined,
  max = COMMAND_PREVIEW_MAX,
): string {
  const full = [command, ...(args ?? [])].join(" ").trim();
  if (full.length <= max) return full;
  return `${full.slice(0, max - 1).trimEnd()}…`;
}

/** Validate a draft and, when it passes, produce the `set_mcp` payload. */
export function buildCustomServerPayload(
  draft: McpServerDraft,
  opts: { workdir: string | null },
): { errors: McpDraftErrors; payload: McpCustomServerPayload | null } {
  const errors: McpDraftErrors = {};
  const name = draft.name.trim();
  const command = draft.command.trim();

  if (!name) errors.name = "Name is required.";
  else if (!NAME_RE.test(name)) {
    errors.name = "Name must use letters, digits, _ or - only.";
  }
  if (!command) errors.command = "Command is required (npx, node, uvx…).";

  const parsed = parseEnvText(draft.envText);
  if (parsed.error) errors.env = parsed.error;

  if (draft.scope === "project" && !opts.workdir) {
    errors.form = "Open a project folder first for project-scoped servers.";
  }

  if (errors.name || errors.command || errors.env || errors.form) {
    return { errors, payload: null };
  }
  return {
    errors,
    payload: {
      name,
      command,
      args: parseArgsText(draft.argsText),
      env: parsed.env,
      scope: draft.scope,
    },
  };
}
