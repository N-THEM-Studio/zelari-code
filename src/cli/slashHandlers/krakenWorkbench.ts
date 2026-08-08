/**
 * Kraken workbench slash handler — `/kraken workbench` (F3.2 TUI viewer).
 *
 * Reads the most recent `.zelari/radio/workbench-*.md` file and prints it
 * to the transcript via the `parseWorkbench` / `formatWorkbenchForTerminal`
 * pair. A full TUI live panel (a la Claude Code's `/workflows`) is a
 * follow-up; this command is the simplest viable "I can see what's
 * happening" affordance.
 *
 * @since Kraken v1.30.x — workflow script runtime (Pillar 3 F3.2)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';
import { parseWorkbench, formatWorkbenchForTerminal } from '../kraken/workbenchView.js';

export interface KrakenWorkbenchSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  cwd: string;
}

export async function handleKrakenWorkbench(ctx: KrakenWorkbenchSlashContext): Promise<void> {
  const dir = path.join(ctx.cwd, '.zelari', 'radio');
  let latest: string | null = null;
  let latestMtime = 0;
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (!f.startsWith('workbench-') || !f.endsWith('.md')) continue;
      const full = path.join(dir, f);
      const stat = await fs.stat(full);
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latest = full;
      }
    }
  } catch {
    // No .zelari/radio dir yet.
  }
  if (!latest) {
    appendSystem(ctx.setMessages, '[kraken workbench] no workbench file found (.zelari/radio/workbench-*.md)');
    return;
  }
  const content = await fs.readFile(latest, 'utf8');
  const parsed = parseWorkbench(content);
  const rendered = formatWorkbenchForTerminal(parsed);
  if (!rendered.trim()) {
    appendSystem(ctx.setMessages, `[kraken workbench] ${path.basename(latest)}: (no nodes / no events yet)`);
    return;
  }
  appendSystem(ctx.setMessages, `[kraken workbench] ${path.basename(latest)}:\n${rendered}`);
}
