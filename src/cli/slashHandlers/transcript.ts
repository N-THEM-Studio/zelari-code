import { compactTranscript, formatCompactionSummary } from '../compaction.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * Slash command handlers — transcript operations (/compact).
 * Extracted from `git.ts` (v0.4.4 audit) — the file's name was misleading
 * because it also handled /compact, /update, /promote-member. This file owns
 * the "transcript shape" concerns: compaction of in-memory messages.
 *
 * v0.4.4 (agy audit MEDIUM-1 fix): `setInput` removed — input clearing is
 * centralized in `useSlashDispatch` and none of the handlers here need it.
 */
export interface TranscriptSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  messages: ChatMessage[];
}

export function handleCompact(
  ctx: TranscriptSlashContext,
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
