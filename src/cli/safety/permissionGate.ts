/**
 * WS1 / t133 — pre-dispatch permission GATE.
 *
 * The seam the tool registry calls BEFORE a tool body runs (see
 * wrapWithPermissions in toolRegistry.ts). It joins the three inputs of the
 * engine — a project config, session rules and the historical category
 * decision — and owns the two side effects of a denial:
 *
 *   1. a best-effort spine event `permission.denied` through the SAME
 *      SessionEventInput sink the file.* telemetry uses
 *      (ToolContext.emitSessionEvent), so a replayed session exposes it; and
 *   2. one entry in the in-memory denial ledger `/permissions` shows.
 *
 * Contract:
 *   - ZERO rules configured  → `evaluateToolDispatch` returns null and the
 *     registry keeps today's decision, byte-identical;
 *   - deny  → the caller blocks the dispatch with a message NAMING the rule;
 *   - ask   → the existing approval flow, untouched;
 *   - allow → only the CATEGORY default is promoted (an ask becomes an allow,
 *     skipping the prompt); a category deny or another layer's ask/deny is
 *     never relaxed — see the merge in wrapWithPermissions.
 *
 * @since v2.56.0 (WS1 / t133)
 */
import type { SessionEventInput } from '@zelari/core/session';
import type { ToolPermission } from '@zelari/core/harness/tools/toolTypes';
// WS5 (t137): the OBSERVER hook surface (PermissionRequest / Notification
// subscribers). Type + one pure formatter only — the gate never gates on it.
import {
  summarizeHookArgs,
  type HookContext,
  type LifecycleHookRunner,
  type PermissionRequestPayload,
} from '@zelari/core/harness';
import { claimMatchValues, resourceClaimsFor } from './resourceClaims.js';
import { activePermissionRules } from './permissionRules.js';
import {
  evaluatePermissionPolicy,
  formatPermissionDenial,
  type PermissionRequest,
  type PermissionRuleSource,
  type PermissionVerdict,
} from './permissionPolicy.js';
import type { PermissionAction } from './toolPermissions.js';

/** Session-spine sink shape (ToolContext.emitSessionEvent). */
export type PermissionEventSink = (input: SessionEventInput) => Promise<unknown>;

/** Spine event kind emitted on a rule denial (WS1 vocabulary addition). */
export const PERMISSION_DENIED_KIND = 'permission.denied' as const;

export interface DispatchPermissionInput {
  toolName: string;
  required: readonly ToolPermission[];
  args: unknown;
  /** Workspace root — locates `.zelari/permissions.json` and anchors paths. */
  root: string;
}

/**
 * Derive what the engine looks at from ONE tool call: the declared categories
 * plus the concrete resources the invocation can touch (paths, host). Reuses
 * the resource-claims table so a path deny can never be dodged by a second
 * argument (apply_diff headers, observe_batch operations, …).
 */
export function buildPermissionRequest(input: DispatchPermissionInput): PermissionRequest {
  const paths: string[] = [];
  let host: string | undefined;
  for (const claim of resourceClaimsFor(input.toolName, input.args)) {
    if (claim.kind === 'path') {
      for (const candidate of claimMatchValues(claim, input.root)) {
        if (!paths.includes(candidate)) paths.push(candidate);
      }
    } else if (claim.kind === 'network' && host === undefined) {
      host = claim.host;
    }
  }
  return {
    toolName: input.toolName,
    categories: input.required,
    ...(paths.length > 0 ? { paths } : {}),
    ...(host !== undefined ? { host } : {}),
  };
}

/**
 * The gate's verdict for one dispatch, or null when there is NOTHING to say:
 * no rule configured (zero-rule fast path → the category decision stands) or
 * no rule matched (the engine's "> category default" step). A malformed
 * project config is never silent: it comes back as a fail-closed 'ask'.
 */
export function evaluateToolDispatch(input: DispatchPermissionInput): PermissionVerdict | null {
  const { rules, error } = activePermissionRules(input.root);
  if (error !== undefined) {
    return {
      decision: 'ask',
      source: 'fail-closed',
      reason: `[permissions] ${error}`,
    };
  }
  if (rules.length === 0) return null;
  let request: PermissionRequest;
  try {
    request = buildPermissionRequest(input);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      decision: 'ask',
      source: 'fail-closed',
      reason: `[permissions] could not derive the resources of "${input.toolName}" (${detail}) — failing closed`,
    };
  }
  const verdict = evaluatePermissionPolicy(rules, request);
  // No rule matched ⇒ no opinion ⇒ the 5-category decision stands.
  return verdict.source === 'fail-closed' ? null : verdict;
}

/**
 * Promote an 'ask' to 'allow' only when the CATEGORY decided the ask. A
 * category deny (env `ZELARI_PERMISSION_*`) and every other layer's ask/deny
 * (agent rules, claims, contract) are left untouched: an allow rule can skip
 * a prompt, never a restriction.
 */
export function applyAllowRule(categoryAction: PermissionAction): PermissionAction {
  return categoryAction === 'ask' ? 'allow' : categoryAction;
}

/** One denial, as the ledger (and `/permissions`) sees it. */
export interface PermissionDenialRecord {
  ts: number;
  tool: string;
  matchedRuleId: string;
  source: PermissionRuleSource;
  reason: string;
  sessionId?: string;
}

const MAX_RECENT_DENIALS = 20;
let denialLedger: PermissionDenialRecord[] = [];

/** Record a denial for `/permissions`. Never throws, never blocks a dispatch. */
export function recordPermissionDenial(record: PermissionDenialRecord): void {
  denialLedger = [record, ...denialLedger].slice(0, MAX_RECENT_DENIALS);
}

/** Most recent denials, newest first. */
export function listRecentPermissionDenials(limit = 10): PermissionDenialRecord[] {
  return denialLedger.slice(0, Math.max(0, limit));
}

export function clearPermissionDenials(): void {
  denialLedger = [];
}

/** The denial line the user sees ("denied "write_file" — [permissions:project] rule '…'"). */
export function permissionDenialMessage(toolName: string, verdict: PermissionVerdict): string {
  return formatPermissionDenial(toolName, verdict);
}

export interface PermissionDeniedEmitResult {
  recorded: boolean;
  seq?: number;
}

function seqFrom(result: unknown): number | undefined {
  const raw =
    result !== null && typeof result === 'object' && 'seq' in result
      ? (result as { seq: unknown }).seq
      : undefined;
  const seq = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(seq) && seq > 0 ? seq : undefined;
}

/**
 * WS5 (t137): the OBSERVER-hook side of the gate — the two things a hook
 * subscribed to the spine learns from one dispatch decision:
 *
 *   - `PermissionRequest` — fired for EVERY resolution to `ask` or `deny`
 *     (payload: tool, categories, effect, matched WS1 rule with source+reason,
 *     bounded argsSummary). It is NOT a second gate: the runner's observer
 *     methods return void and discard whatever the hook replies, so a slow /
 *     crashing / non-2xx subscriber can neither block the dispatch nor change
 *     the WS1 verdict (fail-open and fail-closed are untouched).
 *   - `Notification` — fired only on `deny`, because that is exactly when the
 *     WS2 inbox (`src/cli/inboxSources.ts`) GAINS a `needs-input` item.
 *
 * Best-effort by contract: never throws, and a missing runner is a no-op.
 */
export interface PermissionHookInput {
  tool: string;
  /** Declared permission categories of the call. */
  categories: readonly string[];
  /** The resolved effect: a prompt (`ask`) or a block (`deny`). */
  effect: 'ask' | 'deny';
  /** The WS1 verdict, when a rule drove the decision. */
  verdict?: PermissionVerdict | null;
  /** Raw tool args — summarized (never echoed whole) into the payload. */
  args?: unknown;
}

/** Pure: one dispatch decision → the `PermissionRequest` hook payload. */
export function buildPermissionRequestHookPayload(input: PermissionHookInput): PermissionRequestPayload {
  const verdict = input.verdict ?? null;
  const argsSummary = summarizeHookArgs(input.args);
  const reason = verdict?.reason?.trim();
  return {
    tool: input.tool,
    categories: [...input.categories],
    effect: input.effect,
    ...(verdict?.matchedRuleId ? { matchedRuleId: verdict.matchedRuleId } : {}),
    ...(verdict?.source ? { source: verdict.source } : {}),
    ...(reason ? { reason } : {}),
    ...(argsSummary ? { argsSummary } : {}),
  };
}

/** Fire `PermissionRequest` (+ `Notification` on deny). Never throws. */
export async function emitPermissionObserverHooks(
  hooks: LifecycleHookRunner | null | undefined,
  input: PermissionHookInput,
  ctx: HookContext = {},
): Promise<void> {
  if (!hooks) return;
  const payload = buildPermissionRequestHookPayload(input);
  try {
    await hooks.runPermissionRequest(payload, ctx);
  } catch {
    /* an observer never propagates into the gate */
  }
  if (payload.effect !== 'deny') return;
  try {
    await hooks.runNotification(
      {
        source: 'needs-input',
        kind: PERMISSION_DENIED_KIND,
        summary: `tool "${payload.tool}" was denied by ${payload.matchedRuleId || 'a permission rule'}`,
        tool: payload.tool,
      },
      ctx,
    );
  } catch {
    /* an observer never propagates into the gate */
  }
}
export async function emitPermissionDenied(
  sink: PermissionEventSink | undefined,
  payload: { tool: string; verdict: PermissionVerdict; sessionId?: string; ts?: number },
): Promise<PermissionDeniedEmitResult> {
  const { tool, verdict } = payload;
  const ts = payload.ts ?? Date.now();
  recordPermissionDenial({
    ts,
    tool,
    matchedRuleId: verdict.matchedRuleId ?? '',
    source: verdict.source,
    reason: verdict.reason,
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
  });
  if (!sink) return { recorded: false };
  try {
    const result = await sink({
      kind: PERMISSION_DENIED_KIND,
      actor: { type: 'system', role: 'permissions' },
      data: {
        tool,
        matchedRuleId: verdict.matchedRuleId ?? '',
        source: verdict.source,
        reason: verdict.reason,
      },
    });
    const seq = seqFrom(result);
    return seq !== undefined ? { recorded: true, seq } : { recorded: true };
  } catch {
    return { recorded: false };
  }
}
