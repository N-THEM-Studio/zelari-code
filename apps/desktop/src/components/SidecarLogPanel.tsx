/**
 * Sidecar stderr diagnostics (W3.4).
 *
 * Owns its own ring buffer + open flag and subscribes to `harness-sidecar-log`
 * itself, so a stderr burst re-renders only this panel — never the chat tree.
 */
import { useEffect, useRef, useState } from "react";
import { onSidecarLog } from "../agentClient";
import {
  isSidecarErrorLine,
  pushSidecarLogLine,
  sidecarLogLineFromPayload,
} from "../sidecarLog";

export function SidecarLogPanel() {
  /** Newest 200 stderr lines; the child's stderr is noisy on boot. */
  const [lines, setLines] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onSidecarLog((payload) => {
      if (disposed) return;
      const line = sidecarLogLineFromPayload(payload);
      if (!line) return;
      setLines((prev) => pushSidecarLogLine(prev, line));
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // No Tauri backend reachable (e.g. dev browser) — nothing to surface.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Auto-scroll to the newest line while the panel is open.
  useEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, open]);

  return (
    <div className="sidecar-diagnostics">
      <button
        type="button"
        className="sidecar-log-toggle"
        aria-expanded={open}
        title="Backend CLI stderr (harness sidecar)"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>▣</span> Sidecar log
        {lines.length > 0 ? (
          <span className="sidecar-log-count">{lines.length}</span>
        ) : null}
      </button>
      {open ? (
        <div className="sidecar-log-panel" ref={panelRef} role="log">
          {lines.length === 0 ? (
            <div className="sidecar-log-empty">
              No sidecar stderr captured yet.
            </div>
          ) : (
            lines.map((line, i) => (
              <div
                key={i}
                className={
                  isSidecarErrorLine(line)
                    ? "sidecar-log-line is-error"
                    : "sidecar-log-line"
                }
              >
                {line}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
