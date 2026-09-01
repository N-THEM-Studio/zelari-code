/**
 * spineLockSweep — boot-time janitor for orphaned session-spine writer locks.
 *
 * A crashed/killed host leaves `<sessionsDir>/<sessionId>/writer.lock` behind;
 * the next resume then hits SessionLogLockedError and silently degrades. At
 * sidecar boot every lock is evaluated with the SAME takeover policy the
 * writer itself uses (`evaluateLockTakeover` from @zelari/core/session):
 * dead pid, heartbeat-stale ts or the legacy >10 min staleness ⇒ the lock is
 * DELETED so the next resume acquires cleanly. A lock whose owner is alive
 * and heartbeating is kept untouched.
 *
 * Best-effort by contract: the sweep never throws — the sidecar boot must
 * never fail because of it. Visibility is one console.error per swept lock
 * (an NDJSON note channel is not yet constructed at runHarnessServer boot —
 * the transport `write` lives inside startHarnessServer).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  defaultLockLivenessProbe,
  evaluateLockTakeover,
  resolveHeartbeatStaleMs,
  resolveSessionsDir,
  type LockInfo,
} from '@zelari/core/session';

export interface SpineLockSweepOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Injectable liveness probe (tests). Defaults to signal-0 probe. */
  probe?: (pid: number) => boolean;
  /** Heartbeat-stale threshold override (defaults to the writer's env-aware default). */
  heartbeatStaleMs?: number;
  /** Sweep reporting sink (tests). Defaults to console.error. */
  onSwept?: (sessionId: string, reason: string) => void;
}

export interface SpineLockSweepResult {
  swept: number;
  kept: number;
  /** Entries skipped due to unexpected IO errors (best-effort). */
  errors: number;
}

/**
 * Evaluate every `<sessionsDir>/<sessionId>/writer.lock` and remove the
 * provably-orphaned ones. Never throws; a missing sessions dir is a no-op.
 */
export async function sweepOrphanSpineLocks(
  sessionsDir?: string,
  options: SpineLockSweepOptions = {},
): Promise<SpineLockSweepResult> {
  const dir = sessionsDir ?? resolveSessionsDir();
  const onSwept =
    options.onSwept ??
    ((sessionId: string, reason: string) => {
      console.error(
        `[zelari] spine-lock sweep: removed orphan writer.lock for session ${sessionId} (${reason})`,
      );
    });
  const now = options.now ?? Date.now;
  const probe = options.probe ?? defaultLockLivenessProbe;
  const result: SpineLockSweepResult = { swept: 0, kept: 0, errors: 0 };
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return result; // no sessions dir yet — nothing to sweep
  }
  for (const sessionId of entries) {
    const lockPath = path.join(dir, sessionId, 'writer.lock');
    try {
      const raw = await fs.readFile(lockPath, 'utf-8');
      let lockInfo: LockInfo = {};
      try {
        lockInfo = JSON.parse(raw) as LockInfo;
      } catch {
        // Corrupt lock: no pid/ts for the liveness policy — leave it to the
        // writer's legacy staleness rule rather than deleting blindly.
        result.kept += 1;
        continue;
      }
      const verdict = evaluateLockTakeover(lockInfo, {
        now: now(),
        probe,
        heartbeatStaleMs: options.heartbeatStaleMs ?? resolveHeartbeatStaleMs(),
      });
      if (!verdict.takeover) {
        result.kept += 1;
        continue;
      }
      await fs.rm(lockPath, { force: true });
      result.swept += 1;
      onSwept(sessionId, verdict.reason);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue; // no lock / plain file entry
      result.errors += 1;
    }
  }
  return result;
}
