/**
 * headlessSpine — attach the 2.0 session spine to a headless run.
 *
 * Dual-write is best-effort (same degrade-and-stop as the TUI mirror).
 * Profile is recorded on `session.started` so same-task / same-profile
 * harness deltas stay comparable (ADR-0022). Interrupt (SIGINT / abort)
 * releases the lock WITHOUT `session.ended` so deriveMissionState can
 * project `interrupted: true` and resume can continue the seq.
 */
import type { BrainEvent } from '@zelari/core/events';
import {
  exportSessionJson,
  SessionStore,
  resolveSessionsDir,
} from '@zelari/core/session';
import { deriveMissionState } from '@zelari/core/mission';
import { resolveProfile, toolManifestHash } from '@zelari/core/runtime';
import { SessionSpineMirror, type SpineMirrorOptions } from './sessionSpine.js';
import { defaultProfileForMode, type HeadlessMode } from './headless.js';

export interface HeadlessSpineHandle {
  sessionId: string;
  profileId: string;
  spine: SessionSpineMirror;
  /** Mirror a BrainEvent onto the spine (no-op when degraded/disabled). */
  observe(ev: unknown): void;
  userMessage(text: string): void;
  verificationRun(payload: Record<string, unknown>): void;
  missionPhase(phase: string, note?: string): void;
  note(text: string, data?: Record<string, unknown>): void;
  /** Clean end: append session.ended + release lock. */
  close(reason?: string): Promise<void>;
  /** Interrupt: release lock WITHOUT session.ended (resumable). */
  interrupt(note?: string): Promise<void>;
  /** Portable JSON export of the spine (empty string when no log). */
  exportJson(): Promise<string | null>;
}

export function resolveHeadlessProfileId(
  mode: HeadlessMode | undefined,
  explicit?: string,
): string {
  if (explicit) return resolveProfile(explicit).id;
  return defaultProfileForMode(mode ?? 'kraken');
}

export async function openHeadlessSpine(opts: {
  sessionId: string;
  mode?: HeadlessMode;
  profile?: string;
  workspace?: string;
  baseDir?: string;
  quiet?: boolean;
}): Promise<HeadlessSpineHandle> {
  const profileId = resolveHeadlessProfileId(opts.mode, opts.profile);
  let profileTools: readonly string[] = [];
  try {
    profileTools = resolveProfile(profileId).tools;
  } catch {
    profileTools = [];
  }
  const extra: Record<string, unknown> = {
    profile: profileId,
    workspace: opts.workspace ?? process.cwd(),
    toolManifestHash: profileTools.length > 0 ? toolManifestHash(profileTools) : undefined,
  };
  const mirrorOpts: SpineMirrorOptions = {
    baseDir: opts.baseDir,
    quiet: opts.quiet,
    extraStarted: extra,
  };
  const spine = await SessionSpineMirror.adopt(opts.sessionId, mirrorOpts);
  if (spine.status === 'active') {
    spine.note('headless.profile', { profile: profileId, mode: opts.mode ?? 'kraken' });
  }

  return {
    sessionId: opts.sessionId,
    profileId,
    spine,
    observe(ev: unknown): void {
      if (ev && typeof ev === 'object' && 'type' in ev) {
        spine.mirrorBrainEvent(ev as BrainEvent);
      }
    },
    userMessage(text: string): void {
      spine.userMessage(text);
    },
    verificationRun(payload: Record<string, unknown>): void {
      spine.verificationRun(payload);
    },
    missionPhase(phase: string, note?: string): void {
      spine.missionPhase(phase, note);
    },
    note(text: string, data?: Record<string, unknown>): void {
      spine.note(text, data);
    },
    async close(reason = 'host-exit'): Promise<void> {
      await spine.close(reason);
    },
    async interrupt(note?: string): Promise<void> {
      if (note) spine.note('headless.interrupt', { note });
      await spine.release();
    },
    async exportJson(): Promise<string | null> {
      try {
        const store = new SessionStore(resolveSessionsDir({ baseDir: opts.baseDir }));
        if (!(await store.exists(opts.sessionId))) return null;
        return await exportSessionJson(store, opts.sessionId);
      } catch {
        return null;
      }
    },
  };
}

/** One-shot portable export for `--session-export <id>` (no live writer). */
export async function exportSessionById(
  sessionId: string,
  baseDir?: string,
): Promise<{ ok: true; json: string } | { ok: false; error: string }> {
  try {
    const store = SessionStore.withDefaults(baseDir ? { baseDir } : {});
    if (!(await store.exists(sessionId))) {
      return { ok: false, error: `session not found: ${sessionId}` };
    }
    return { ok: true, json: await exportSessionJson(store, sessionId) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Project mission state from a stored spine (resume / inspect). */
export async function missionStateFromSpine(
  sessionId: string,
  baseDir?: string,
): Promise<ReturnType<typeof deriveMissionState> | null> {
  try {
    const store = SessionStore.withDefaults(baseDir ? { baseDir } : {});
    if (!(await store.exists(sessionId))) return null;
    const projection = await store.projection(sessionId);
    return deriveMissionState(projection);
  } catch {
    return null;
  }
}
