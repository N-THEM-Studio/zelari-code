/**
 * compaction — Transcript compaction for long sessions (Task B.3).
 *
 * Strategy: stateless sliding-window with a "summary" placeholder message.
 * When the transcript exceeds `threshold` messages, keep only the most
 * recent `keepRecent` ones and prepend a single system message that
 * records how many earlier messages were dropped.
 *
 * Note: this is intentionally simpler than the LLM-summarization approach
 * documented in the plan (B.3.1). The current implementation:
 *   - does NOT call an LLM
 *   - does NOT preserve semantics of dropped messages
 *   - just reduces the visible transcript so the next AgentHarness turn
 *     doesn't blow context-window budgets
 *
 * The LLM-summarization path can be added later as a sibling function
 * (e.g. `compactTranscriptWithSummary(messages, providerStream)`) without
 * breaking this contract.
 */

export interface CompactionOptions {
  /** Soft trigger — compact when messages.length > threshold. Default 50. */
  threshold?: number;
  /** Hard cap — keep at most this many recent messages. Default 20. */
  keepRecent?: number;
  /** Current epoch ms (injected for tests). */
  now?: number;
}

export interface CompactionResult {
  /** Compacted transcript (new array — original is not mutated). */
  messages: ReadonlyArray<CompactMessage>;
  /** Number of messages dropped. */
  droppedCount: number;
  /** Original total before compaction. */
  originalCount: number;
  /** Summary message prepended (null when no compaction needed). */
  summaryMessage: CompactMessage | null;
}

/** Minimal shape compatible with both BrainMessage and ChatMessage. */
export interface CompactMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  ts: number;
  toolName?: string;
  toolCallId?: string;
  toolOk?: boolean;
  toolDurationMs?: number;
  /** Truncated tool result body, shown in CollapsibleToolOutput when expanded. @since 0.6.2 */
  toolResult?: string;
  /** Council member name (e.g. "Caronte", "Lucifero") that produced this message. @since 0.5.0 */
  memberName?: string;
  /** Council member id (e.g. "charont", "lucifer"). @since 0.5.0 */
  memberId?: string;
}

/**
 * Compact a transcript when it exceeds the threshold.
 *
 * Returns the same array reference (with no summary) when compaction
 * isn't needed, so callers can compare references cheaply.
 */
export function compactTranscript(
  messages: ReadonlyArray<CompactMessage>,
  options: CompactionOptions = {},
): CompactionResult {
  const threshold = options.threshold ?? 50;
  const keepRecent = options.keepRecent ?? 20;
  const now = options.now ?? Date.now();
  const original = messages.length;

  if (original <= threshold || keepRecent >= original) {
    return {
      messages,
      droppedCount: 0,
      originalCount: original,
      summaryMessage: null,
    };
  }

  // Drop the oldest (original - keepRecent) messages.
  const keepCount = Math.min(keepRecent, original);
  const droppedCount = original - keepCount;
  const kept = messages.slice(-keepCount);

  const summary: CompactMessage = {
    id: `compact-${now}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'system',
    content: `[compact] ${droppedCount} earlier message(s) dropped (kept ${keepCount} recent). Full transcript in JSONL sidecar.`,
    ts: now,
  };

  return {
    messages: [summary, ...kept],
    droppedCount,
    originalCount: original,
    summaryMessage: summary,
  };
}

/** Format a CompactionResult for display in a system message. */
export function formatCompactionSummary(result: CompactionResult): string {
  if (result.droppedCount === 0) {
    return `[compact] no compaction needed (${result.originalCount} messages, below threshold)`;
  }
  return `[compact] ${result.originalCount} → ${result.messages.length} messages (dropped ${result.droppedCount})`;
}