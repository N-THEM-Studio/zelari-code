/**
 * WorkbenchPanel - tabbed side panel that hosts the Kraken graph
 * visualizer, the live markdown tail, the saved plan review, and the
 * session task list. The views read different layers of the same data:
 *
 *   Graph tab  — node-first, click-to-inspect, weak/medium/tight dots
 *   Tail tab   — raw markdown rendering, copy-paste friendly
 *   Plan tab   — saved `.zelari/radio/plan-<id>.json` files (plan→build)
 *   Tasks tab  — session todos mirrored from todo_write / todo_read
 *
 * The panel is closed by an `onClose` callback in the parent. Polling
 * is paused when the panel is closed to save IPC cycles.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { KrakenGraphVisualizer } from "./KrakenGraphVisualizer";
import { WorkbenchLiveTail } from "./WorkbenchLiveTail";
import { SessionTodosPanel } from "./SessionTodosPanel";
import { listDir, readProjectText } from "../agentClient";
import type { WorkPhase } from "../types";
import type { DesktopTodo } from "../sessionTodosUi";

interface Props {
  /** Project root. */
  cwd: string | null;
  /** Whether the panel is open. */
  open: boolean;
  /** Close handler. */
  onClose: () => void;
  /** Initial active tab. Defaults to "graph". */
  initialTab?: "graph" | "tail";
  /** Active plan/build phase (shown as a small badge). */
  phase?: WorkPhase;
  /** Plan id captured from the last `--plan-only` run (auto-selected). */
  planId?: string | null;
  /** Session todos mirrored from the parent agent's todo_write/read tools. */
  todos?: DesktopTodo[];
}

type Tab = "graph" | "tail" | "plan" | "tasks";

export function WorkbenchPanel({
  cwd,
  open,
  onClose,
  initialTab,
  phase,
  planId,
  todos,
}: Props) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "graph");

  if (!open) return null;

  return (
    <aside className="workbench-panel" role="complementary" aria-label="Kraken workbench">
      <header className="workbench-panel-head">
        <div className="workbench-panel-title">
          <span className="workbench-panel-icon" aria-hidden>📋</span>
          <span>Kraken Workbench</span>
          {phase ? <span className="workbench-phase-badge">{phase}</span> : null}
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
        <TabButton active={tab === "graph"} onClick={() => setTab("graph")} label="🕸️ Graph" />
        <TabButton active={tab === "tail"} onClick={() => setTab("tail")} label="📄 Tail" />
        <TabButton active={tab === "plan"} onClick={() => setTab("plan")} label="📝 Plan" />
        <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")} label="✓ Tasks" />
      </nav>

      {tab === "graph" ? (
        <KrakenGraphVisualizer cwd={cwd} open={open} />
      ) : tab === "tail" ? (
        <WorkbenchLiveTail cwd={cwd} open={open} />
      ) : tab === "plan" ? (
        <PlanView cwd={cwd} open={open} planId={planId} />
      ) : (
        <TasksView todos={todos ?? []} />
      )}
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`workbench-tab${active ? " active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Plan view — saved `.zelari/radio/plan-*.json` files                */
/* ------------------------------------------------------------------ */

interface PlanNode {
  id: string;
  kind?: string;
  label?: string;
  prompt?: string;
  deps?: string[];
  scope?: string[];
  acceptance?: string[];
  status?: string;
}

interface PlanSummary {
  id: string;
  nodes: PlanNode[];
  malformed: boolean;
}

const PLAN_DIR = ".zelari/radio";
const PLAN_PREFIX = "plan-";
const PLAN_SUFFIX = ".json";
const PLAN_POLL_MS = 2000;

async function listPlans(cwd: string): Promise<PlanSummary[]> {
  try {
    const res = await listDir({ path: PLAN_DIR, cwd });
    if (res.error) return [];
    const candidates = res.entries
      .filter(
        (e) =>
          !e.isDir &&
          e.name.startsWith(PLAN_PREFIX) &&
          e.name.endsWith(PLAN_SUFFIX),
      )
      .map((e) => ({
        path: e.path,
        id: e.name.slice(PLAN_PREFIX.length, -PLAN_SUFFIX.length),
      }));

    const out: PlanSummary[] = [];
    await Promise.all(
      candidates.map(async (c) => {
        let nodes: PlanNode[] = [];
        let malformed = false;
        try {
          const r = await readProjectText({
            path: c.path,
            cwd,
            maxBytes: 4_000_000,
          });
          if (r.text) {
            try {
              const parsed = JSON.parse(r.text) as {
                id?: string;
                nodes?: PlanNode[];
              };
              if (parsed && Array.isArray(parsed.nodes)) nodes = parsed.nodes;
              else malformed = true;
            } catch {
              malformed = true;
            }
          }
        } catch {
          malformed = true;
        }
        out.push({ id: c.id, nodes, malformed });
      }),
    );

    // UUIDs are time-ordered in practice — newest first.
    out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return out;
  } catch {
    return [];
  }
}

function PlanView({
  cwd,
  open,
  planId,
}: {
  cwd: string | null;
  open: boolean;
  planId?: string | null;
}) {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(planId ?? null);

  const tick = useCallback(async () => {
    if (!cwd) {
      setPlans([]);
      return;
    }
    const list = await listPlans(cwd);
    setPlans(list);
    setSelectedId((cur) => {
      if (planId && list.some((p) => p.id === planId)) return planId;
      if (cur && list.some((p) => p.id === cur)) return cur;
      return list[0]?.id ?? null;
    });
  }, [cwd, planId]);

  useEffect(() => {
    if (!open) return;
    void tick();
    const handle = setInterval(() => void tick(), PLAN_POLL_MS);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cwd, planId]);

  const selected = useMemo(
    () => plans.find((p) => p.id === selectedId) ?? null,
    [plans, selectedId],
  );

  if (!cwd) {
    return <div className="workbench-empty">Open a folder to read saved plans.</div>;
  }

  if (plans.length === 0) {
    return (
      <div className="workbench-empty">
        No saved plans yet. Switch to the <code>plan</code> phase with Kraken graph on to write one to{" "}
        <code>.zelari/radio/</code>.
      </div>
    );
  }

  return (
    <div className="plan-view">
      <nav className="plan-view-list" aria-label="Saved plans">
        {plans.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`plan-view-item${p.id === selectedId ? " active" : ""}${p.malformed ? " is-malformed" : ""}`}
            onClick={() => setSelectedId(p.id)}
            title={p.malformed ? "malformed JSON" : `${p.nodes.length} nodes`}
          >
            <span className="plan-view-id">
              {p.id.slice(0, 8)}
              {p.id.length > 8 ? "…" : ""}
            </span>
            <span className="plan-view-meta">
              {p.malformed
                ? "malformed"
                : `${p.nodes.length} node${p.nodes.length === 1 ? "" : "s"}`}
            </span>
          </button>
        ))}
      </nav>

      {selected && selected.malformed ? (
        <div className="workbench-empty">This plan file is malformed JSON.</div>
      ) : selected ? (
        <div className="plan-view-nodes">
          <div className="plan-view-nodes-head">
            <span>id</span>
            <span>kind</span>
            <span>label</span>
            <span>deps</span>
          </div>
          <ul className="plan-view-nodes-list">
            {selected.nodes.map((n) => (
              <li key={n.id} className="plan-view-node">
                <code className="plan-view-node-id">{n.id}</code>
                <span className="plan-view-node-kind">{n.kind ?? "—"}</span>
                <span className="plan-view-node-label" title={n.label ?? ""}>
                  {n.label ?? ""}
                </span>
                <span className="plan-view-node-deps">
                  {n.deps && n.deps.length > 0 ? n.deps.join(", ") : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tasks view — session todos from the parent agent                   */
/* ------------------------------------------------------------------ */

function TasksView({ todos }: { todos: DesktopTodo[] }) {
  if (!todos.length) {
    return (
      <div className="workbench-empty">
        No session tasks yet. They appear when the agent calls <code>todo_write</code>.
      </div>
    );
  }
  return <SessionTodosPanel todos={todos} />;
}
