import React from 'react';
import { Box, Text } from 'ink';
import { CollapsibleToolOutput } from './CollapsibleToolOutput.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  ts: number;
  /** Tool invocation metadata (only when role === 'tool'). */
  toolName?: string;
  /** Tool call id matching BrainToolExecutionStartEvent.toolCallId (role === 'tool'). */
  toolCallId?: string;
  toolOk?: boolean;
  toolDurationMs?: number;
  /**
   * Tool result body (truncated), shown by CollapsibleToolOutput when the
   * invocation is expanded (errors auto-expand). Kept separate from
   * `content` so the collapsed summary stays a stable one-liner.
   *
   * @since 0.6.2
   */
  toolResult?: string;
  /**
   * Council member name that produced this message (e.g. "Caronte",
   * "Nettuno", "Minosse"). Populated only for council-sourced
   * assistant messages so the visible-reasoning UI can render
   * `🜂 Caronte: …` headers above the streamed text. Omitted for
   * direct user prompts.
   *
   * @since 0.5.0
   */
  memberName?: string;
  /**
   * Stable council member id (e.g. 'charont', 'nettun'). Useful for
   * tests + accessibility (machine-readable, not for display).
   *
   * @since 0.5.0
   */
  memberId?: string;
}

interface ChatStreamProps {
  messages: readonly ChatMessage[];
  height: number;
  width: number;
}

/**
 * Estimate the rendered row count for a single message.
 *
 * Width accounting matters here: under-estimating heights lets the transcript
 * grow taller than the terminal, at which point Ink falls back to clearing
 * and repainting the whole screen on every frame — the main source of
 * visible flicker during streaming. The ChatStream Box has paddingX={1}
 * (2 cols) and each message body an extra marginLeft={2}, so text wraps at
 * `width - 4`, not `width`.
 */
function estimateMessageHeight(m: ChatMessage, width: number): number {
  const textWidth = Math.max(1, width - 4);
  if (m.role === 'tool') {
    // Collapsed tool output: one summary line ("[name] args (ms) ▼"),
    // which can wrap on narrow terminals / long arg previews.
    const summaryLen = m.content.length + (m.toolName?.length ?? 4) + 13;
    let rows = Math.max(1, Math.ceil(summaryLen / textWidth));
    if (m.toolOk === false && m.toolResult) {
      // Failed tools auto-expand: bordered body (2 border rows) + wrapped
      // body lines at textWidth - 6 (extra marginLeft 2 + border 2 + padding 2).
      const bodyWidth = Math.max(1, textWidth - 6);
      rows += 2;
      for (const line of m.toolResult.split('\n')) {
        rows += Math.max(1, Math.ceil(line.length / bodyWidth));
      }
    }
    return rows;
  }
  const lines = m.content.split('\n');
  let textRows = 0;
  for (const line of lines) {
    textRows += Math.max(1, Math.ceil(line.length / textWidth));
  }
  return 1 + textRows + 1; // header + textRows + margin-bottom
}

/**
 * Pure helper: pick which messages fit in `height`, applying a top-truncation
 * to the first message that overflows. Extracted so it's unit-testable and
 * memoizable in the component.
 */
export function pickVisibleMessages(
  messages: readonly ChatMessage[],
  height: number,
  width: number,
): ChatMessage[] {
  const visibleMessages: ChatMessage[] = [];
  let remainingHeight = height - 1; // 1 row buffer for safety

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const mHeight = estimateMessageHeight(m, width);
    if (remainingHeight - mHeight >= 0) {
      visibleMessages.unshift(m);
      remainingHeight -= mHeight;
    } else {
      // Truncate the top-most visible message if we have some space.
      // Tool messages: collapse the body to just the summary when
      // there is not enough height for the (possibly auto-expanded)
      // bordered body — silently dropping the tool would blank the
      // whole transcript. Regression HIGH-1 (v0.6.2 audit).
      if (m.role === 'tool') {
        // Tools: minimum 1 row for the summary line. Skip the
        // `remainingHeight > 2` guard (which was tuned for assistant
        // messages that need header + body + margin-bottom).
        const textWidth = Math.max(1, width - 4);
        const summaryLen = m.content.length + (m.toolName?.length ?? 4) + 13;
        const summaryRows = Math.max(1, Math.ceil(summaryLen / textWidth));
        if (summaryRows <= remainingHeight) {
          // Show the collapsed summary (drop the auto-expanded body
          // if it would push us past the available height).
          const { toolResult: _omit, ...collapsed } = m;
          void _omit;
          visibleMessages.unshift(collapsed as ChatMessage);
        }
        // else: even the summary doesn't fit — fall through to break
        // and leave earlier visible messages in place.
      } else if (remainingHeight > 2) {
        const textWidth = Math.max(1, width - 4);
        const maxTextRows = remainingHeight - 2; // header + margin-bottom
        const lines = m.content.split('\n');
        const truncatedLines: string[] = [];
        let currentRows = 0;
        for (let j = lines.length - 1; j >= 0; j--) {
          const line = lines[j];
          const lineRows = Math.max(1, Math.ceil(line.length / textWidth));
          if (currentRows + lineRows <= maxTextRows) {
            truncatedLines.unshift(line);
            currentRows += lineRows;
          } else {
            truncatedLines.unshift('... [truncated]');
            break;
          }
        }
        visibleMessages.unshift({
          ...m,
          content: truncatedLines.join('\n'),
        });
      }
      break;
    }
  }
  return visibleMessages;
}

/**
 * Stateless rendering of the chat transcript. Tool messages (role === 'tool')
 * are rendered via CollapsibleToolOutput so each invocation can be expanded
 * to inspect its body (Task B.2.2).
 *
 * Performance: `visibleMessages` is computed via `React.useMemo` keyed on
 * [messages, height, width]. Without this, every streaming token delta from
 * the LLM (≈20-50/sec) would trigger:
 *   - O(N) `estimateMessageHeight` calls per render
 *   - O(N) `m.content.split('\n')` calls inside the truncation branch
 *   - A new `visibleMessages` array, which causes every child to re-render
 *
 * Wrapped in React.memo so the component re-renders only when its props
 * actually change (messages array identity, height, width).
 */
function ChatStreamImpl({ messages, height, width }: ChatStreamProps): React.ReactElement {
  const visibleMessages = React.useMemo(
    () => pickVisibleMessages(messages, height, width),
    [messages, height, width],
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} height={height} overflow="hidden">
      {visibleMessages.length === 0 ? (
        <Text dimColor>Ready. Type a prompt or /skill &lt;name&gt; to invoke a skill.</Text>
      ) : (
        visibleMessages.map((m) => {
          if (m.role === 'tool') {
            return (
              <CollapsibleToolOutput
                key={m.id}
                toolName={m.toolName ?? 'tool'}
                summary={m.content}
                body={m.toolResult ?? m.content}
                ok={m.toolOk}
                durationMs={m.toolDurationMs}
                defaultExpanded={m.toolOk === false && !!m.toolResult}
              />
            );
          }
          return (
            <Box key={m.id} flexDirection="column" marginBottom={1}>
              <Text color={m.role === 'user' ? 'cyan' : m.role === 'assistant' ? 'green' : 'yellow'} bold>
                {m.role === 'user' ? '❯' : m.role === 'assistant' ? '◆' : 'ℹ'} {m.role}
                {m.role === 'assistant' && m.memberName ? (
                  <Text color="magenta"> · {m.memberName}</Text>
                ) : null}
              </Text>
              <Box marginLeft={2}>
                <Text>{m.content}</Text>
              </Box>
            </Box>
          );
        })
      )}
    </Box>
  );
}

export const ChatStream = React.memo(ChatStreamImpl);