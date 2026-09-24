/**
 * Permission SPINE EVENTS — the observability half of the old WS1 gate.
 *
 * ADR-0039 P3b (t149): engine A — the `.zelari/permissions.json` +
 * `/permissions add` rule EVALUATION — is REMOVED. What survives here is the
 * event layer every decision flows through:
 *
 *   1. `permission.denied` — best-effort spine event through the SAME
 *      SessionEventInput sink the file.* telemetry uses
 *      (ToolContext.emitSessionEvent), so a replayed session exposes it.
 *      (t142) That event is the ONLY denial record: `/permissions` derives
 *      its ledger from the spine projection (slashHandlers/permissions.ts) —
 *      the old in-process RAM buffer is gone (ADR-0016/0024 derive-only).
 *   2. `permission.asked` / `auto_approve.granted` (WS7 slice 4).
 *   3. The WS5 observer-hook payloads (`buildPermissionRequestHookPayload`).
 *
 * Decisions themselves live in toolRegistry.ts (category defaults × engine B
 * layers × TaskContract); this module only OBSERVES them.
 *
 * @since v2.56.0 (WS1 / t133); reduced to events-only in v2.62 (ADR-0039 P3b)
 */
import type { ToolPermission } from '@zelari/core/harness/tools/toolTypes';
// WS5 (t137): the OBSERVER hook surface (PermissionRequest / Notification
// subscribers). Type + one pure formatter only — events never gate on it.
import {
  summarizeHookArgs,
  type HookContext,
  type LifecycleHookRunner,
  type PermissionRequestPayload,
} from '@zelari/core/harness';
import { claimMatchValues, resourceClaimsFor } from './resourceClaims.js';
import { emitDecisionEvent, type DecisionEventSink } from './decisionEmit.js';
// ADR-0039 Phase 1: a deny decided by engine B names the policy rule that did
// it — the layer's own shape, imported as a TYPE only (no engine coupling).
import type { PolicyRule } from './policyEngine.js';
import type { PermissionAction } from './toolPermissions.js';

// ADR-0039 P3b (t149): `permissionPolicy.ts` / `permissionRules.ts` are
// DELETED (engine A). Only inert payload shapes remain, defined locally so
// old spine events keep replaying with their original shape; no caller
// produces an engine-A verdict anymore.
/** What one dispatch touches (paths, host) — derived from the resource-claims table. */
interface PermissionRequest {
  toolName: string;
  categories: readonly ToolPermission[];
  paths?: string[];
  host?: string;
}
/** Engine-A verdict shape — inert optional payload type; kept for replay only. */
type PermissionVerdict = {
  decision: 'allow' | 'ask' | 'deny';
  source: string;
  matchedRuleId?: string;
  reason?: string;
};

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
  /** Workspace root — anchors paths. */
  root: string;
}

/**
 * Derive what the decision looks at from ONE tool call: the declared
 * categories plus the concrete resources the invocation can touch (paths,
 * host). Reuses the resource-claims table so a path deny can never be dodged
 * by a second argument (apply_diff headers, observe_batch operations, …).
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

export interface PermissionDeniedEmitResult {
  recorded: boolean;
  seq?: number;
  /** One-line contract violation, when the payload was rejected (not written). */
  error?: string;
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
 * WS5 (t137): the OBSERVER-hook side — the two things a hook subscribed to
 * the spine learns from one dispatch decision:
 *
 *   - `PermissionRequest` — fired for EVERY resolution to `ask` or `deny`
 *     (payload: tool, categories, effect, matched rule with source+reason,
 *     bounded argsSummary). It is NOT a second gate: the runner's observer
 *     methods return void and discard whatever the hook replies, so a slow /
 *     crashing / non-2xx subscriber can neither block the dispatch nor change
 *     the verdict (fail-open and fail-closed are untouched).
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
  /** A deciding-layer verdict, when one drove the decision. */
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

/**
 * ADR-0039 Phase 1 — the deciding layer of a deny.
 *
 * `source` is a plain string on purpose: the spine payload is read as one
 * (`parsePermissionDenial` in replay.ts, `deriveOpenNeeds` in inboxSources.ts)
 * and this vocabulary is the MESSAGE convention `rulePrefix` already uses
 * (`[contract] rule '…'` / `[policy] rule '…'` / `[policy] claim '…'`) plus the
 * category decision.
 */
export interface PermissionDenialOrigin {
  /** `contract` (TaskContract capability), `policy` (engine B rule OR claim), `default` (category). */
  source: 'contract' | 'policy' | 'default';
  /** The layer's own matcher (B rules have no `id`; their pattern is the identity). */
  matchedRuleId?: string;
  reason?: string;
}

export interface PermissionDeniedEmitInput {
  tool: string;
  /** Legacy engine-A verdict — inert since P3b; old events keep replaying. */
  verdict?: PermissionVerdict | null;
  /** Deciding layer of the deny (engine B rule/claim, TaskContract, category default). */
  origin?: PermissionDenialOrigin | null;
  sessionId?: string;
  ts?: number;
}

/**
 * ADR-0039 Phase 1 — WHICH layer denied.
 *
 * Only a layer whose effect IS `deny` is eligible: naming a layer that asked
 * would make the event lie about the rule that blocked the call. Ties follow
 * the operator-facing `rulePrefix` order — a TaskContract restriction is the
 * most specific intent, then engine B's agent rule, then a resource claim —
 * and the category decision is the floor, so this never returns null.
 */
export function denyOriginFor(input: {
  rule?: PolicyRule | null;
  claimRule?: PolicyRule | null;
  contractRule?: PolicyRule | null;
  categoryReason?: string;
}): PermissionDenialOrigin {
  const layers: Array<[PermissionDenialOrigin['source'], PolicyRule | null | undefined]> = [
    ['contract', input.contractRule],
    ['policy', input.rule],
    ['policy', input.claimRule],
  ];
  for (const [source, layer] of layers) {
    if (layer?.effect !== 'deny') continue;
    const matched = layer.match.trim();
    const reason = layer.reason?.trim();
    return {
      source,
      ...(matched !== '' ? { matchedRuleId: matched } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  const categoryReason = input.categoryReason?.trim();
  return { source: 'default', ...(categoryReason ? { reason: categoryReason } : {}) };
}

/**
 * The `permission.denied` payload contract, enforced BEFORE the sink is
 * touched: a line nobody can read would poison every later replay and
 * silently drop the denial from the inbox (`deriveOpenNeeds` skips an event
 * with no `tool`). Reported, not silently skipped: the guard mirrors what the
 * readers in replay.ts / inboxSources.ts actually require (`tool` names the
 * call, `source` names the decider; `reason` stays optional and free-form).
 */
function denialPayloadError(tool: unknown, source: unknown): string | null {
  if (typeof tool !== 'string' || tool.trim() === '') return 'tool: must be a non-empty tool name';
  if (typeof source !== 'string' || source.trim() === '') {
    return 'source: must name the deciding layer';
  }
  return null;
}

/**
 * `permission.denied` (WS1/t133) — the ONE writer for EVERY deny, whichever
 * layer decided it (engine B rule or claim, TaskContract, category default).
 *
 * Contract:
 *   - a deny must NAME its deciding layer; with neither `verdict` nor `origin`
 *     the event is DROPPED, never written with an invented source;
 *   - best-effort: a missing sink, a throwing sink or a rejected payload
 *     returns `{recorded:false}` and NEVER propagates — recording a denial
 *     must not be able to change the denial itself;
 *   - exactly ONE event per dispatch: the caller emits from the FINAL deny
 *     branch only (wrapWithPermissions in toolRegistry.ts), never twice.
 */
export async function emitPermissionDenied(
  sink: PermissionEventSink | undefined,
  payload: PermissionDeniedEmitInput,
): Promise<PermissionDeniedEmitResult> {
  const { tool } = payload;
  const denial: { matchedRuleId: string; source: string; reason?: string } | null =
    payload.verdict?.decision === 'deny'
      ? {
          matchedRuleId: payload.verdict.matchedRuleId ?? '',
          source: payload.verdict.source,
          reason: payload.verdict.reason,
        }
      : payload.origin
        ? {
            matchedRuleId: payload.origin.matchedRuleId ?? '',
            source: payload.origin.source,
            ...(payload.origin.reason !== undefined ? { reason: payload.origin.reason } : {}),
          }
        : null;
  if (denial === null) {
    return { recorded: false, error: 'no deciding layer — a deny must name one' };
  }
  const contractError = denialPayloadError(tool, denial.source);
  if (contractError !== null) return { recorded: false, error: contractError };
  // t142: the spine event below is the ONLY denial record — no in-process ledger.
  if (!sink) return { recorded: false };
  try {
    const result = await sink({
      kind: PERMISSION_DENIED_KIND,
      actor: { type: 'system', role: 'permissions' },
      data: {
        tool,
        matchedRuleId: denial.matchedRuleId,
        source: denial.source,
        ...(denial.reason !== undefined ? { reason: denial.reason } : {}),
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
  /** `default` / `preset` — mirrors decisionEvents.ts. */
  source: string;
  matchedRuleId?: string;
  reason?: string;
}

export interface AutoApproveOriginInput {
  /** The FINAL effect: every layer merged, provenance + yolo applied. */
  effect: PermissionAction;
  /** Declared permission categories of the call (`read`, `write`, `execute`, …). */
  categories: readonly string[];
  /** Legacy engine-A allow-rule verdict — inert since P3b. */
  verdict?: PermissionVerdict | null;
  /** True when `--permissions yolo` promoted this dispatch's ask to allow. */
  yoloPromoted?: boolean;
}

/**
 * SELECTION RULE for `auto_approve.granted` — which allows the spine records.
 * An allow is recorded only when the harness actually DECIDED something:
 *
 *   (a) `--permissions yolo` promoted an ask to allow — an explicit opt-in;
 *   (b) an `execute` / `network` CATEGORY default — privileged side effects.
 *
 * Every other category default (`read`, `write`, `ui`) is deliberately NOT
 * recorded: those are the bulk of all dispatches and recording them would
 * flood the spine with events that carry no decision. Returns null ⇒ nothing
 * to say.
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
  /** Reason shown to the operator — the deciding layer's when one forced the ask. */
  reason?: string;
}

/**
 * `permission.asked` — the decision block resolved this dispatch to a PROMPT.
 * Emitted for EVERY ask, including the fail-closed one (no interactive
 * approver attached): the DECISION was "ask", whichever way it then resolved.
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
 * `auto_approve.granted` — the same decision block resolved to ALLOW without
 * a prompt. The caller passes the origin `autoApproveOrigin()` selected.
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
