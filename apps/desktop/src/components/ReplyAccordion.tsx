/**
 * Accordion shell for assistant replies + footer stats.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { MessageStats } from "../types";
import { CopyButton } from "./CopyButton";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

interface Props {
  title: string;
  badge?: string;
  streaming?: boolean;
  /** Force open while streaming; default open on first paint */
  defaultOpen?: boolean;
  stats?: MessageStats;
  /** When provided, renders a copy button in the header (reads text lazily). */
  onCopy?: () => string;
  children: ReactNode;
  className?: string;
}

export function ReplyAccordion({
  title,
  badge,
  streaming,
  defaultOpen = true,
  stats,
  onCopy,
  children,
  className = "",
}: Props) {
  const [open, setOpen] = useState(defaultOpen || !!streaming);

  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  return (
    <div
      className={`reply-accordion${streaming ? " is-streaming" : ""}${open ? " is-open" : ""}${onCopy ? " has-copy" : ""}${className ? ` ${className}` : ""}`}
    >
      {/* Fixed header: title / badge never scroll away */}
      <button
        type="button"
        className="reply-accordion-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="reply-accordion-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="reply-accordion-title">{title}</span>
        {badge ? <span className="badge badge-member">{badge}</span> : null}
        {streaming ? <span className="badge">streaming</span> : null}
      </button>
      {/* Sibling (not nested) of the head button — buttons can't nest. The
          card never scrolls itself, so this stays pinned over the header. */}
      {onCopy && !streaming ? (
        <CopyButton getText={onCopy} title="Copy reply" className="reply-copy" />
      ) : null}
      {open ? (
        <div className="reply-accordion-scroll">
          <div className="reply-accordion-body">{children}</div>
        </div>
      ) : null}
      {stats && !streaming ? (
        <div className="msg-stats reply-stats">
          {stats.durationMs != null && (
            <span title="Response time">{formatDuration(stats.durationMs)}</span>
          )}
          {stats.toolCount != null && stats.toolCount > 0 && (
            <span title="Tools used">
              {stats.toolCount} tool{stats.toolCount === 1 ? "" : "s"}
            </span>
          )}
          {stats.totalTokens != null && stats.totalTokens > 0 && (
            <span title="Tokens">
              {stats.totalTokens.toLocaleString()} tokens
              {stats.promptTokens != null && stats.completionTokens != null
                ? ` (↑${stats.promptTokens.toLocaleString()} ↓${stats.completionTokens.toLocaleString()})`
                : ""}
            </span>
          )}
          {stats.charCount != null && stats.charCount > 0 && (
            <span title="Characters">
              {stats.charCount.toLocaleString()} chars
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
