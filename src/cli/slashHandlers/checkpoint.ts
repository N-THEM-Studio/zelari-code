import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from '../checkpoint/checkpointManager.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * Slash handlers for workspace checkpoints (/checkpoint, /rollback).
 * Thin wrappers over checkpointManager — all git plumbing lives there.
 */
export interface CheckpointSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /** Project root (git working tree). */
  cwd: string;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export async function handleCheckpointCreate(
  ctx: CheckpointSlashContext,
  label?: string,
): Promise<void> {
  const res = await createCheckpoint(ctx.cwd, label ?? 'manual checkpoint');
  if (res.ok) {
    appendSystem(
      ctx.setMessages,
      `[checkpoint] ✓ ${res.value.id} created${label ? ` (“${label}”)` : ''} — restore with \`/rollback ${res.value.id}\``,
    );
  } else {
    appendSystem(ctx.setMessages, `[checkpoint] ✗ ${res.error}`);
  }
}

export async function handleRollbackList(ctx: CheckpointSlashContext): Promise<void> {
  const list = await listCheckpoints(ctx.cwd);
  if (list.length === 0) {
    appendSystem(
      ctx.setMessages,
      '[rollback] no checkpoints yet. Create one with `/checkpoint [label]` (Zelari missions create one automatically).',
    );
    return;
  }
  const lines = list.map(
    (c, i) => `  ${i === 0 ? '→' : ' '} ${c.id}  ${ago(c.createdAt)}  ${c.label}`,
  );
  appendSystem(
    ctx.setMessages,
    `[rollback] ${list.length} checkpoint${list.length === 1 ? '' : 's'} (newest first):\n${lines.join('\n')}\n` +
      'Restore with `/rollback <id>` or `/rollback latest`.',
  );
}

export async function handleRollback(
  ctx: CheckpointSlashContext,
  id?: string,
): Promise<void> {
  const res = await restoreCheckpoint(ctx.cwd, id);
  if (res.ok) {
    const removed =
      res.value.deleted.length > 0
        ? ` (removed ${res.value.deleted.length} file${res.value.deleted.length === 1 ? '' : 's'} created after the checkpoint)`
        : '';
    appendSystem(
      ctx.setMessages,
      `[rollback] ✓ working tree restored to checkpoint ${res.value.id}${removed}.`,
    );
  } else {
    appendSystem(ctx.setMessages, `[rollback] ✗ ${res.error}`);
  }
}
