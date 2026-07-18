/**
 * Slash handlers for durable state (/state status|commit|show|restore).
 */
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';
import { getStateStore } from '../state/fileStateStore.js';
import { restoreDurableState } from '../state/restoreState.js';

export interface StateSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  cwd: string;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export async function handleStateStatus(ctx: StateSlashContext): Promise<void> {
  const store = await getStateStore(ctx.cwd);
  const head = await store.head();
  if (!head) {
    appendSystem(
      ctx.setMessages,
      '[state] no durable commits yet. Run a verified Zelari slice or `/state commit [label]`.\n' +
        '  Kill switch: ZELARI_STATE=0 disables the store.',
    );
    return;
  }
  const discoveries = await store.loadDiscoveries(head.id);
  const reusable = discoveries.filter((d) => d.reusable).length;
  const recent = await store.list(8);
  const lines = recent.map((c, i: number) => {
    const ver = c.verification.ran ? (c.verification.ok ? 'ok' : 'fail') : 'n/a';
    return (
      `  ${i === 0 ? '→' : ' '} ${c.id}  ${ago(c.createdAt)}  ${c.label}` +
      `  ver=${ver}` +
      (c.layer ? `  [${c.layer}]` : '') +
      (c.stablePromptHash ? `  hash=${c.stablePromptHash.slice(0, 8)}` : '')
    );
  });
  const ver = head.verification;
  appendSystem(
    ctx.setMessages,
    `[state] HEAD ${head.id} · mode ${head.mode}` +
      (head.layer ? ` · layer ${head.layer}` : '') +
      `\n  discoveries: ${head.discoveryCount} total, ${reusable} reusable` +
      `\n  verification: ran=${ver.ran} ok=${ver.ok}` +
      (ver.reportPath ? `  report=${ver.reportPath}` : '') +
      (head.parentId ? `\n  parent: ${head.parentId}` : '') +
      (head.workspaceCheckpointId
        ? `\n  workspaceCheckpoint: ${head.workspaceCheckpointId}`
        : '') +
      (head.stablePromptHash
        ? `\n  stablePromptHash: ${head.stablePromptHash}`
        : '') +
      `\n  created: ${ago(head.createdAt)}\n` +
      lines.join('\n'),
  );
}

export async function handleStateCommit(
  ctx: StateSlashContext,
  label?: string,
): Promise<void> {
  const store = await getStateStore(ctx.cwd);
  try {
    const meta = await store.commit({
      mode: 'agent',
      label: label?.trim() || 'manual state commit',
      layer: 'manual',
      verification: { ok: false, ran: false },
      force: true,
      discoveries: [
        {
          id: 'manual',
          kind: 'note',
          summary: label?.trim() || 'Manual durable state commit',
          reusable: true,
        },
      ],
    });
    appendSystem(
      ctx.setMessages,
      `[state] ✓ commit ${meta.id} (“${meta.label}”) — soft/manual (verification not required).`,
    );
  } catch (err) {
    appendSystem(
      ctx.setMessages,
      `[state] ✗ ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function handleStateShow(
  ctx: StateSlashContext,
  id?: string,
): Promise<void> {
  const store = await getStateStore(ctx.cwd);
  const meta = id ? await store.get(id) : await store.head();
  if (!meta) {
    appendSystem(
      ctx.setMessages,
      id
        ? `[state] commit ${id} not found.`
        : '[state] no HEAD — nothing to show.',
    );
    return;
  }
  const text = await store.materializeContext(meta.id, 6_000);
  appendSystem(ctx.setMessages, `[state] show ${meta.id}\n${text}`);
}

/**
 * Point HEAD at a commit and restore the linked git working-tree checkpoint
 * when present. Use `/state restore <id> --no-tree` to skip tree restore.
 */
export async function handleStateRestore(
  ctx: StateSlashContext,
  id?: string,
  opts?: { restoreTree?: boolean },
): Promise<void> {
  const res = await restoreDurableState({
    projectRoot: ctx.cwd,
    commitId: id,
    restoreTree: opts?.restoreTree !== false,
  });
  appendSystem(ctx.setMessages, res.message);
}
