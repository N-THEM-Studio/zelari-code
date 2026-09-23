/**
 * Lifecycle hook types — provider-neutral contract for PreToolUse /
 * PostToolUse / SessionStart / SessionEnd hooks, plus the v2.57 OBSERVER
 * events PermissionRequest / SubagentStart / SubagentEnd / Notification.
 *
 * Design (v1.32.0):
 * - FAIL-OPEN: a crashing, timing-out, or misbehaving hook NEVER blocks a
 *   tool. The only way to block is an explicit JSON decision `deny`.
 * - v2.57 (WS5): a hook is also a SUBSCRIBER of the spine. The four OBSERVER
 *   events (see {@link OBSERVER_HOOK_EVENTS}) are fire-and-forget: their
 *   decision is DISCARDED by contract, so a crashing / slow / non-2xx hook on
 *   those events can neither block nor corrupt anything. Only the four v1.32
 *   events can block (PreToolUse), and that never changes here.
 * - Hooks are external processes (or HTTP endpoints) that receive a JSON
 *   payload on stdin / request body and reply with a JSON decision on
 *   stdout / response body.
 * - Tool matching is Claude-code style: case/separator-insensitive and
 *   alias-aware (`Bash` matches tool `bash`, `Read` matches `read_file`).
 *
 * @see lifecycleHookRunner.ts — the runner that executes these hooks
 * @since v1.32.0
 */

/**
 * Hook event names. `VerificationFailed` (K5.3 / F32) fires when the
 * strict-done gate BLOCKS a turn: LOUD observability whose decision is
 * discarded (observer semantics below) — the verdict is recorded and final,
 * the hook reports it, never overrides it.
 */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd' | 'VerificationFailed';

/**
 * v2.57 (WS5) observation-only event names. A hook registered on one of these
 * receives the structured payload below and its decision is IGNORED — see
 * {@link ObserverHookPayload}.
 */
export type ObserverHookEvent = 'PermissionRequest' | 'SubagentStart' | 'SubagentEnd' | 'Notification';

/** Every event a hook can be registered on (v1.32 tooling + v2.57 observers). */
export type AnyHookEvent = HookEvent | ObserverHookEvent;

/** The v2.57 observer events, as a value (docs / iteration / validation). */
export const OBSERVER_HOOK_EVENTS: readonly ObserverHookEvent[] = [
  'PermissionRequest',
  'SubagentStart',
  'SubagentEnd',
  'Notification',
];

/** True for the fire-and-forget events whose decision is discarded. */
export function isObserverEvent(event: AnyHookEvent): event is ObserverHookEvent {
  return (OBSERVER_HOOK_EVENTS as readonly string[]).includes(event);
}

/** Events carrying a tool component, matched against `match.tools`. */
const TOOL_SCOPED_EVENTS: readonly AnyHookEvent[] = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];

/** A single tool matcher entry — Claude-like glob over tool names. */
export interface HookToolMatch {
  /** Tool name patterns. `*` matches any tool. Case/alias-insensitive. */
  tools: string[];
  /** Events this hook fires on (v1.32 tooling events + v2.57 observers). */
  events: AnyHookEvent[];
  /**
   * v2.57 (WS5): optional SUBAGENT-kind filter for `SubagentStart` /
   * `SubagentEnd` (`general`, `explore`, `verify`, …). Absent ⇒ every kind,
   * which is the additive default for pre-v2.57 files. `*` matches any kind.
   * Ignored by every other event.
   */
  agents?: string[];
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
  /** K5.3 (F32): `VerificationFailed` — the strict-done block record. */
  verification?: VerificationFailedPayload;
}

/**
 * v2.57 (WS5): payload of a `PermissionRequest` observer hook — fired when the
 * permission gate resolved a dispatch to `ask` or `deny` (WS1/t133 gate), i.e.
 * exactly when the operator (or the host) is being asked, or when the call is
 * blocked by a rule.
 */
export interface PermissionRequestPayload {
  /** The tool whose dispatch needed a decision. */
  tool: string;
  /** Declared permission categories of that call (`read`, `write`, …). */
  categories: string[];
  /** Resolved effect for this dispatch: a prompt (`ask`) or a block (`deny`). */
  effect: 'ask' | 'deny';
  /** WS1 rule id that drove the decision — absent when no rule did. */
  matchedRuleId?: string;
  /** Layer the rule came from (`project` / `session` / `fail-closed` / …). */
  source?: string;
  /** The rule's own reason, verbatim. */
  reason?: string;
  /** Bounded one-line summary of the args (see {@link summarizeHookArgs}). */
  argsSummary?: string;
}

/**
 * v2.57 (WS5): payload of a `SubagentStart` / `SubagentEnd` observer hook —
 * fired around a Kraken tentacle run (the `task` tool and the graph executor
 * share the seam).
 */
export interface SubagentPayload {
  /** Sub-agent kind: `general` / `explore` / `verify` / persona kinds. */
  agent: string;
  /** The tentacle's one-line description. */
  description: string;
  /** Requested thoroughness, when the caller set one. */
  thoroughness?: string;
  /** WS3 isolation: does this tentacle run in its own git worktree? */
  worktree: boolean;
  /** Resolved `ZELARI_KRAKEN_WORKTREE` mode (`on` / `off` / `auto`). */
  worktreeMode?: string;
  /** Worktree path when isolation is active. */
  worktreePath?: string;
  /** Graph node / graph ids when the run came from the Kraken graph engine. */
  nodeId?: string;
  graphId?: string;
  /** Effective working directory of the sub-agent. */
  cwd?: string;
  /** SubagentEnd only: absent is NEVER a success claim. */
  ok?: boolean;
  cancelled?: boolean;
  durationMs?: number;
  /** SubagentEnd only: failure detail when the tentacle failed. */
  error?: string;
}

/**
 * v2.57 (WS5): payload of a `Notification` observer hook — fired when the WS2
 * inbox gains an item ("something is waiting on YOU"). Vocabulary mirrors
 * `src/cli/inboxSources.ts`: `question` (unanswered `ask_user`),
 * `tentacle-finished` (a Kraken node ended), `needs-input` (open verify debt /
 * a denied tool call).
 */
export interface NotificationPayload {
  /** Which inbox source this item belongs to. */
  source: 'question' | 'tentacle-finished' | 'needs-input';
  /** Spine event kind that produced it, when a spine event did. */
  kind?: string;
  /** One-line, already-collapsed summary of the item. */
  summary: string;
  /** Spine seq of the underlying event, when known. */
  seq?: number;
  /** Verify-debt slot id (`needs-input` / unverified work). */
  taskId?: string;
  /** Denied tool name (`needs-input` / denied). */
  tool?: string;
}

/**
 * K5.3 (F32): payload of a `VerificationFailed` hook — fired exactly once when
 * the strict-done gate blocks a turn. Small and truncated by contract: the ids
 * of the criteria that did not pass and the machine summary of the block.
 */
export interface VerificationFailedPayload {
  /** Ids of the unsatisfied criteria (capped by the emitter; empty when nothing bound). */
  criteria: string[];
  /** Short machine-readable block summary (truncated by the emitter). */
  reason: string;
}

/**
 * v2.57 (WS5): payload of an OBSERVER hook. Same envelope as {@link HookPayload}
 * minus the tool fields, plus the one structured block the event carries. The
 * `decision` a hook replies with is DISCARDED — these events are subscriptions,
 * so an unreliable observer (crash / timeout / non-2xx) can neither block nor
 * corrupt the spine.
 */
export interface ObserverHookPayload {
  event: ObserverHookEvent;
  sessionId?: string;
  cwd?: string;
  /** `PermissionRequest`. */
  permission?: PermissionRequestPayload;
  /** `SubagentStart` / `SubagentEnd`. */
  subagent?: SubagentPayload;
  /** `Notification`. */
  notification?: NotificationPayload;
}

/** Anything the runner can hand to a hook. */
export type AnyHookPayload = HookPayload | ObserverHookPayload;

/**
 * v2.57 (WS5): bounded, single-line summary of tool args for a hook payload —
 * "if safely available". Never throws (circular / exotic values degrade to a
 * type tag), never returns more than `max` characters, and collapses
 * whitespace so a hook can log it verbatim.
 */
export function summarizeHookArgs(value: unknown, max = 300): string {
  let text: string;
  try {
    if (value === undefined) return '';
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    text = json === undefined ? String(value) : json;
  } catch {
    return '[unserializable]';
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
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

/**
 * True if this hook matches the given event, tool name and (for the v2.57
 * subagent events) sub-agent kind.
 *
 * Matching rules:
 * - tool-scoped events (`PreToolUse`, `PostToolUse`, `PermissionRequest`)
 *   require a tool name and match it case/alias-insensitively against
 *   `match.tools`;
 * - `SubagentStart` / `SubagentEnd` match the AGENT KIND against
 *   `match.agents` when that filter is present (absent ⇒ every kind) —
 *   `match.tools` is NOT consulted;
 * - `SessionStart` / `SessionEnd` / `Notification` / `VerificationFailed`
 *   carry no subject: the event decides, `match.tools` is ignored (unchanged
 *   v1.32 behavior).
 */
export function hookMatches(
  hook: HookDefinition,
  event: AnyHookEvent,
  toolName: string | undefined,
  agentKind?: string,
): boolean {
  if (!hook.match.events.includes(event)) return false;
  if (TOOL_SCOPED_EVENTS.includes(event)) {
    if (!toolName) return false;
    return hook.match.tools.some((t) => toolMatches(t, toolName));
  }
  if (event === 'SubagentStart' || event === 'SubagentEnd') {
    const agents = hook.match.agents;
    if (!agents || agents.length === 0) return true; // additive: no filter ⇒ all kinds
    return agentKind !== undefined && agents.some((a) => toolMatches(a, agentKind));
  }
  // Session / Notification events: no tool component.
  return true;
}
