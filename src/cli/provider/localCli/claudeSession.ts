/**
 * claudeSession — long Claude Code session for the local-CLI provider.
 *
 * `claude -p` exits after one prompt, so a single process cannot outlive a
 * harness turn. What must NOT happen is a fresh Claude conversation on every
 * harness re-entry (the tool loop replays the full transcript). The official
 * session id from `system/init` is kept per harness `conversationId` and
 * passed back as `--resume`. Claude's own tools stay inside that one `-p`
 * process; Zelari does not re-execute them.
 *
 * The id is not a credential. Subscription auth stays in the official binary.
 */
import type { AgentMessage } from '@zelari/core/harness';
import type { WorkPhase } from '../../phase.js';

export const CLAUDE_PRINT_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
] as const;

/** plan → Claude's plan permission mode; build → acceptEdits (not bypass). */
export function claudePermissionMode(phase: WorkPhase): 'plan' | 'acceptEdits' {
  return phase === 'plan' ? 'plan' : 'acceptEdits';
}

export function buildClaudeLaunchArgs(input: {
  model?: string;
  permissionSocketPath?: string;
  phase: WorkPhase;
  resumeSessionId?: string | null;
}): string[] {
  const args: string[] = [
    ...CLAUDE_PRINT_ARGS,
    '--permission-mode',
    claudePermissionMode(input.phase),
  ];
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  if (input.model) args.push('--model', input.model);
  if (input.permissionSocketPath) {
    args.push(
      '--permission-prompt-tool',
      `zelari-code --permission-mcp ${input.permissionSocketPath}`,
    );
  }
  return args;
}

export interface ClaudeCodeSessionRecord {
  /** Official CLI session id. Not the spine session id, and not a token. */
  claudeSessionId: string;
  /** Harness messages already accepted by that CLI session. */
  sentMessageCount: number;
}

const sessions = new Map<string, ClaudeCodeSessionRecord>();

export function peekClaudeCodeSession(
  conversationId: string,
): ClaudeCodeSessionRecord | undefined {
  return sessions.get(conversationId);
}

export function rememberClaudeCodeSession(
  conversationId: string,
  record: ClaudeCodeSessionRecord,
): void {
  if (!conversationId || !record.claudeSessionId) return;
  sessions.set(conversationId, {
    claudeSessionId: record.claudeSessionId,
    sentMessageCount: record.sentMessageCount,
  });
}

export function endClaudeCodeSession(conversationId: string): void {
  sessions.delete(conversationId);
}

export function resetClaudeCodeSessionsForTests(): void {
  sessions.clear();
}

function lastUserOrTool(messages: readonly AgentMessage[]): AgentMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && (message.role === 'user' || message.role === 'tool')) return [message];
  }
  return [...messages];
}

/**
 * First turn sends the full transcript (including system). Later turns send
 * only new user/tool messages so a resumed CLI session is not replayed.
 * A retry that does not grow the transcript re-sends the last user/tool turn.
 */
export function messagesForClaudeTurn(
  messages: readonly AgentMessage[],
  alreadySent: number,
): AgentMessage[] {
  if (alreadySent <= 0 || messages.length === 0) return [...messages];
  const fresh = messages.slice(Math.min(alreadySent, messages.length));
  const input = fresh.filter((message) => message.role === 'user' || message.role === 'tool');
  if (input.length > 0) return input;
  return lastUserOrTool(messages);
}
