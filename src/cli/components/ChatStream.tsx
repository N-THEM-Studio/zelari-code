import React from 'react';
import { Box, Text } from 'ink';
import { ToolOutput } from './ToolOutput.js';

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
   * Tool result body (truncated), shown by ToolOutput when the invocation is
   * expanded (errors auto-expand). Kept separate from `content` so the
   * collapsed summary stays a stable one-liner.
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

/**
 * renderMessage — pure per-message renderer shared by `<Static>` (finalized
 * items, printed once into native scrollback) and the live region (the
 * streaming tail + pending tools, repainted by Ink).
 *
 * v0.7.0 static-scrollback refactor: this replaces the old `ChatStream`
 * component, which combined rendering with visible-message picking
 * (`pickVisibleMessages` / `estimateMessageHeight`). Those are gone —
 * `<Static>` handles scrollback, and the live region guarantees a small
 * dynamic footprint by construction. Each message renders identically
 * whether it is printed once (Static) or repainted (live), so the UI is
 * stable as a message crosses from live → finalized.
 *
 * `live` flag: when true, the tool summary shows a pending glyph and no
 * duration (the invocation hasn't ended yet). Finalized tool messages
 * render via the stateless `ToolOutput` policy (Phase 3).
 */
export function renderMessage(m: ChatMessage, live = false): React.ReactElement {
  if (m.role === 'tool') {
    return (
      <ToolOutput
        key={m.id}
        toolName={m.toolName ?? 'tool'}
        summary={m.content}
        body={m.toolResult ?? m.content}
        ok={m.toolOk}
        durationMs={m.toolDurationMs}
        live={live}
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
}

/**
 * ChatStreamImpl kept as a thin backward-compat shim for any caller or test
 * that still imports the `<ChatStream>` component. It renders the full
 * message list top-to-bottom WITHOUT visible-message picking (the fixed
 * frame + height math is gone in v0.7.0). In production, `app.tsx` uses
 * `<Static>` + `<LiveRegion>` directly and does not mount this component.
 */
interface ChatStreamProps {
  messages: readonly ChatMessage[];
  /** Ignored in v0.7.0 (kept for type compat). */
  height?: number;
  /** Ignored in v0.7.0 (kept for type compat). */
  width?: number;
}

function ChatStreamImpl({ messages }: ChatStreamProps): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.length === 0 ? (
        <Text dimColor>Ready. Type a prompt or /skill &lt;name&gt; to invoke a skill.</Text>
      ) : (
        messages.map((m) => renderMessage(m))
      )}
    </Box>
  );
}

export const ChatStream = React.memo(ChatStreamImpl);

// ── Backward-compat exports for tests still importing the picking helpers ──
// The v0.6.2 `pickVisibleMessages` / `estimateMessageHeight` are removed in
// v0.7.0 (the fixed frame is gone). Re-exporting shims that delegate to a
// trivial implementation keeps older test imports resolving until those tests
// are migrated. See tests/unit/v4-ui-audit.test.ts + cli-toolDisplay.test.ts.

/**
 * @deprecated since v0.7.0 — visible-message picking is removed; `<Static>`
 * handles scrollback. This shim returns the input unchanged so legacy tests
 * that only assert on returned message identity/content still pass.
 */
export function pickVisibleMessages(
  messages: readonly ChatMessage[],
  _height: number,
  _width: number,
): ChatMessage[] {
  return [...messages];
}
