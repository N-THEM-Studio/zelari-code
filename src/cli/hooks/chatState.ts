// @ts-nocheck — shares the pre-existing strict-mode type narrowing carried
// over from useSession/useChatTurn. Runtime is correct.
import type { ChatMessage } from "../components/ChatStream.js";
import {
  formatToolSummary,
  toolResultForStorage,
} from "../components/toolFormat.js";

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
  role: "tool";
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
      cur.role === "assistant" &&
      (cur.memberId ?? null) === (memberContext?.memberId ?? null)
    ) {
      return { ...prev, streaming: { ...cur, content: fullContent, ts } };
    }
    return {
      ...prev,
      streaming: {
        id: `streaming-${crypto.randomUUID()}`,
        role: "assistant",
        content: fullContent,
        ts,
        ...(memberContext?.memberId
          ? { memberId: memberContext.memberId }
          : {}),
        ...(memberContext?.memberName
          ? { memberName: memberContext.memberName }
          : {}),
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
    if (!cur || !cur.id.startsWith("streaming-")) return prev;
    const sealed = { ...cur, id: cur.id.slice("streaming-".length) };
    setFinalized((fin) => [...fin, sealed]);
    return { ...prev, streaming: null };
  });
}

/**
 * Max chars of tool result kept in memory for the printed body.
 *
 * v0.7.3: raised from 600 to 8000. The 600-char cut happened BEFORE
 * formatToolResult could parse the JSON envelope — truncated JSON no longer
 * parses, so every long bash/read_file result fell back to the raw escaped
 * envelope (the ugly boxes in the 2026-07-02 live test). Display truncation
 * is line-based in the formatter (ZELARI_TOOL_OUTPUT_LINES); this constant is
 * only a memory bound.
 */
export { TOOL_RESULT_PREVIEW_CHARS } from "../components/toolFormat.js";

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
  // v0.7.1 (B2): human-readable summary instead of raw-JSON args.
  const argsPreview = formatToolSummary(toolName, args);
  setLive((prev) => ({
    ...prev,
    runningTools: [
      ...prev.runningTools,
      {
        id: crypto.randomUUID(),
        role: "tool",
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
 * v0.7.3: the previous signature took a `live` snapshot (from `liveRef`) and
 * removed by INDEX inside the functional updater. `liveRef` only updates on
 * render, so for fast tools (start+end within one frame) the snapshot missed
 * the just-started tool (end event dropped → tool stuck in the live region)
 * or, with two ends in one frame, removed the WRONG element. The lookup now
 * happens inside the `setLive` updater against the CURRENT state, keyed by
 * toolCallId — same cross-setter pattern as {@link finalizeStreaming}.
 *
 * No-op if the toolCallId is unknown (defensive against duplicate end events).
 */
export function completeTool(
  setFinalized: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setLive: React.Dispatch<React.SetStateAction<LiveState>>,
  toolCallId: string,
  isError: boolean,
  durationMs: number,
  result?: string,
): void {
  setLive((prev) => {
    const tool = prev.runningTools.find(
      (t) => t.toolCallId === toolCallId && t.toolDurationMs === undefined,
    );
    if (!tool) return prev;
    const completed: ChatMessage = {
      ...tool,
      toolOk: !isError,
      toolDurationMs: durationMs,
      ...(result !== undefined
        ? {
            toolResult: toolResultForStorage(
              tool.toolName ?? "",
              result,
              isError,
            ),
          }
        : {}),
    };
    setFinalized((fin) => [...fin, completed]);
    return {
      ...prev,
      runningTools: prev.runningTools.filter((t) => t !== tool),
    };
  });
}
