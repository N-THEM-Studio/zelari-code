import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getWorkingDiff, undoWorkingChanges, isGitRepo, defaultProjectRoot } from '../gitOps.js';
import { compactTranscript, formatCompactionSummary } from '../compaction.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * Slash command handlers — git ops (/diff, /undo) and transcript ops (/compact).
 * Extracted from app.tsx (Task v0.4.2 audit split).
 */
export interface SlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setInput: (v: string) => void;
  messages: ChatMessage[];
}

export async function handleDiff(ctx: SlashContext, diffStaged: boolean): Promise<void> {
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
  ctx: SlashContext,
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

export function handleCompact(
  ctx: SlashContext,
  threshold: number | undefined,
  keepRecent: number | undefined,
): void {
  const opts: { threshold?: number; keepRecent?: number } = {};
  if (threshold !== undefined) opts.threshold = threshold;
  if (keepRecent !== undefined) opts.keepRecent = keepRecent;
  const r = compactTranscript(ctx.messages, opts);
  ctx.setMessages([...r.messages]);
  appendSystem(ctx.setMessages, formatCompactionSummary(r));
}

export async function handleUpdateCheck(ctx: SlashContext): Promise<void> {
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

export async function handleUpdatePerform(ctx: SlashContext): Promise<void> {
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

/**
 * Promote a council member to a standalone skill (v3-K).
 */
export async function handlePromoteMember(ctx: SlashContext, memberId: string): Promise<void> {
  try {
    const { promoteMember } = await import('../../agents/promoteMember.js');
    const { skill, markdown } = promoteMember(memberId);
    const skillDir = process.env.ANATHEMA_SKILL_DIR
      ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    const filePath = path.join(skillDir, `${skill.id}.md`);
    await fs.writeFile(filePath, markdown, 'utf8');
    appendSystem(
      ctx.setMessages,
      `[promote-member] ${skill.name} (${memberId}) → ${filePath}\n` +
        `  category:    ${skill.category}\n` +
        `  cost:        ${skill.estimatedCost}\n` +
        `  required:    ${skill.requiredRoles.join(', ') || '—'}\n` +
        `  tools:       ${skill.requiredTools.join(', ') || '—'}\n` +
        `  tags:        ${skill.tags.join(', ')}`,
    );
  } catch (err) {
    appendSystem(ctx.setMessages, `[promote-member error] ${err instanceof Error ? err.message : String(err)}`);
  }
}