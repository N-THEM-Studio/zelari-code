import type { ToolPermission } from '@zelari/core/harness/tools/toolTypes';
import {
  grantSessionCategory,
  grantSessionTool,
  isSessionGranted,
  type PermissionAskHandler,
} from '../safety/toolPermissions.js';
import { getCurrentHarnessSessionId } from './sessionControl.js';

/**
 * Serve-harness permission bridge (Pilastro B, desktop parity slice).
 *
 * The sidecar host (`--serve-harness`) has no TUI, so since 2.32 the
 * fail-closed preset engine turns every `ask` into a typedErr for Desktop
 * runs. This module is the protocol foundation that lets a host bridge
 * `ask` decisions over the NDJSON transport instead of failing closed:
 *
 *   CLI → host : {"type":"permission.request","requestId":…,"tool":…,
 *                 "category":…,"inputPreview":…}   (stdout event)
 *   host → CLI : {"id":N,"method":"permission.respond",
 *                 "params":{"requestId":…,"decision":"allow"|"deny"|
 *                           "always-tool"|"always-category"}}
 *
 * Fail-closed by construction: an unanswered request DENIES after the
 * timeout (default 120s) — the bridge can never silently allow.
 *
 * Also carries the per-turn preset field (2.32 B-slice): Desktop Settings
 * sends `permissionPreset` on run.turn; the allowlist below is the ONLY
 * way it reaches process.env (no arbitrary env injection over the wire).
 */

/** The only presets a host may select (mirror of toolPermissions.ts). */
export const SERVE_PERMISSION_PRESETS = ['standard', 'strict', 'yolo'] as const;
export type ServePermissionPreset = (typeof SERVE_PERMISSION_PRESETS)[number];

const PRESET_ENV = 'ZELARI_PERMISSION_PRESET';

/**
 * Apply a per-turn `permissionPreset` from a run.turn envelope to the
 * shared preset engine (env-backed). Allowlisted; anything else is
 * ignored (returns false) — the sidecar process keeps its current preset.
 * Safe under the one-active-run-per-workspace policy the Desktop enforces.
 */
export function applyTurnPermissionPreset(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const raw = (input as Record<string, unknown>).permissionPreset;
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toLowerCase();
  if (!(SERVE_PERMISSION_PRESETS as readonly string[]).includes(value)) {
    return false;
  }
  process.env[PRESET_ENV] = value;
  return true;
}

export interface PermissionAskPayload {
  tool: string;
  category: string;
  categories?: string[];
  inputPreview?: string;
  reason?: string;
}

export const PERMISSION_DECISIONS = [
  'allow',
  'deny',
  'always-tool',
  'always-category',
] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return (
    typeof value === 'string' &&
    (PERMISSION_DECISIONS as readonly string[]).includes(value)
  );
}

interface PendingAsk {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  payload: PermissionAskPayload;
  /**
   * Harness session the ask was raised in (t59): stamped on the wire
   * events and used to scope `permission.respond` so one chat can never
   * settle another chat's dialog.
   */
  sessionId?: string;
}

export interface ServePermissionBridge {
  /** Registry-compatible ask handler: emits a request event and waits. */
  onPermissionAsk: (payload: PermissionAskPayload) => Promise<PermissionDecision>;
  /**
   * Resolve a pending request (idempotent: unknown ids are a no-op).
   * `scopeSessionId` (t59): when the host answer carries a session id,
   * it may only settle an ask raised in THAT session.
   */
  respond: (
    requestId: string,
    decision: PermissionDecision,
    scopeSessionId?: string,
  ) => boolean;
  /** Session a pending request belongs to (undefined = unscoped/legacy). */
  sessionOf: (requestId: string) => string | undefined;
  /**
   * After a session grant, allow any in-flight asks now covered so the
   * user is not asked 3× for the same category (parallel tentacle spawns).
   */
  releaseGranted: () => number;
  /** How many requests are awaiting a host answer (observability/tests). */
  pendingCount: () => number;
}

export function createServePermissionBridge(
  write: (line: string) => void,
  timeoutMs = 120_000,
): ServePermissionBridge {
  const pending = new Map<string, PendingAsk>();
  let seq = 0;

  const settle = (
    requestId: string,
    decision: PermissionDecision,
    timedOut = false,
  ): boolean => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    write(
      JSON.stringify({
        type: 'permission.settled',
        requestId,
        decision,
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        ...(timedOut ? { timedOut: true } : {}),
      }),
    );
    entry.resolve(decision);
    return true;
  };

  return {
    onPermissionAsk(payload) {
      const requestId = `perm-${Date.now()}-${++seq}`;
      const categories =
        payload.categories && payload.categories.length > 0
          ? payload.categories
          : payload.category
            ? payload.category.split(',').map((c) => c.trim()).filter(Boolean)
            : [];
      return new Promise<PermissionDecision>((resolve) => {
        const timer = setTimeout(() => {
          // Fail-closed: no host answer in time ⇒ deny, never allow.
          settle(requestId, 'deny', true);
        }, timeoutMs);
        // t59: stamp the owning harness session so the Desktop sidecar can
        // direct-route the ask instead of broadcasting it to every chat.
        const sessionId = getCurrentHarnessSessionId();
        pending.set(requestId, { resolve, timer, payload, sessionId });
        write(
          JSON.stringify({
            type: 'permission.request',
            requestId,
            ...(sessionId ? { sessionId } : {}),
            tool: payload.tool,
            category: payload.category,
            categories,
            ...(payload.inputPreview !== undefined ? { inputPreview: payload.inputPreview } : {}),
            ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
          }),
        );
      });
    },
    respond: (requestId, decision, scopeSessionId) => {
      const entry = pending.get(requestId);
      // t59 scoping: a scoped respond may only settle an ask raised in
      // THAT session (unscoped legacy asks included — a scoped answer to
      // an unscoped ask has no legitimate producer and is rejected).
      if (entry && scopeSessionId && entry.sessionId !== scopeSessionId) {
        return false;
      }
      return settle(requestId, decision, false);
    },
    sessionOf: (requestId) => pending.get(requestId)?.sessionId,
    releaseGranted() {
      let n = 0;
      for (const [id, entry] of [...pending]) {
        const cats = (
          entry.payload.categories && entry.payload.categories.length > 0
            ? entry.payload.categories
            : entry.payload.category
              ? entry.payload.category.split(',').map((c) => c.trim()).filter(Boolean)
              : []
        ) as ToolPermission[];
        if (isSessionGranted(entry.payload.tool, cats, entry.sessionId)) {
          if (settle(id, 'allow', false)) n += 1;
        }
      }
      return n;
    },
    pendingCount: () => pending.size,
  };
}

/**
 * Typed `permission.respond` method body for the serve dispatcher.
 * Shape-invalid params return `accepted:false` + reason; an unknown or
 * already-settled requestId returns `accepted:false` (idempotent no-op —
 * a late answer after a deny-timeout must never error the host).
 */
export function servePermissionRespond(
  bridge: ServePermissionBridge,
  params: unknown,
): { accepted: boolean; reason?: string } {
  if (!params || typeof params !== 'object') {
    return { accepted: false, reason: 'permission.respond requires an object params' };
  }
  const { requestId, decision, sessionId } = params as Record<string, unknown>;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return { accepted: false, reason: 'permission.respond requires a non-empty string requestId' };
  }
  if (!isPermissionDecision(decision)) {
    return {
      accepted: false,
      reason:
        "permission.respond decision must be 'allow' | 'deny' | 'always-tool' | 'always-category'",
    };
  }
  // t59: optional session scope — a host that knows which chat is
  // answering may only settle that chat's ask. An ask with NO session
  // (legacy CLI) rejects a scoped respond too: the only producer of a
  // scope is a host that registered the ask under a session, so a
  // scope-on-unscoped-ask is a bug or a spoofing attempt. Legacy hosts
  // (no id) keep the unscoped behavior on every ask.
  const scope = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
  if (scope && bridge.sessionOf(requestId) !== scope) {
    return { accepted: false, reason: 'session_mismatch: requestId belongs to another session' };
  }
  return { accepted: bridge.respond(requestId, decision, scope) };
}

/**
 * Adapt the wire bridge to the tool-registry ask handler contract
 * (`PermissionAskHandler`: resolves boolean allow). The registry payload
 * is richer than the wire payload — the adapter projects it (tool name,
 * categories, policy reason, resource-claim summaries as the preview) so
 * the host dialog shows WHAT the approval unlocks, not just a tool name.
 */
export function asRegistryAskHandler(bridge: ServePermissionBridge): PermissionAskHandler {
  return async (req) => {
    const reason =
      req.policyNote !== undefined ? `${req.reason} ${req.policyNote}`.trim() : req.reason;
    const decision = await bridge.onPermissionAsk({
      tool: req.toolName,
      category: req.categories.join(',') || 'other',
      categories: req.categories,
      reason,
      ...(req.claims && req.claims.length > 0
        ? { inputPreview: req.claims.map((c) => c.summary).join(' · ') }
        : {}),
    });
    if (decision === 'deny') return false;
    // t61: "always" grants land in the ASKING session's bucket, never the
    // process-global one — chat B must re-approve for its own workspace.
    const sessionId = getCurrentHarnessSessionId();
    if (decision === 'always-tool') {
      grantSessionTool(req.toolName, sessionId);
      bridge.releaseGranted();
    } else if (decision === 'always-category') {
      for (const cat of req.categories) {
        grantSessionCategory(cat as ToolPermission, sessionId);
      }
      grantSessionTool(req.toolName, sessionId);
      bridge.releaseGranted();
    }
    return true;
  };
}
