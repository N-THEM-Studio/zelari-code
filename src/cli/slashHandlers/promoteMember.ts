import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendSystem } from '../hooks/messageHelpers.js';
import { skillsDir } from '../paths.js';
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
    const skillDir = skillsDir();
    await fs.mkdir(skillDir, { recursive: true });
    const filePath = path.join(skillDir, `${skill.id}.md`);
    // ADR-0036 lineage: every promoted skill records its content hash chain.
    // Rendered as a trailing HTML comment (NOT frontmatter) so the tolerant
    // skill parser never has to understand lineage keys (P5: stable format).
    const previous = await fs.readFile(filePath, 'utf8').catch(() => null);
    const { createHash } = await import('node:crypto');
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    const lineage =
      `<!-- lineage: genome=sha256:${sha(markdown)}` +
      ` parent=${previous ? `sha256:${sha(previous)}` : 'none'}` +
      ` promotedBy=user promotedAt=${new Date().toISOString()} -->`;
    await fs.writeFile(filePath, `${markdown}\n${lineage}\n`, 'utf8');
    appendSystem(
      ctx.setMessages,
      `[promote-member] ${skill.name} (${memberId}) → ${filePath}\n` +
        `  category:    ${skill.category}\n` +
        `  cost:        ${skill.estimatedCost}\n` +
        `  required:    ${skill.requiredRoles.join(', ') || '—'}\n` +
        `  tools:       ${skill.requiredTools.join(', ') || '—'}\n` +
        `  tags:        ${skill.tags.join(', ') || '—'}\n` +
        `  lineage:     ${previous ? 'genome+parent (sha256)' : 'genome (sha256, first promote)'}`,
    );
  } catch (err) {
    appendSystem(ctx.setMessages, `[promote-member error] ${err instanceof Error ? err.message : String(err)}`);
  }
}
