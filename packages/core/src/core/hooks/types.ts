/**
 * Lifecycle hook types — provider-neutral contract for PreToolUse /
 * PostToolUse / SessionStart / SessionEnd hooks.
 *
 * Design (v1.32.0):
 * - FAIL-OPEN: a crashing, timing-out, or misbehaving hook NEVER blocks a
 *   tool. The only way to block is an explicit JSON decision `deny`.
 * - Hooks are external processes (or HTTP endpoints) that receive a JSON
 *   payload on stdin / request body and reply with a JSON decision on
 *   stdout / response body.
 * - Tool matching is Claude-code style: case/separator-insensitive and
 *   alias-aware (`Bash` matches tool `bash`, `Read` matches `read_file`).
 *
 * @see lifecycleHookRunner.ts — the runner that executes these hooks
 * @since v1.32.0
 */

/** Hook event names. */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd';

/** A single tool matcher entry — Claude-like glob over tool names. */
export interface HookToolMatch {
  /** Tool name patterns. `*` matches any tool. Case/alias-insensitive. */
  tools: string[];
  /** Events this hook fires on. */
  events: HookEvent[];
}

/**
 * One hook definition, loaded from a JSON file (or injected in tests).
 *
 * File layout (`~/.zelari-code/hooks/<name>.json` or
 * `<project>/.zelari/hooks/<name>.json`):
 *
 * ```json
 * {
 *   "name": "deny-rm",
 *   "match": { "tools": ["bash"], "events": ["PreToolUse"] },
 *   "command": "node deny-rm.mjs",
 *   "timeoutMs": 5000
 * }
 * ```
 *
 * Exactly one of `command` | `url` must be present.
 */
export interface HookDefinition {
  /** Stable hook name (used in logs + deny reason). */
  name: string;
  /** Tool/event matcher. */
  match: HookToolMatch;
  /** Shell command to run. Receives JSON on stdin, replies JSON on stdout. */
  command?: string;
  /** HTTP endpoint (POST). Receives JSON body, replies JSON body. */
  url?: string;
  /** Per-hook timeout in ms (default: runner default, 5000). */
  timeoutMs?: number;
  /** Working directory for the command (default: process.cwd()). */
  cwd?: string;
}

/** JSON payload sent to a hook. */
export interface HookPayload {
  event: HookEvent;
  /** Normalized (canonical) tool name being invoked. */
  toolName?: string;
  /** Raw tool input args (validated). */
  toolInput?: unknown;
  /** Tool result for PostToolUse. */
  toolOutput?: unknown;
  /** Whether the tool call succeeded (PostToolUse). */
  ok?: boolean;
  sessionId?: string;
  cwd?: string;
  /** Error message when the tool call failed. */
  error?: string;
}

/** JSON decision a hook must reply with. */
export type HookDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string };

/** Result of a PreToolUse evaluation (always allow unless explicitly denied). */
export interface PreToolUseResult {
  ok: boolean;
  /** Hook name that denied (when !ok). */
  hookName?: string;
  /** Deny reason surfaced to the model/user (when !ok). */
  reason?: string;
}

/** Result of a SessionStart/SessionEnd evaluation. */
export interface SessionHookResult {
  ok: boolean;
  hookName?: string;
  reason?: string;
}

/**
 * Normalize a tool name for matching: lowercase + strip separators, then
 * apply Claude-style aliases so `Bash`/`shell`/`terminal` all map to `bash`
 * and `Read`/`cat` map to `read_file`. Mirrors the registry alias map so
 * hook authors can use either spelling.
 */
export function normalizeToolName(raw: string): string {
  const n = raw.toLowerCase().replace(/[_-]/g, '');
  return TOOL_ALIASES[n] ?? n;
}

/** Alias map (Claude-code style). Keys are normalized (no separators). */
const TOOL_ALIASES: Record<string, string> = {
  read: 'read_file',
  readfile: 'read_file',
  cat: 'read_file',
  write: 'write_file',
  writefile: 'write_file',
  edit: 'edit_file',
  editfile: 'edit_file',
  glob: 'list_files',
  listdir: 'list_files',
  listdirectory: 'list_files',
  ls: 'list_files',
  dir: 'list_files',
  find: 'list_files',
  grep: 'grep_content',
  search: 'grep_content',
  searchrag: 'searchDocuments',
  rag: 'searchDocuments',
  shell: 'bash',
  terminal: 'bash',
  cmd: 'bash',
  run: 'bash',
  exec: 'bash',
};

/** True if `pattern` matches `toolName` (case/alias-insensitive, `*` = any). */
export function toolMatches(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  return normalizeToolName(pattern) === normalizeToolName(toolName);
}

/** True if this hook matches the given event + tool name. */
export function hookMatches(
  hook: HookDefinition,
  event: HookEvent,
  toolName: string | undefined,
): boolean {
  if (!hook.match.events.includes(event)) return false;
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    if (!toolName) return false;
    return hook.match.tools.some((t) => toolMatches(t, toolName));
  }
  // Session events: no tool component.
  return true;
}
