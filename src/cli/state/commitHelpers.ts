/**
 * Shared helpers for durable state commits from mission / council paths.
 * Fail-open: never throws to callers of tryCommit* helpers.
 */

import type { Discovery, DurableStateStore, StateCommitMeta, StateCommitMode } from '@zelari/core';
import { createCheckpoint } from '../checkpoint/checkpointManager.js';
import { getStateStore } from './fileStateStore.js';

export interface TryCommitArgs {
  projectRoot: string;
  mode: StateCommitMode;
  label: string;
  layer?: string;
  sessionId?: string;
  verification: { ok: boolean; ran: boolean };
  /** Soft-commit when verification is not fully green (progress layers). */
  force?: boolean;
  discoveries?: Discovery[];
  changedPaths?: string[];
  /** When true, also create a git workspace checkpoint and link it. */
  withCheckpoint?: boolean;
  store?: DurableStateStore;
  env?: NodeJS.ProcessEnv;
}

export interface TryCommitResult {
  ok: boolean;
  meta?: StateCommitMeta;
  error?: string;
  checkpointId?: string;
}

/**
 * Best-effort durable state commit. Returns ok:false on refuse/I/O — never throws.
 */
export async function tryStateCommit(args: TryCommitArgs): Promise<TryCommitResult> {
  try {
    const store = args.store ?? (await getStateStore(args.projectRoot, args.env));
    let workspaceCheckpointId: string | undefined;
    if (args.withCheckpoint && (args.env ?? process.env).ZELARI_CHECKPOINT !== '0') {
      const cp = await createCheckpoint(
        args.projectRoot,
        `state ${args.layer ?? args.label}`.slice(0, 80),
      );
      if (cp.ok) workspaceCheckpointId = cp.value.id;
    }
    const meta = await store.commit({
      mode: args.mode,
      label: args.label,
      layer: args.layer,
      sessionId: args.sessionId,
      workspaceCheckpointId,
      verification: args.verification,
      changedPaths: args.changedPaths,
      discoveries: args.discoveries,
      force: args.force,
    });
    if (!meta.id) return { ok: false, error: 'noop store', checkpointId: workspaceCheckpointId };
    return { ok: true, meta, checkpointId: workspaceCheckpointId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build standard discoveries from a slice/council outcome. */
export function discoveriesFromOutcome(opts: {
  stepId: string;
  synthesis?: string;
  writeCount?: number;
  note?: string;
}): Discovery[] {
  const out: Discovery[] = [];
  if (opts.note || opts.synthesis) {
    out.push({
      id: `note-${opts.stepId}`,
      kind: 'note',
      summary: (opts.note || opts.synthesis || '').slice(0, 400),
      reusable: true,
    });
  }
  if (typeof opts.writeCount === 'number' && opts.writeCount > 0) {
    out.push({
      id: `writes-${opts.stepId}`,
      kind: 'file_change',
      summary: `${opts.writeCount} project file write(s)`,
      reusable: true,
    });
  }
  return out;
}
