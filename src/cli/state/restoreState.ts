/**
 * Restore durable HEAD and optionally the linked git working-tree checkpoint.
 */

import type { DurableStateStore, StateCommitMeta } from '@zelari/core';
import { restoreCheckpoint } from '../checkpoint/checkpointManager.js';
import { getStateStore } from './fileStateStore.js';

export interface RestoreStateResult {
  ok: boolean;
  meta?: StateCommitMeta;
  treeRestored: boolean;
  checkpointId?: string;
  error?: string;
  message: string;
}

/**
 * Point HEAD at `id` (or HEAD if omitted) and restore the linked workspace
 * checkpoint when present and `restoreTree` is true (default).
 */
export async function restoreDurableState(opts: {
  projectRoot: string;
  commitId?: string;
  restoreTree?: boolean;
  store?: DurableStateStore;
}): Promise<RestoreStateResult> {
  const restoreTree = opts.restoreTree !== false;
  try {
    const store = opts.store ?? (await getStateStore(opts.projectRoot));
    let meta: StateCommitMeta | null;
    if (opts.commitId) {
      meta = await store.setHead(opts.commitId);
    } else {
      meta = await store.head();
      if (!meta) {
        return {
          ok: false,
          treeRestored: false,
          error: 'no HEAD',
          message: '[state] nothing to restore — no durable commits yet.',
        };
      }
    }

    let treeRestored = false;
    const checkpointId = meta.workspaceCheckpointId;
    if (restoreTree && checkpointId) {
      const res = await restoreCheckpoint(opts.projectRoot, checkpointId);
      if (res.ok) {
        treeRestored = true;
      } else {
        return {
          ok: true,
          meta,
          treeRestored: false,
          checkpointId,
          error: res.error,
          message:
            `[state] HEAD → ${meta.id} (“${meta.label}”), but tree restore failed: ${res.error}. ` +
            `Try \`/rollback ${checkpointId}\` manually.`,
        };
      }
    }

    const treeNote = treeRestored
      ? ` · working tree restored from checkpoint ${checkpointId}`
      : checkpointId
        ? ` · linked checkpoint ${checkpointId} (tree not restored)`
        : ' · no linked git checkpoint';

    return {
      ok: true,
      meta,
      treeRestored,
      checkpointId,
      message: `[state] restored HEAD → ${meta.id} (“${meta.label}”)${treeNote}`,
    };
  } catch (err) {
    return {
      ok: false,
      treeRestored: false,
      error: err instanceof Error ? err.message : String(err),
      message: `[state] restore failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
