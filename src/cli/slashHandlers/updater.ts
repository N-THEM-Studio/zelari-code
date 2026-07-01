import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * Slash command handlers — self-update operations (/update).
 * Extracted from `git.ts` (v0.4.4 audit) — the file's name was misleading.
 * This file owns the "update zelari-code itself" concern: it lazily imports
 * the updater module (which spawns `npm install -g`) to keep cold-start
 * time minimal for users who never run /update.
 *
 * v0.4.4 (agy audit MEDIUM-1 fix): `setInput` removed — input clearing is
 * centralized in `useSlashDispatch` and the update handlers never read it.
 */
export interface UpdaterSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export async function handleUpdateCheck(ctx: UpdaterSlashContext): Promise<void> {
  try {
    const { checkForUpdate } = await import('../updater.js');
    const info = await checkForUpdate();
    if (info.error) {
      appendSystem(ctx.setMessages, `[update] check failed: ${info.error}`);
    } else if (info.updateAvailable) {
      appendSystem(
        ctx.setMessages,
        `[update] 🆕 zelari-code ${info.latestVersion} available (current: ${info.currentVersion})\n` +
          `       Run \`/update --yes\` to install. You'll need to restart manually after.`,
      );
    } else {
      appendSystem(ctx.setMessages, `[update] up to date (${info.currentVersion})`);
    }
  } catch (err) {
    appendSystem(ctx.setMessages, `[update error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleUpdatePerform(ctx: UpdaterSlashContext): Promise<void> {
  appendSystem(ctx.setMessages, '[update] running `npm install -g zelari-code@latest`...');
  try {
    const { performUpdate } = await import('../updater.js');
    const res = await performUpdate();
    if (res.ok) {
      appendSystem(
        ctx.setMessages,
        `[update] ✅ installed successfully\n\n` +
          `Please restart zelari-code manually to use the new version.\n` +
          `(exit with /exit or Ctrl+C, then run \`zelari-code\` again)`,
      );
    } else {
      appendSystem(
        ctx.setMessages,
        `[update] ❌ failed: ${res.error ?? 'unknown error'}\n\n` +
          `npm output:\n${res.output || '(empty)'}`,
      );
    }
  } catch (err) {
    appendSystem(ctx.setMessages, `[update error] ${err instanceof Error ? err.message : String(err)}`);
  }
}
