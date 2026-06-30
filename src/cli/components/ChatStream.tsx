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
}

interface ChatStreamProps {
  messages: readonly ChatMessage[];
  height: number;
  width: number;
}

function estimateMessageHeight(m: ChatMessage, width: number): number {
  if (m.role === 'tool') {
    // Collapsed tool output takes 1 line of summary
    return 1;
  }
  const lines = m.content.split('\n');
  let textRows = 0;
  for (const line of lines) {
    textRows += Math.max(1, Math.ceil(line.length / width));
  }
  return 1 + textRows + 1; // header + textRows + margin-bottom
}

/**
 * Stateless rendering of the chat transcript. Tool messages (role === 'tool')
 * are rendered via CollapsibleToolOutput so each invocation can be expanded
 * to inspect its body (Task B.2.2).
 */
export function ChatStream({ messages, height, width }: ChatStreamProps): React.ReactElement {
  // Let's compute the visible messages that fit in the height
  const visibleMessages: ChatMessage[] = [];
  let remainingHeight = height - 1; // 1 row buffer for safety

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const mHeight = estimateMessageHeight(m, width);
    if (remainingHeight - mHeight >= 0) {
      visibleMessages.unshift(m);
      remainingHeight -= mHeight;
    } else {
      // Truncate the top-most visible message if we have some space
      if (remainingHeight > 2) {
        const maxTextRows = remainingHeight - 2; // header + margin-bottom
        const lines = m.content.split('\n');
        const truncatedLines: string[] = [];
        let currentRows = 0;
        for (let j = lines.length - 1; j >= 0; j--) {
          const line = lines[j];
          const lineRows = Math.max(1, Math.ceil(line.length / width));
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

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} height={height}>
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
                body={m.content}
                ok={m.toolOk}
                durationMs={m.toolDurationMs}
                defaultExpanded={false}
              />
            );
          }
          return (
            <Box key={m.id} flexDirection="column" marginBottom={1}>
              <Text color={m.role === 'user' ? 'cyan' : m.role === 'assistant' ? 'green' : 'yellow'} bold>
                {m.role === 'user' ? '❯' : m.role === 'assistant' ? '◆' : 'ℹ'} {m.role}
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