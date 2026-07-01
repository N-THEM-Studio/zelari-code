import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * Slash command handlers — workspace inspection (.zelari/ + AGENTS.MD).
 * Extracted from app.tsx (Task v0.4.2 audit split).
 */
export interface WorkspaceSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setInput: (v: string) => void;
}

export async function handleWorkspaceShow(
  ctx: WorkspaceSlashContext,
  what: 'plan' | 'decisions' | 'risks' | 'agents' | 'docs',
): Promise<void> {
  try {
    const zelari = path.join(process.cwd(), '.zelari');
    let content: string;
    switch (what) {
      case 'plan': {
        const planPath = path.join(zelari, 'plan.md');
        try {
          content = await fs.readFile(planPath, 'utf-8');
        } catch {
          content = '(no plan.md yet — run a council session first)';
        }
        break;
      }
      case 'decisions': {
        const decisionsDir = path.join(zelari, 'decisions');
        try {
          const files = (await fs.readdir(decisionsDir))
            .filter((f) => f.endsWith('.md'))
            .sort();
          if (files.length === 0) {
            content = '(no ADRs yet — invoke /council to generate some)';
          } else {
            const lines: string[] = [`# Decisions (${files.length})\n`];
            const { parseFrontmatter } = await import('../workspace/storage.js');
            for (const f of files) {
              const raw = await fs.readFile(path.join(decisionsDir, f), 'utf-8');
              const { meta, body } = parseFrontmatter<{ title?: string; status?: string }>(raw);
              const title = meta.title ?? body.split('\n')[0]?.replace(/^#\s*/, '').trim() ?? f;
              lines.push(`- **${f.replace(/\.md$/, '')}** [${meta.status ?? 'unknown'}] ${title}`);
            }
            content = lines.join('\n');
          }
        } catch {
          content = '(no .zelari/decisions/ yet)';
        }
        break;
      }
      case 'risks': {
        const risksPath = path.join(zelari, 'risks.md');
        try {
          content = await fs.readFile(risksPath, 'utf-8');
        } catch {
          content = '(no risks.md yet)';
        }
        break;
      }
      case 'agents': {
        const agentsPath = path.join(process.cwd(), 'AGENTS.MD');
        try {
          content = await fs.readFile(agentsPath, 'utf-8');
        } catch {
          content = '(no AGENTS.MD yet at project root — run `/workspace sync` after a council session)';
        }
        break;
      }
      case 'docs': {
        const docsDir = path.join(zelari, 'docs');
        try {
          const files = (await fs.readdir(docsDir)).filter((f) => f.endsWith('.md')).sort();
          content = files.length
            ? `# Docs (${files.length})\n\n` + files.map((f) => `- ${f}`).join('\n')
            : '(no docs drafts yet)';
        } catch {
          content = '(no .zelari/docs/ yet)';
        }
        break;
      }
      default:
        content = `Unknown artifact: ${what}`;
    }
    appendSystem(ctx.setMessages, `[workspace: ${what}]\n\n${content}`);
  } catch (err) {
    appendSystem(ctx.setMessages, `[workspace error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleWorkspaceSync(ctx: WorkspaceSlashContext): Promise<void> {
  try {
    const { createWorkspaceContext } = await import('../workspace/stubs.js');
    const { updateAgentsMd } = await import('../workspace/agentsMd.js');
    const wsCtx = createWorkspaceContext(process.cwd());
    const out = await updateAgentsMd(wsCtx, process.cwd());
    const msg = out.changed
      ? `[workspace] AGENTS.MD updated (${out.sections.join(', ') || 'no auto-sections changed'})`
      : out.reason
        ? `[workspace] AGENTS.MD not modified — ${out.reason}`
        : '[workspace] AGENTS.MD already up to date (no changes)';
    appendSystem(ctx.setMessages, msg);
  } catch (err) {
    appendSystem(ctx.setMessages, `[workspace sync error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleWorkspaceReset(ctx: WorkspaceSlashContext, force: boolean): Promise<void> {
  if (!force) {
    appendSystem(
      ctx.setMessages,
      '⚠ /workspace reset is DESTRUCTIVE. Use /workspace reset --yes to confirm.',
    );
    return;
  }
  try {
    const target = path.join(process.cwd(), '.zelari');
    await fs.rm(target, { recursive: true, force: true });
    appendSystem(ctx.setMessages, '[workspace] .zelari/ removed');
  } catch (err) {
    appendSystem(ctx.setMessages, `[workspace reset error] ${err instanceof Error ? err.message : String(err)}`);
  }
}