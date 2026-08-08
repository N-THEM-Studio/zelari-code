/**
 * WorkbenchPanel - tabbed side panel that hosts the Kraken graph
 * visualizer AND the live markdown tail. The two views read the same
 * workbench file, but surface different layers of the same data:
 *
 *   Graph tab  — node-first, click-to-inspect, weak/medium/tight dots
 *   Tail tab   — raw markdown rendering, copy-paste friendly
 *
 * The panel is closed by an `onClose` callback in the parent. Polling
 * is paused when the panel is closed to save IPC cycles; both children
 * receive the same `open` flag so they can short-circuit on the same
 * condition.
 *
 * @since v1.31.x - Bennett's Razor UI surface (Slice N / desktop)
 */

import { useState } from "react";
import { KrakenGraphVisualizer } from "./KrakenGraphVisualizer";
import { WorkbenchLiveTail } from "./WorkbenchLiveTail";

interface Props {
  /** Project root. */
  cwd: string | null;
  /** Whether the panel is open. */
  open: boolean;
  /** Close handler. */
  onClose: () => void;
  /** Initial active tab. Defaults to "graph". */
  initialTab?: "graph" | "tail";
}

type Tab = "graph" | "tail";

export function WorkbenchPanel({ cwd, open, onClose, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "graph");

  if (!open) return null;

  return (
    <aside className="workbench-panel" role="complementary" aria-label="Kraken workbench">
      <header className="workbench-panel-head">
        <div className="workbench-panel-title">
          <span className="workbench-panel-icon" aria-hidden>📋</span>
          <span>Kraken Workbench</span>
        </div>
        <button
          type="button"
          className="btn-ghost workbench-panel-close"
          onClick={onClose}
          aria-label="Close workbench"
          title="Close (×)"
        >
          ×
        </button>
      </header>

      <nav className="workbench-panel-tabs" role="tablist" aria-label="Workbench views">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "graph"}
          className={`workbench-tab${tab === "graph" ? " active" : ""}`}
          onClick={() => setTab("graph")}
        >
          🕸️ Graph
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "tail"}
          className={`workbench-tab${tab === "tail" ? " active" : ""}`}
          onClick={() => setTab("tail")}
        >
          📄 Tail
        </button>
      </nav>

      {tab === "graph" ? (
        <KrakenGraphVisualizer cwd={cwd} open={open} />
      ) : (
        <WorkbenchLiveTail cwd={cwd} open={open} />
      )}
    </aside>
  );
}
