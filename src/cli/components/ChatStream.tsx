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
}

/**
 * Stateless rendering of the chat transcript. Tool messages (role === 'tool')
 * are rendered via CollapsibleToolOutput so each invocation can be expanded
 * to inspect its body (Task B.2.2).
 */
export function ChatStream({ messages }: ChatStreamProps): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.length === 0 ? (
        <Text dimColor>Ready. Type a prompt or /skill &lt;name&gt; to invoke a skill.</Text>
      ) : (
        messages.map((m) => {
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