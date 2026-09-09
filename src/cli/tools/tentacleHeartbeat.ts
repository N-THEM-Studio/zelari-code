/**
 * NDJSON heartbeats while a tentacle is blocked on the model.
 *
 * Desktop's sidecar idle watchdog (`TURN_IDLE_TIMEOUT`, default 10 min) treats
 * "no NDJSON for this run" as a hung CLI and sends session.cancel. Tentacle
 * thinking_delta is NOT forwarded to the parent stream, and GLM/Grok can sit
 * silent for minutes before the first tool. Without a beat, a live tentacle
 * looks dead and the lead is aborted with no assistant message.
 *
 * Override: ZELARI_TENTACLE_HEARTBEAT_MS (0/off disables).
 */

export const TENTACLE_HEARTBEAT_DEFAULT_MS = 15_000;

export function resolveTentacleHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_TENTACLE_HEARTBEAT_MS?.trim();
  if (raw === '0' || raw === 'off') return 0;
  if (!raw) return TENTACLE_HEARTBEAT_DEFAULT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : TENTACLE_HEARTBEAT_DEFAULT_MS;
}

export function formatTentacleElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function tentacleHeartbeatCaption(elapsedMs: number): string {
  return `reasoning · ${formatTentacleElapsed(elapsedMs)}`;
}

/**
 * Fire `onBeat` every interval until the returned stop fn runs.
 * The timer is unref'd so it cannot keep a process alive.
 */
export function startTentacleHeartbeat(
  onBeat: (caption: string) => void,
  opts?: { intervalMs?: number; now?: () => number },
): () => void {
  const intervalMs = opts?.intervalMs ?? resolveTentacleHeartbeatMs();
  if (intervalMs <= 0) return () => { /* disabled */ };
  const now = opts?.now ?? Date.now;
  const started = now();
  const timer = setInterval(() => {
    onBeat(tentacleHeartbeatCaption(now() - started));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
