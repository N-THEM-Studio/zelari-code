import {
  createBranch,
  listBranches,
  branchExists as checkBranchExists,
  setCurrentBranch,
  getCurrentBranch,
} from '../branchManager.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * Slash command handlers — branch operations (/branch, /branches, /checkout).
 * Extracted from app.tsx (Task v0.4.2 audit split).
 */
export interface BranchSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setInput: (v: string) => void;
  sessionId: string;
}

export async function handleBranchCreate(ctx: BranchSlashContext, branchName: string): Promise<void> {
  if (!ctx.sessionId) {
    appendSystem(ctx.setMessages, '[branch] no active session — wait for bootstrap or run a prompt first');
    return;
  }
  try {
    const info = await createBranch(branchName, ctx.sessionId);
    setCurrentBranch(info.name);
    appendSystem(
      ctx.setMessages,
      `[branch] created "${info.name}" from session ${info.fromSessionId.slice(0, 8)}… (${info.sessionCount} session file copied)`,
    );
  } catch (err) {
    appendSystem(ctx.setMessages, `[branch error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleBranchList(ctx: BranchSlashContext): Promise<void> {
  try {
    const list = await listBranches();
    if (list.length === 0) {
      appendSystem(ctx.setMessages, '[branches] no branches yet — use /branch <name> to create one');
      return;
    }
    const currentBranch = getCurrentBranch();
    const lines = list.slice(0, 10).map((b) => {
      const dt = new Date(b.createdAt).toISOString().replace('T', ' ').slice(0, 16);
      const marker = currentBranch === b.name ? ' *' : '  ';
      return ` ${marker}${b.name.padEnd(20)} from ${b.fromSessionId.slice(0, 8)}…  ${b.sessionCount} sessions  ${dt}`;
    });
    appendSystem(ctx.setMessages, `[branches] ${list.length} total (* = active):\n${lines.join('\n')}`);
  } catch (err) {
    appendSystem(ctx.setMessages, `[branches error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleBranchCheckout(ctx: BranchSlashContext, branchName: string): Promise<void> {
  try {
    if (!checkBranchExists(branchName)) {
      throw new Error(`Branch "${branchName}" does not exist. Use /branches to list.`);
    }
    setCurrentBranch(branchName);
    appendSystem(
      ctx.setMessages,
      `[checkout] active branch set to "${branchName}". Restart zelari-code to load it.`,
    );
  } catch (err) {
    appendSystem(ctx.setMessages, `[checkout error] ${err instanceof Error ? err.message : String(err)}`);
  }
}