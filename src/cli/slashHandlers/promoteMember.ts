import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * Slash command handler — promote a council member to a standalone skill (/promote-member).
 * Extracted from `git.ts` (v0.4.4 audit) — the file's name was misleading.
 * This file owns the "export a council role to a portable skill markdown" concern.
 *
 * v0.4.4 (agy audit MEDIUM-1 fix): `setInput` removed — input clearing is
 * centralized in `useSlashDispatch` and this handler never reads it.
 */
export interface PromoteMemberSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export async function handlePromoteMember(ctx: PromoteMemberSlashContext, memberId: string): Promise<void> {
  try {
    const { promoteMember } = await import('@zelari/core/council');
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
