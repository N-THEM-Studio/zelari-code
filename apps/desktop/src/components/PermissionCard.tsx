/**
 * In-chat tool-permission approval (Desktop). Replaces the native OS dialog.
 * TUI parity: Allow once · Always this tool · Always this category · Deny.
 *
 * Density contract (readability pass): PENDING is the only state with buttons,
 * and its preview hides behind a collapsible block — a 400-line diff must not
 * own the chat. SETTLED collapses to a one-line chip: the decision is history,
 * and history does not need a card worth of space on every scroll.
 */
import type { PermissionAskState, PermissionAskStatus } from "../inChatAsk";
import "./systemNotice.css";

interface Props {
  ask: PermissionAskState;
  disabled?: boolean;
  onDecide: (decision: Exclude<PermissionAskStatus, "pending" | "timeout">) => void;
}

const SETTLED_LABEL: Record<Exclude<PermissionAskStatus, "pending">, string> = {
  allow: "Allowed once",
  deny: "Denied",
  "always-tool": "Allowed for this session (tool)",
  "always-category": "Allowed for this session (category)",
  timeout: "Timed out — denied",
};

/** Outcomes that GRANTED the call → ✓ chip; deny and timeout → ✕ chip. */
const ALLOWING: ReadonlySet<PermissionAskStatus> = new Set([
  "allow",
  "always-tool",
  "always-category",
]);

/** A preview within BOTH limits opens expanded: a short command stays readable. */
const PREVIEW_INLINE_LINES = 8;
const PREVIEW_INLINE_CHARS = 400;

export function PermissionCard({ ask, disabled, onDecide }: Props) {
  const catLabel =
    ask.categories.length === 1
      ? ask.categories[0]
      : ask.categories.join("+") || ask.category || "action";

  // SETTLED: one line, no preview, no buttons. The ask is over — only the
  // outcome (and which tool it was about) still deserves a pixel.
  if (ask.status !== "pending") {
    const allowed = ALLOWING.has(ask.status);
    const label = SETTLED_LABEL[ask.status];
    return (
      <div
        className={`permission-chip ${allowed ? "is-allow" : "is-deny"}`}
        role="status"
        aria-label={`Tool permission — ${label}: ${ask.tool}`}
      >
        <span className="permission-chip-glyph" aria-hidden>
          {allowed ? "✓" : "✕"}
        </span>
        <span className="permission-chip-label">{label}</span>
        <span className="permission-chip-sep" aria-hidden>
          ·
        </span>
        <span className="permission-chip-tool" title={`Tool: ${ask.tool}`}>
          {ask.tool}
        </span>
      </div>
    );
  }

  const preview = ask.preview ?? "";
  const previewLines = preview ? preview.split(/\r?\n/).length : 0;
  const previewInline =
    previewLines <= PREVIEW_INLINE_LINES && preview.length <= PREVIEW_INLINE_CHARS;

  return (
    <div className="clarification-card permission-card" role="group" aria-label="Tool permission">
      <div className="clarification-kicker">Approval required</div>
      <div className="clarification-question">
        Allow tool “{ask.tool}”?
      </div>
      {ask.reason ? (
        <div className="clarification-context">{ask.reason}</div>
      ) : null}
      <div className="permission-meta">
        <span className="permission-category" title="Permission category">
          {catLabel}
        </span>
      </div>
      {preview ? (
        <details
          className="permission-preview-block"
          // Long payloads (diffs, file bodies) stay collapsed; short ones are
          // cheaper to read open. `undefined` keeps <details> uncontrolled so a
          // manual toggle survives the parent's re-renders.
          open={previewInline || undefined}
        >
          <summary className="permission-preview-summary">
            {previewInline ? "Preview" : `Show preview (${previewLines} lines)`}
          </summary>
          <pre className="permission-preview">{preview}</pre>
        </details>
      ) : null}
      <div className="clarification-choices permission-actions">
        <button
          type="button"
          className="clarification-choice is-primary"
          disabled={disabled}
          onClick={() => onDecide("allow")}
        >
          Allow once
        </button>
        <button
          type="button"
          className="clarification-choice is-secondary"
          disabled={disabled}
          onClick={() => onDecide("always-tool")}
        >
          Always this session · tool {ask.tool}
        </button>
        {ask.categories.length > 0 ? (
          <button
            type="button"
            className="clarification-choice is-secondary"
            disabled={disabled}
            onClick={() => onDecide("always-category")}
          >
            Always this session · {catLabel}
          </button>
        ) : null}
        <button
          type="button"
          className="clarification-choice is-deny"
          disabled={disabled}
          onClick={() => onDecide("deny")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
