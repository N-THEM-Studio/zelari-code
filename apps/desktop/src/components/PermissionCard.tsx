/**
 * In-chat tool-permission approval (Desktop). Replaces the native OS dialog.
 * TUI parity: Allow once · Always this tool · Always this category · Deny.
 */
import type { PermissionAskState, PermissionAskStatus } from "../inChatAsk";

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

export function PermissionCard({ ask, disabled, onDecide }: Props) {
  const catLabel =
    ask.categories.length === 1
      ? ask.categories[0]
      : ask.categories.join("+") || ask.category || "action";

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
        <span>Category: {catLabel}</span>
      </div>
      {ask.preview ? (
        <pre className="permission-preview">{ask.preview}</pre>
      ) : null}
      {ask.status === "pending" ? (
        <div className="clarification-choices">
          <button
            type="button"
            className="clarification-choice"
            disabled={disabled}
            onClick={() => onDecide("allow")}
          >
            Allow once
          </button>
          <button
            type="button"
            className="clarification-choice"
            disabled={disabled}
            onClick={() => onDecide("always-tool")}
          >
            Always this session · tool {ask.tool}
          </button>
          {ask.categories.length > 0 ? (
            <button
              type="button"
              className="clarification-choice"
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
      ) : (
        <div className="clarification-hint">{SETTLED_LABEL[ask.status]}</div>
      )}
    </div>
  );
}
