/**
 * acp/eventMap — pure projection from the headless NDJSON event stream onto
 * the ACP `session/update` subset (protocol.ts).
 *
 * The source schema is the CLI's own documented BrainEvent stream
 * (`@zelari/core/events`, `createBrainEvent`) — the same one the TUI projects
 * with `src/cli/hooks/eventsToMessages.ts` and hosts parse on stdout when
 * `--headless --output json` is used. Anchoring on it (instead of scraping
 * stdout text) keeps the mapping stable and testable.
 *
 * Events outside the mapped set (log, kraken_metrics, verification_run,
 * session_started, harness_state, …) produce NO update on purpose: the ACP
 * client sees the message text and the tool calls, nothing else.
 *
 * Fail-soft: anything that is not an object with a recognised `type` maps to
 * an empty update list. This function never throws.
 */
import { agentMessageChunk, toolCallStart, toolCallStatus, type SessionUpdate } from './protocol.js';

/** Project one decoded headless event into zero or more ACP updates. */
export function mapHeadlessEvent(event: unknown): SessionUpdate[] {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return [];
  const e = event as Record<string, unknown>;
  switch (e['type']) {
    case 'message_delta': {
      const delta = e['delta'];
      return typeof delta === 'string' && delta.length > 0 ? [agentMessageChunk(delta)] : [];
    }
    case 'tool_execution_start': {
      const callId = e['toolCallId'];
      const toolName = e['toolName'];
      if (typeof callId !== 'string' || callId.length === 0) return [];
      const title = typeof toolName === 'string' && toolName.length > 0 ? toolName : 'tool';
      return [toolCallStart({ callId, title })];
    }
    case 'tool_execution_end': {
      const callId = e['toolCallId'];
      if (typeof callId !== 'string' || callId.length === 0) return [];
      return [toolCallStatus({ callId, status: e['isError'] === true ? 'failed' : 'completed' })];
    }
    default:
      return [];
  }
}

/** Mutable line buffer used while draining the captured stdout stream. */
export interface LineBuffer {
  text: string;
}

/**
 * Split complete lines out of `buffer`. `flush` additionally emits the
 * trailing partial line (called once, after the turn's stdout was restored).
 * Empty lines are skipped — the mapping is line-oriented NDJSON.
 */
export function drainLines(
  buffer: LineBuffer,
  flush: boolean,
  onLine: (line: string) => void,
): void {
  for (;;) {
    const nl = buffer.text.indexOf('\n');
    if (nl === -1) break;
    const line = buffer.text.slice(0, nl).trim();
    buffer.text = buffer.text.slice(nl + 1);
    if (line.length > 0) onLine(line);
  }
  if (!flush) return;
  const tail = buffer.text.trim();
  buffer.text = '';
  if (tail.length > 0) onLine(tail);
}

/**
 * One captured stdout line -> updates. A line that is not JSON is treated as
 * plain assistant text (a non-JSON writer in the turn path must not lose the
 * message). Never throws.
 */
export function mapCapturedLine(line: string): SessionUpdate[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [agentMessageChunk(line)];
  }
  return mapHeadlessEvent(event);
}
