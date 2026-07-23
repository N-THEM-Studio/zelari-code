/**
 * @-mention autocomplete popup for workspace files/folders.
 */
import { useEffect, useState } from "react";
import {
  searchWorkspace,
  type WorkspaceHit,
} from "../agentClient";

interface Props {
  cwd: string | null;
  /** Query after `@` (may be empty). */
  query: string;
  open: boolean;
  onPick: (hit: WorkspaceHit) => void;
  onClose: () => void;
  /** Keyboard: active index controlled by parent (optional). */
  activeIndex?: number;
  onActiveIndexChange?: (i: number) => void;
  /** Sync hits to parent for Arrow/Tab keyboard selection. */
  onHitsChange?: (hits: WorkspaceHit[]) => void;
}

export function MentionPopup({
  cwd,
  query,
  open,
  onPick,
  onClose,
  activeIndex = 0,
  onActiveIndexChange,
  onHitsChange,
}: Props) {
  const [hits, setHits] = useState<WorkspaceHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !cwd) {
      setHits([]);
      onHitsChange?.([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void searchWorkspace({ cwd, query: query || null, limit: 30 })
        .then((res) => {
          if (cancelled) return;
          const next = res.hits ?? [];
          setHits(next);
          onHitsChange?.(next);
          onActiveIndexChange?.(0);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
          setHits([]);
          onHitsChange?.([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, cwd, query, onActiveIndexChange, onHitsChange]);

  if (!open) return null;

  if (!cwd) {
    return (
      <div className="mention-popup" role="listbox">
        <div className="mention-empty">Open a project folder to @-tag files.</div>
      </div>
    );
  }

  return (
    <div className="mention-popup" role="listbox" aria-label="Tag file or folder">
      <div className="mention-popup-head">
        <span>Tag path</span>
        <button type="button" className="btn-ghost mention-close" onClick={onClose}>
          Esc
        </button>
      </div>
      {loading && <div className="mention-empty">Searching…</div>}
      {error && <div className="mention-empty error-banner">{error}</div>}
      {!loading && !error && hits.length === 0 && (
        <div className="mention-empty">No matches for “{query || "…"}”</div>
      )}
      <ul className="mention-list">
        {hits.map((h, i) => (
          <li key={h.absolute}>
            <button
              type="button"
              className={`mention-item${i === activeIndex ? " is-active" : ""}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => onActiveIndexChange?.(i)}
              onClick={() => onPick(h)}
            >
              <span className="mention-kind" aria-hidden>
                {h.isDir ? "📁" : "📄"}
              </span>
              <span className="mention-path">{h.path}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Detect active @-mention query at the end of the draft (or at caret). */
export function detectMentionQuery(
  text: string,
  caret: number = text.length,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  // Find last @ not part of email: start or whitespace before @
  const m = /(?:^|[\s([{])@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const full = m[0];
  const atIdx = before.length - full.length + (full.startsWith("@") ? 0 : full.search(/@/));
  const query = m[1] ?? "";
  // Don't open for bare emails mid-word
  if (atIdx > 0 && /[A-Za-z0-9._%+-]/.test(before[atIdx - 1] ?? "")) {
    return null;
  }
  return { start: atIdx, query };
}

export function applyMentionInsert(
  text: string,
  start: number,
  caret: number,
  path: string,
): { text: string; caret: number } {
  const insert = `@${path.replace(/\\/g, "/")} `;
  const next = text.slice(0, start) + insert + text.slice(caret);
  return { text: next, caret: start + insert.length };
}
