/**
 * Queued follow-ups strip (Desktop UI phase F3 — "the chat stays responsive").
 *
 * Extracted verbatim from the inline composer block in App.tsx, so the mid-run
 * contract is testable: while a run is live the chat input keeps accepting
 * text, `send()` routes it through `classifyLiveSend` (liveSend.ts) to a steer
 * or — when the backend cannot take it mid-run — to the conversation's
 * `pendingFollowUps`, rendered HERE as a visibly labelled "Queued i/N" chip
 * ("Next i/N" when idle, i.e. the order of the next dispatch).
 *
 * Presentation only: App owns the queue and the draft hand-back. Removing a
 * chip never sends anything — the text goes back to the composer (no fake
 * send, no silent drop).
 */
export interface QueuedFollowUpsProps {
  /** `Conversation.pendingFollowUps` of the active conversation. */
  items: string[];
  /** True while the run is live: the chip means "queued", not "next". */
  running: boolean;
  /** Hand item `i` back to App (queue removal; App restores the draft). */
  onRemove: (index: number) => void;
}

export function QueuedFollowUps({ items, running, onRemove }: QueuedFollowUpsProps) {
  if (items.length === 0) return null;
  return (
    <div
      className="attach-strip"
      aria-label="Queued follow-ups"
      aria-live="polite"
      role="status"
    >
      {items.map((q, i) => (
        <div key={`${i}-${q.slice(0, 24)}`} className="attach-chip" title={q}>
          <span className="attach-chip-meta">
            <span className="attach-chip-name">
              {running ? "Queued" : "Next"} {i + 1}/{items.length}
            </span>
            <span className="attach-chip-sub">
              {q.replace(/\s+/g, " ").slice(0, 72)}
              {q.length > 72 ? "…" : ""}
            </span>
          </span>
          <button
            type="button"
            className="attach-chip-remove"
            title="Remove from queue"
            aria-label={`Remove queued message ${i + 1} from the queue`}
            onClick={() => onRemove(i)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
