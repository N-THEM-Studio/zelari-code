/**
 * PendingApprovalsCard — Settings → Automations: social_post drafts awaiting a
 * human decision (allow / edit / deny). Rendered ONLY when the inbox is
 * non-empty. Failures stay visible instead of collapsing the card.
 */
import { useCallback, useEffect, useState } from "react";
import {
  formatAutomationError,
  listPendingApprovals,
  resolveAutomationApproval,
  type PendingApproval,
} from "../../agentClient";
import { SettingsCard, StatusPill } from "./primitives";

export interface PendingApprovalsCardProps {
  workdir: string | null;
  refreshToken: number;
  onChanged: () => void;
}

/** Chars of the draft the card previews before truncating. */
export const PREVIEW_CHARS = 120;

/** Human "expires in ~X" label (countdown-ish; absolute time as fallback). */
export function expiryLabel(expiresAt: string | undefined, now = Date.now()): string {
  if (!expiresAt) return "no expiry";
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return `expires ${expiresAt}`;
  if (ms <= 0) return "expired";
  const min = Math.round(ms / 60_000);
  if (min >= 60) return `expires in ~${Math.round(min / 60)} h`;
  return `expires in ~${min} min`;
}

export function PendingApprovalsCard({
  workdir,
  refreshToken,
  onChanged,
}: PendingApprovalsCardProps) {
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");

  const repoPath = workdir ?? "";

  const load = useCallback(async () => {
    if (!repoPath) {
      setItems([]);
      return;
    }
    try {
      const { approvals } = await listPendingApprovals(repoPath);
      setItems(approvals);
      setError(null);
    } catch (e) {
      setError(formatAutomationError(e));
    }
  }, [repoPath]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const resolve = async (runId: string, decision: "allow" | "deny" | "edit") => {
    if (busy) return;
    setBusy(runId);
    setError(null);
    try {
      await resolveAutomationApproval(
        runId,
        decision,
        repoPath,
        decision === "edit" ? draftText : undefined,
      );
      setEditing(null);
      setDraftText("");
      onChanged();
    } catch (e) {
      setError(formatAutomationError(e));
    } finally {
      setBusy(null);
    }
  };

  // Only when there is something to decide (or a failure to show).
  if (items.length === 0 && !error) return null;

  return (
    <SettingsCard
      title="Pending approvals"
      description="Drafts awaiting a human decision (allow / edit / deny) before anything is published."
    >
      {error ? <StatusPill tone="warn">{error}</StatusPill> : null}
      {items.map((p) => {
        const isEditing = editing === p.runId;
        const truncated = p.draftPreview.length >= PREVIEW_CHARS;
        return (
          <div className="s-row" key={p.runId}>
            <div>
              <div className="s-row-label">
                {p.automationId} <StatusPill tone="warn">awaiting</StatusPill>
              </div>
              <div className="s-row-hint">
                <code>{p.runId}</code> · {expiryLabel(p.expiresAt)}
              </div>
              <p className="s-card-desc">
                {p.draftPreview || "(empty draft)"}
                {truncated ? "…" : ""}
              </p>
              {isEditing ? (
                <textarea
                  className="s-input"
                  aria-label={`Edit draft ${p.runId}`}
                  value={draftText}
                  rows={3}
                  onChange={(e) => setDraftText(e.target.value)}
                />
              ) : null}
            </div>
            <div className="s-row-control">
              <button
                type="button"
                className="btn-send"
                disabled={busy === p.runId}
                onClick={() => void resolve(p.runId, "allow")}
              >
                Allow
              </button>
              {isEditing ? (
                <>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy === p.runId}
                    onClick={() => void resolve(p.runId, "edit")}
                  >
                    Save &amp; publish
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      setEditing(null);
                      setDraftText("");
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy === p.runId}
                  onClick={() => {
                    setEditing(p.runId);
                    setDraftText(p.draftPreview);
                  }}
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                className="btn-ghost"
                disabled={busy === p.runId}
                onClick={() => void resolve(p.runId, "deny")}
              >
                Deny
              </button>
            </div>
          </div>
        );
      })}
    </SettingsCard>
  );
}
