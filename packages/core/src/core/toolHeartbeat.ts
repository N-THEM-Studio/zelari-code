/**
 * Anti-stall heartbeat for long-running tool calls in the main agent loop.
 *
 * When a tool call exceeds a configurable threshold (default 30 s), a single
 * heartbeat event fires so the model / Desktop sidecar knows the call is still
 * alive — mirroring the tentacle heartbeat (`tentacleHeartbeat.ts`) which
 * covers model-wait stalls instead.
 *
 * One-shot per call: the timer fires at most once per `start()` invocation.
 * The caller is expected to `stop()` when the tool finishes (cleanup only —
 * the timer already fired or was cancelled).
 *
 * Override: ZELARI_TOOL_HEARTBEAT_MS (0/off disables; default 30 000).
 *
 * @see .zelari/docs/2026-09-21-piano-roi-steal-unreal-agent.md §A3
 */

export const TOOL_HEARTBEAT_DEFAULT_MS = 30_000;

export function resolveToolHeartbeatMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ZELARI_TOOL_HEARTBEAT_MS?.trim();
  if (raw === '0' || raw === 'off') return 0;
  if (!raw) return TOOL_HEARTBEAT_DEFAULT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : TOOL_HEARTBEAT_DEFAULT_MS;
}

export function formatToolElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function toolHeartbeatCaption(
  toolName: string,
  elapsedMs: number,
): string {
  return `${toolName} running · ${formatToolElapsed(elapsedMs)}`;
}

export interface ToolHeartbeat {
  /** Register a tool call; returns a stop fn to cancel/ cleanup. */
  start(toolCallId: string, toolName: string): () => void;
  /** Resolved threshold (0 = disabled). */
  readonly thresholdMs: number;
}

export interface ToolHeartbeatOpts {
  /** Override the env-resolved threshold (ms). 0 disables. */
  thresholdMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable setTimeout for deterministic tests. */
  setTimeout?: typeof globalThis.setTimeout;
  /** Injectable clearTimeout for deterministic tests. */
  clearTimeout?: typeof globalThis.clearTimeout;
}

/**
 * Create a per-call heartbeat tracker.
 *
 * `onBeat(toolCallId, toolName, elapsedMs)` fires once per call that exceeds
 * the threshold. The returned object's `start()` method begins tracking; the
 * returned stop fn clears the timer (call it when the tool finishes).
 */
export function createToolHeartbeat(
  onBeat: (
    toolCallId: string,
    toolName: string,
    elapsedMs: number,
  ) => void,
  opts?: ToolHeartbeatOpts,
): ToolHeartbeat {
  const thresholdMs =
    opts?.thresholdMs ?? resolveToolHeartbeatMs();
  if (thresholdMs <= 0) {
    return {
      start: () => () => {
        /* disabled */
      },
      thresholdMs: 0,
    };
  }
  const now = opts?.now ?? Date.now;
  const setTimer = opts?.setTimeout ?? globalThis.setTimeout;
  const clearTimer = opts?.clearTimeout ?? globalThis.clearTimeout;

  return {
    thresholdMs,
    start(toolCallId: string, toolName: string): () => void {
      const startTime = now();
      let fired = false;
      const timer = setTimer(() => {
        fired = true;
        onBeat(toolCallId, toolName, now() - startTime);
      }, thresholdMs);
      (timer as { unref?: () => void }).unref?.();
      return () => {
        if (!fired) clearTimer(timer as unknown as ReturnType<typeof setTimeout>);
      };
    },
  };
}
