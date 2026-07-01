import { getWorkingDiff, undoWorkingChanges, isGitRepo, defaultProjectRoot } from '../gitOps.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * Slash command handlers — git ops (/diff, /undo).
 *
 * After v0.4.4 SRP cleanup, this file owns ONLY git working-tree concerns.
 * /compact, /update, /promote-member live in their own files (transcript.ts,
 * updater.ts, promoteMember.ts respectively).
 *
 * v0.4.4 (agy audit HIGH-2 fix): `messages` was inherited from the original
 * fat `SlashContext` but is not used by either /diff or /undo. Removed to
 * keep the type tight and stop callers from wiring up state the handlers
 * never read. `setInput` was likewise inherited but never used here
 * (input clearing is centralized in `useSlashDispatch`).
 */
export interface GitSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export async function handleDiff(ctx: GitSlashContext, diffStaged: boolean): Promise<void> {
  try {
    const repoRoot = defaultProjectRoot();
    if (!(await isGitRepo(repoRoot))) {
      appendSystem(ctx.setMessages, '[diff] not a git repository — nothing to show');
      return;
    }
    const { diff, truncated, empty } = await getWorkingDiff({ cwd: repoRoot, staged: diffStaged });
    const banner = empty
      ? `[diff] working tree clean${diffStaged ? ' (incl. staged)' : ''}`
      : `[diff]${diffStaged ? ' (staged + unstaged)' : ''} — ${truncated ? 'truncated to 50k chars' : 'full output follows'}`;
    const body = empty ? '' : `\n\n${diff}`;
    appendSystem(ctx.setMessages, `${banner}${body}`);
  } catch (err) {
    appendSystem(ctx.setMessages, `[diff error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleUndo(
  ctx: GitSlashContext,
  warningMessage: string | undefined,
  doConfirm: boolean,
): Promise<void> {
  if (warningMessage) {
    appendSystem(ctx.setMessages, warningMessage);
  }
  if (!doConfirm) return;
  try {
    const repoRoot = defaultProjectRoot();
    if (!(await isGitRepo(repoRoot))) {
      appendSystem(ctx.setMessages, '[undo] not a git repository — nothing to revert');
      return;
    }
    const res = await undoWorkingChanges({ cwd: repoRoot });
    appendSystem(
      ctx.setMessages,
      `[undo] ${res.summary}${res.reverted.length > 0 ? `\n  - ${res.reverted.slice(0, 10).join('\n  - ')}${res.reverted.length > 10 ? `\n  ... +${res.reverted.length - 10} more` : ''}` : ''}`,
    );
  } catch (err) {
    appendSystem(ctx.setMessages, `[undo error] ${err instanceof Error ? err.message : String(err)}`);
  }
}
