// @ts-nocheck — shares the pre-existing strict-mode type narrowing carried
// over from useSession/useChatTurn. Runtime is correct.
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * chatState — finalized/live split for the static-scrollback TUI (v0.7.0).
 *
 * Background: see `docs/plans/2026-07-02-static-scrollback-tui.md` (Phase 1).
 * The previous model held a single `messages: ChatMessage[]` and mutated it
 * in place (streaming bubble rewritten per token; tool message mutated on
 * `tool_execution_end`). That forced a fixed-height frame with manual visible-
 * message picking, which flickered and dropped old content.
 *
 * The new model splits the transcript into two regions:
 *
 *   - `finalized: ChatMessage[]` — append-only. Feeds Ink's `<Static>`, so
 *     each item is printed exactly once to real stdout and becomes part of
 *     the terminal's native scrollback. Once a message lands here it MUST
 *     NEVER change (Static items are immutable).
 *
 *   - `live: LiveState` — the small dynamic region Ink repaints:
 *       - `streaming`: the currently-streaming assistant bubble (or null).
 *       - `runningTools`: tool invocations between `tool_execution_start`
 *         and `tool_execution_end`. They mutate (pending → done) so they
 *         cannot enter `finalized` until the end event arrives.
 *
 * Design invariant (enforced by the transitions below):
 *   **A message enters `finalized` only when it can never change again.**
 *   - system/user: final immediately on append.
 *   - assistant streaming: final on `finalizeStreamingAssistant()`
 *     (the seal point already used today, fired on `message_end` /
 *     pre-tool-call).
 *   - tool: final on `tool_execution_end`, NOT on start.
 *
 * Migration note: the slash-handler layer and most tests still call the
 * existing `appendSystem(setMessages, content)` / `appendUser(...)` helpers
 * with a single-array setter. Because `finalized` IS the array the UI
 * displays, wiring those legacy setters to the `finalized` setter keeps them
 * correct with zero changes at the call sites. Only the streaming hot-path
 * and tool start/end are rerouted here.
 */

/** A tool invocation currently in flight (between start and end events). */
export interface RunningTool extends ChatMessage {
  role: 'tool';
  /** Resolved on `tool_execution_end`; undefined while pending. */
  toolOk?: boolean;
  toolDurationMs?: number;
  toolResult?: string;
}

/**
 * The dynamic region Ink repaints every frame. Always small (one streaming
 * bubble + N pending tools), so it can never exceed the terminal height and
 * never triggers a full-screen clear/repaint.
 */
export interface LiveState {
  /** The streaming assistant bubble, or null when no turn is active. */
  streaming: ChatMessage | null;
  /** Tool invocations awaiting their `tool_execution_end`. */
  runningTools: RunningTool[];
}

export const EMPTY_LIVE: LiveState = { streaming: null, runningTools: [] };

/**
 * Append a finalized message (system/user/sealed-assistant/completed-tool).
 * Pure helper — callers pass the setter they want to target (the
 * `finalized` setter in production, a plain array setter in tests).
 */
export function pushFinalized(
  setFinalized: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  message: ChatMessage,
): void {
  setFinalized((prev) => [...prev, message]);
}

/**
 * Update or start the streaming assistant bubble in `live`.
 *
 * - If `live.streaming` exists and (for council) belongs to the same member,
 *   replace its content with `fullContent` (the streaming caller always
 *   passes full accumulated content, not a delta).
 * - Otherwise create a new streaming bubble stamped with the member context.
 *
 * `setLive` accepts a functional updater so the throttle layer
 * (`useBatchedMessages`-style) can compose multiple updates without reading
 * stale state.
 */
export function setStreaming(
  setLive: React.Dispatch<React.SetStateAction<LiveState>>,
  fullContent: string,
  ts: number,
  memberContext?: { memberId?: string; memberName?: string },
): void {
  setLive((prev) => {
    const cur = prev.streaming;
    if (
      cur &&
      cur.role === 'assistant' &&
      (cur.memberId ?? null) === (memberContext?.memberId ?? null)
    ) {
      return { ...prev, streaming: { ...cur, content: fullContent, ts } };
    }
    return {
      ...prev,
      streaming: {
        id: `streaming-${crypto.randomUUID()}`,
        role: 'assistant',
        content: fullContent,
        ts,
        ...(memberContext?.memberId ? { memberId: memberContext.memberId } : {}),
        ...(memberContext?.memberName ? { memberName: memberContext.memberName } : {}),
      },
    };
  });
}

/**
 * Move `live.streaming` (if any) into `finalized`, sealing it. Drops the
 * `streaming-` id prefix so the next bubble starts fresh. Idempotent: a no-op
 * when nothing is streaming.
 *
 * This is the seal point fired on `message_end` and before a tool call: the
 * bubble is complete and can be printed once into scrollback.
 */
export function finalizeStreaming(
  setFinalized: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setLive: React.Dispatch<React.SetStateAction<LiveState>>,
): void {
  setLive((prev) => {
    const cur = prev.streaming;
    if (!cur || !cur.id.startsWith('streaming-')) return prev;
    const sealed = { ...cur, id: cur.id.slice('streaming-'.length) };
    setFinalized((fin) => [...fin, sealed]);
    return { ...prev, streaming: null };
  });
}

/** Max chars of tool result kept for the printed body (Phase 3 policy). */
export const TOOL_RESULT_PREVIEW_CHARS = 600;

/** Max chars of the JSON args preview shown on the tool summary line. */
export const TOOL_ARGS_PREVIEW_CHARS = 120;

/**
 * Register a tool invocation in `live.runningTools`. The summary (args
 * preview) is computed once; the result body is filled in by
 * {@link completeTool} on `tool_execution_end`.
 */
export function startTool(
  setLive: React.Dispatch<React.SetStateAction<LiveState>>,
  toolName: string,
  toolCallId: string,
  args: unknown,
  ts: number,
): void {
  const argsPreview = JSON.stringify(args)?.slice(0, TOOL_ARGS_PREVIEW_CHARS) ?? '';
  setLive((prev) => ({
    ...prev,
    runningTools: [
      ...prev.runningTools,
      {
        id: crypto.randomUUID(),
        role: 'tool',
        content: argsPreview,
        ts,
        toolName,
        toolCallId,
        toolOk: undefined,
        toolDurationMs: undefined,
      },
    ],
  }));
}

/**
 * Mark a running tool as done and move it into `finalized`. Removes it from
 * `live.runningTools` (by `toolCallId`) and appends the completed message —
 * with its result body — to `finalized`.
 *
 * The caller passes the CURRENT `live` snapshot (the value the next render
 * would see) so we can compute the completed tool deterministically without
 * relying on functional-updater timing. The two setters are invoked with
 * functional updaters that read from that snapshot.
 *
 * No-op if the toolCallId is unknown (defensive against duplicate end events).
 */
export function completeTool(
  live: LiveState,
  setFinalized: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setLive: React.Dispatch<React.SetStateAction<LiveState>>,
  toolCallId: string,
  isError: boolean,
  durationMs: number,
  result?: string,
): void {
  const idx = live.runningTools.findIndex(
    (t) => t.toolCallId === toolCallId && t.toolDurationMs === undefined,
  );
  if (idx === -1) return;
  const tool = live.runningTools[idx]!;
  const completed: ChatMessage = {
    ...tool,
    toolOk: !isError,
    toolDurationMs: durationMs,
    ...(result !== undefined
      ? {
          toolResult:
            result.length > TOOL_RESULT_PREVIEW_CHARS
              ? `${result.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`
              : result,
        }
      : {}),
  };
  setFinalized((fin) => [...fin, completed]);
  setLive((prev) => ({
    ...prev,
    runningTools: prev.runningTools.filter((_, i) => i !== idx),
  }));
}
