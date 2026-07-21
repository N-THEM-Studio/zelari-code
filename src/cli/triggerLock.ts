/**
 * triggerLock — file-based lock for event-driven mission triggers (ADR-0014).
 *
 * Prevents two concurrent missions from running on the same repo. The lock
 * is a simple JSON file at `.zelari/trigger.lock` containing the PID of the
 * process that acquired it. On release (or SIGINT), the file is removed.
 *
 * Stale-lock recovery: if the PID in the lockfile is no longer alive
 * (`process.kill(pid, 0)` throws ESRCH), the lock is stolen with a warning.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface LockFile {
  pid: number;
  acquiredAt: string;
}

export interface LockResult {
  acquired: boolean;
  /** When `false`, the PID of the process that holds the lock. */
  heldBy?: number;
  /** Path to the lockfile. */
  lockPath: string;
}

/** Default lockfile path. */
export function lockPath(projectRoot: string): string {
  return path.join(projectRoot, '.zelari', 'trigger.lock');
}

/**
 * Check whether a PID is still alive without sending a signal.
 * Returns `false` if the process doesn't exist (ESRCH) or we lack
 * permission (EPERM is treated as alive — the process exists but is
 * owned by another user).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = process exists but we can't signal it → treat as alive
    return code === 'EPERM';
  }
}

/**
 * Attempt to acquire the trigger lock. If the lock exists and the holding
 * PID is still alive, returns `{ acquired: false }`. If the lock exists but
 * the PID is dead (stale), the lock is stolen.
 *
 * Does NOT install signal handlers — the caller is responsible for calling
 * {@link releaseLock} in a `finally` block or `SIGINT` handler.
 */
export async function acquireLock(
  projectRoot: string,
  now: () => Date = () => new Date(),
): Promise<LockResult> {
  const lp = lockPath(projectRoot);
  const dir = path.dirname(lp);
  await fs.mkdir(dir, { recursive: true });

  // Check for existing lock
  try {
    const raw = await fs.readFile(lp, 'utf8');
    const existing = JSON.parse(raw) as LockFile;
    if (existing.pid && isPidAlive(existing.pid)) {
      return { acquired: false, heldBy: existing.pid, lockPath: lp };
    }
    // Stale lock — fall through to overwrite
  } catch {
    // No existing lock (or corrupt) — proceed
  }

  // Write our lock
  const payload: LockFile = {
    pid: process.pid,
    acquiredAt: now().toISOString(),
  };
  await fs.writeFile(lp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { acquired: true, lockPath: lp };
}

/**
 * Release the lock by deleting the lockfile. Safe to call even if the lock
 * was never acquired or was already removed (idempotent).
 */
export async function releaseLock(projectRoot: string): Promise<void> {
  const lp = lockPath(projectRoot);
  try {
    await fs.unlink(lp);
  } catch {
    // already gone — fine
  }
}
