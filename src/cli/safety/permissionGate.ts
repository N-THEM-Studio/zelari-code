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
 *      (ToolContext.emitSessionEvent), so a replayed session exposes it.
 *
 *   (t142) That event is now the ONLY denial record: `/permissions` derives
 *   its ledger from the spine projection (see slashHandlers/permissions.ts) —
 *   the old in-process RAM buffer is gone (ADR-0016/0024 derive-only).
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
import { emitDecisionEvent, type DecisionEventSink } from './decisionEmit.js';
import { activePermissionRules } from './permissionRules.js';
import {
  evaluatePermissionPolicy,
  formatPermissionDenial,
  type PermissionRequest,
  type PermissionVerdict,
} from './permissionPolicy.js';
import type { PermissionAction } from './toolPermissions.js';

/**
 * Session-spine sink shape (ToolContext.emitSessionEvent). One definition for
 * the whole CLI decision surface — see `decisionEmit.ts` (WS7 slice 4).
 */
export type PermissionEventSink = DecisionEventSink;

/** Spine event kind emitted on a rule denial (WS1 vocabulary addition). */
export const PERMISSION_DENIED_KIND = 'permission.denied' as const;

/** Spine event kind emitted when a dispatch resolves to a PROMPT (WS7 slice 4). */
export const PERMISSION_ASKED_KIND = 'permission.asked' as const;

/** Spine event kind emitted when a dispatch is allowed with NO prompt (WS7 slice 4). */
export const AUTO_APPROVE_GRANTED_KIND = 'auto_approve.granted' as const;

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

// t142: the denial ledger is DERIVE-ONLY — `/permissions` reads the
// `permission.denied` events already on the session spine (see
// slashHandlers/permissions.ts). No in-process buffer remains here.

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
  // t142: the spine event below is the ONLY denial record — no in-process ledger.
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

// ── WS7 slice 4 (t139): the ALLOW / PROMPT side of the same decision block ──

/** Where an ALLOW came from, when it is worth recording (see `autoApproveOrigin`). */
export interface AutoApproveOrigin {
  /** `default` / `project` / `session` / `preset` — mirrors decisionEvents.ts. */
  source: string;
  matchedRuleId?: string;
  reason?: string;
}

export interface AutoApproveOriginInput {
  /** The FINAL effect: every layer merged, provenance + yolo applied. */
  effect: PermissionAction;
  /** Declared permission categories of the call (`read`, `write`, `execute`, …). */
  categories: readonly string[];
  /** The WS1 rule verdict, when a rule drove the decision. */
  verdict?: PermissionVerdict | null;
  /** True when `--permissions yolo` promoted this dispatch's ask to allow. */
  yoloPromoted?: boolean;
}

/**
 * SELECTION RULE for `auto_approve.granted` — which allows the spine records.
 * The deny side (WS1) records only RULE denials; an allow is recorded only when
 * the harness actually DECIDED something:
 *
 *   (a) an ALLOW RULE matched (project/session rule) — the rule made the call;
 *   (b) `--permissions yolo` promoted an ask to allow — an explicit opt-in;
 *   (c) an `execute` / `network` CATEGORY default — privileged side effects.
 *
 * Every other category default (`read`, `write`, `ui`) is deliberately NOT
 * recorded: those are the bulk of all dispatches and recording them would
 * flood the spine with events that carry no decision. Returns null ⇒ nothing
 * to say (same contract as `evaluateToolDispatch`).
 */
export function autoApproveOrigin(input: AutoApproveOriginInput): AutoApproveOrigin | null {
  if (input.effect !== 'allow') return null;
  if (input.yoloPromoted === true) {
    return { source: 'preset', reason: 'yolo (--permissions yolo) promoted an ask to allow' };
  }
  const verdict = input.verdict ?? null;
  if (verdict?.decision === 'allow') {
    return {
      source: verdict.source,
      ...(verdict.matchedRuleId ? { matchedRuleId: verdict.matchedRuleId } : {}),
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    };
  }
  const privileged = input.categories.filter((c) => c === 'execute' || c === 'network');
  if (privileged.length > 0) {
    return { source: 'default', reason: `${privileged.join('+')} category default` };
  }
  return null;
}

export interface PermissionAskedEmitInput extends Omit<PermissionHookInput, 'effect'> {
  /** Reason shown to the operator — the rule's when a rule forced the ask. */
  reason?: string;
}

/**
 * `permission.asked` — the gate resolved this dispatch to a PROMPT. Emitted for
 * EVERY ask, including the fail-closed one (no interactive approver attached):
 * the DECISION was "ask", whichever way it then resolved. Payload reuses the
 * WS5 hook formatter (`buildPermissionRequestHookPayload`: tool, categories,
 * effect `ask`, rule origin, bounded argsSummary) — the same fields the
 * `permission.asked` contract in decisionEvents.ts mirrors.
 */
export async function emitPermissionAsked(
  sink: PermissionEventSink | undefined,
  input: PermissionAskedEmitInput,
): Promise<{ recorded: boolean; seq?: number }> {
  const base = buildPermissionRequestHookPayload({ ...input, effect: 'ask' });
  const reason = input.reason?.trim();
  return emitDecisionEvent(
    sink,
    PERMISSION_ASKED_KIND,
    { ...base, ...(reason ? { reason } : {}) },
    { type: 'system', role: 'permissions' },
  );
}

/**
 * `auto_approve.granted` — the same decision block resolved to ALLOW without a
 * prompt. The caller passes the origin `autoApproveOrigin()` selected.
 */
export async function emitAutoApproveGranted(
  sink: PermissionEventSink | undefined,
  payload: { tool: string; categories: readonly string[]; origin: AutoApproveOrigin },
): Promise<{ recorded: boolean; seq?: number }> {
  const { origin } = payload;
  return emitDecisionEvent(
    sink,
    AUTO_APPROVE_GRANTED_KIND,
    {
      tool: payload.tool,
      categories: [...payload.categories],
      source: origin.source,
      ...(origin.matchedRuleId ? { matchedRuleId: origin.matchedRuleId } : {}),
      ...(origin.reason ? { reason: origin.reason } : {}),
    },
    { type: 'system', role: 'permissions' },
  );
}
