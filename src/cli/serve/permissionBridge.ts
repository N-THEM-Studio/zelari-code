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
 *                 "params":{"requestId":…,"decision":"allow"|"deny"}}
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
  inputPreview?: string;
  reason?: string;
}

export type PermissionDecision = 'allow' | 'deny';

interface PendingAsk {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ServePermissionBridge {
  /** Registry-compatible ask handler: emits a request event and waits. */
  onPermissionAsk: (payload: PermissionAskPayload) => Promise<PermissionDecision>;
  /** Resolve a pending request (idempotent: unknown ids are a no-op). */
  respond: (requestId: string, decision: PermissionDecision) => boolean;
  /** How many requests are awaiting a host answer (observability/tests). */
  pendingCount: () => number;
}

export function createServePermissionBridge(
  write: (line: string) => void,
  timeoutMs = 120_000,
): ServePermissionBridge {
  const pending = new Map<string, PendingAsk>();
  let seq = 0;

  const settle = (requestId: string, decision: PermissionDecision): boolean => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(decision);
    return true;
  };

  return {
    onPermissionAsk(payload) {
      const requestId = `perm-${Date.now()}-${++seq}`;
      return new Promise<PermissionDecision>((resolve) => {
        const timer = setTimeout(() => {
          // Fail-closed: no host answer in time ⇒ deny, never allow.
          settle(requestId, 'deny');
        }, timeoutMs);
        pending.set(requestId, { resolve, timer });
        write(
          JSON.stringify({
            type: 'permission.request',
            requestId,
            tool: payload.tool,
            category: payload.category,
            ...(payload.inputPreview !== undefined ? { inputPreview: payload.inputPreview } : {}),
            ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
          }),
        );
      });
    },
    respond: settle,
    pendingCount: () => pending.size,
  };
}

/**
 * Typed `permission.respond` method body for the serve dispatcher
 * (wired in the follow-up slice; exported + unit-tested now so the
 * protocol contract is pinned before any host depends on it).
 */
export function servePermissionRespond(
  bridge: ServePermissionBridge,
  params: unknown,
): { accepted: boolean; reason?: string } {
  if (!params || typeof params !== 'object') {
    return { accepted: false, reason: 'permission.respond requires an object params' };
  }
  const { requestId, decision } = params as Record<string, unknown>;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return { accepted: false, reason: 'permission.respond requires a non-empty string requestId' };
  }
  if (decision !== 'allow' && decision !== 'deny') {
    return { accepted: false, reason: "permission.respond decision must be 'allow' or 'deny'" };
  }
  return { accepted: bridge.respond(requestId, decision) };
}
