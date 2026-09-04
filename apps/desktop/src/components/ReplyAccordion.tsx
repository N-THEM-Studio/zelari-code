/**
 * Accordion shell for assistant replies + footer stats.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { MessageStats } from "../types";
import { CopyButton } from "./CopyButton";
import { TurnStatsCard } from "./TurnStatsCard";

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
      {stats && !streaming ? <TurnStatsCard stats={stats} /> : null}
    </div>
  );
}
