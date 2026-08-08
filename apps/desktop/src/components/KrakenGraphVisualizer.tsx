/**
 * KrakenGraphVisualizer - DAG-style rendering of the live Kraken run.
 *
 * MVP scope: read the workbench Markdown, extract the Wave table, and
 * render each node as a colored box grouped by approximate wave. We do
 * NOT render dependency edges (the workbench file does not include
 * `deps`) — adding them is a Slice N+1 that needs the planner to emit
 * deps into the workbench table.
 *
 * Color mapping (kind → palette):
 *   explore      blue   (read-only research)
 *   general      green  (the writers)
 *   verify       amber  (the gate)
 *   spec         red    (spec reviewer)
 *   conformance  purple (literal reviewer)
 *   fix          orange (rework spawned by a FAIL)
 *   merge        cyan   (worktree merge)
 *   other        gray
 *
 * Status mapping (status → icon + opacity):
 *   pending   ○
 *   running   ↑  (animated pulse)
 *   done      ✓
 *   error     ✗
 *   skipped   –
 *
 * Weakness column is surfaced via a tiny dot beside the node label
 * (green/amber/red) for verify/spec/conformance rows. Same buckets
 * as <WeaknessBadge>.
 *
 * @since v1.31.x - Bennett's Razor UI surface (Slice N / desktop)
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listDir, readProjectText } from "../agentClient";
import { WeaknessBadge } from "./WeaknessBadge";

interface Props {
  /** Project root. */
  cwd: string | null;
  /** Whether the panel is visible. When false, polling is paused. */
  open: boolean;
  /** Close handler (currently a no-op since we render inline). */
  onClose?: () => void;
}

interface WaveRow {
  id: string;
  label: string;
  kind: string;
  deps: string;
  scope: string;
  status: string;
  verdict: string;
  weaknessScore: string;
  model: string;
  duration: string;
}

interface Node {
  id: string;
  label: string;
  kind: string;
  deps: string[];
  scope: string;
  status: string;
  verdict: string;
  weaknessScore: number | null;
  model: string;
  duration: string;
  /** Index into the table — used as a stable proxy for "wave" since the
   *  workbench file does not emit wave ids in v1.31.x. */
  order: number;
}

const POLL_INTERVAL_MS = 1500;
const WORKBENCH_DIR = ".zelari/radio";
const WORKBENCH_PREFIX = "workbench-";
const WORKBENCH_SUFFIX = ".md";

async function findLatestWorkbench(cwd: string): Promise<string | null> {
  try {
    const res = await listDir({ path: WORKBENCH_DIR, cwd });
    if (res.error) return null;
    const candidates = res.entries
      .filter(
        (e) =>
          !e.isDir &&
          e.name.startsWith(WORKBENCH_PREFIX) &&
          e.name.endsWith(WORKBENCH_SUFFIX),
      )
      .map((e) => e.path)
      .sort()
      .reverse();
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract the Wave table from the workbench Markdown and parse it into
 * structured rows. Mirrors the row layout that `WorkbenchWriter.render`
 * emits: `| id | label | kind | scope | status | verdict | weakness | model | duration |`.
 *
 * Returns [] when the table is missing or malformed.
 */
function parseWaveTable(md: string): WaveRow[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|[\s-:|]+\|/.test(lines[i + 1] ?? "")
    ) {
      // Found a table. Decide if it's the Wave table by looking at the
      // header. The header is the first row of the table.
      const splitRow = (raw: string): string[] => {
        let s = raw.trim();
        if (s.startsWith("|")) s = s.slice(1);
        if (s.endsWith("|")) s = s.slice(0, -1);
        return s.split("|").map((c) => c.trim());
      };
      const header = splitRow(line).map((h) => h.toLowerCase());
      if (header.includes("verdict") && header.includes("weakness")) {
        i += 2; // skip header + separator
        const rows: WaveRow[] = [];
        // Header layout (v1.31.x+): id | label | kind | deps | scope | status | verdict | weakness | model | duration
        // Pre-deps layout (legacy):    id | label | kind |      scope | status | verdict | weakness | model | duration
        // Detect by the presence of the deps column header.
        const hasDeps = header.includes("deps");
        const idCol = 0;
        const labelCol = 1;
        const kindCol = 2;
        const scopeCol = hasDeps ? 4 : 3;
        const statusCol = hasDeps ? 5 : 4;
        const verdictCol = hasDeps ? 6 : 5;
        const weaknessCol = hasDeps ? 7 : 6;
        const modelCol = hasDeps ? 8 : 7;
        const durationCol = hasDeps ? 9 : 8;
        const depsCol = hasDeps ? 3 : -1;
        while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
          const cells = splitRow(lines[i]!);
          rows.push({
            id: cells[idCol] ?? "",
            label: cells[labelCol] ?? "",
            kind: cells[kindCol] ?? "",
            deps: depsCol >= 0 ? (cells[depsCol] ?? "") : "",
            scope: cells[scopeCol] ?? "",
            status: cells[statusCol] ?? "",
            verdict: cells[verdictCol] ?? "",
            weaknessScore: cells[weaknessCol] ?? "",
            model: cells[modelCol] ?? "",
            duration: cells[durationCol] ?? "",
          });
          i++;
        }
        return rows;
      }
      // Not the wave table; skip the block and keep searching.
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") i++;
      continue;
    }
    i++;
  }
  return [];
}

const KIND_COLORS: Record<string, { bg: string; border: string; label: string }> = {
  explore:     { bg: "rgba(80, 150, 230, 0.15)",  border: "rgba(80, 150, 230, 0.55)", label: "explore" },
  general:     { bg: "rgba(60, 180, 110, 0.15)",  border: "rgba(60, 180, 110, 0.55)", label: "general" },
  verify:      { bg: "rgba(220, 160, 60, 0.15)",  border: "rgba(220, 160, 60, 0.55)", label: "verify" },
  spec:        { bg: "rgba(220, 70, 70, 0.15)",   border: "rgba(220, 70, 70, 0.55)",  label: "spec" },
  conformance: { bg: "rgba(150, 80, 200, 0.15)",  border: "rgba(150, 80, 200, 0.55)", label: "conform" },
  fix:         { bg: "rgba(230, 130, 50, 0.15)",  border: "rgba(230, 130, 50, 0.55)", label: "fix" },
  merge:       { bg: "rgba(60, 200, 200, 0.15)",  border: "rgba(60, 200, 200, 0.55)", label: "merge" },
};

const STATUS_ICONS: Record<string, string> = {
  pending: "○",
  running: "↑",
  done: "✓",
  error: "✗",
  skipped: "–",
};

function weaknessDot(score: number | null): { color: string; label: string } | null {
  if (score == null) return null;
  if (score < 0.4) return { color: "#2da567", label: "tight" };
  if (score < 0.7) return { color: "#d99a2b", label: "medium" };
  return { color: "#c34a4a", label: "loose" };
}

function parseWeaknessScore(text: string): number | null {
  if (!text || text === "") return null;
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/**
 * Render an SVG overlay with one straight line per dependency edge.
 * Anchors are at the geometric center of each node card; the SVG is
 * positioned absolutely over the .kraken-graph-nodes container, so we
 * can use container-relative coordinates without a full layout pass.
 *
 * Edges are drawn in `from upstream -> to dependent` direction (left
 * -> right, since upstream nodes appear earlier in the table). The
 * arrowhead is a small triangle at the dependent end.
 *
 * The function is intentionally re-rendered on every tick — the cost
 * is `O(edges) * getBoundingClientRect`, which is ~rect reads that the
 * browser has already cached. With < 200 nodes this stays sub-millisecond.
 */
function renderEdges(
  nodes: readonly Node[],
  refs: Map<string, HTMLDivElement | null>,
): ReactNode {
  if (nodes.length === 0) return null;
  const container = refs.get("__container__");
  if (!container) return null;
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  if (cw === 0 || ch === 0) return null;

  // Compute center points in container-relative coordinates.
  type Pt = { x: number; y: number };
  const centers = new Map<string, Pt>();
  for (const n of nodes) {
    const el = refs.get(n.id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    centers.set(n.id, { x: r.left - cr.left + r.width / 2, y: r.top - cr.top + r.height / 2 });
  }

  // Edges: every (n, d) pair where d is upstream of n.
  type Edge = { from: Pt; to: Pt; key: string };
  const edges: Edge[] = [];
  for (const n of nodes) {
    for (const dep of n.deps) {
      const from = centers.get(dep);
      const to = centers.get(n.id);
      if (!from || !to) continue;
      edges.push({ from, to, key: `${dep}->${n.id}` });
    }
  }
  if (edges.length === 0) return null;

  return (
    <svg
      className="kraken-graph-edges"
      width={cw}
      height={ch}
      viewBox={`0 0 ${cw} ${ch}`}
      aria-hidden
    >
      <defs>
        <marker
          id="kraken-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      <g className="kraken-edge-layer">
        {edges.map((e) => (
          <line
            key={e.key}
            x1={e.from.x}
            y1={e.from.y}
            x2={e.to.x}
            y2={e.to.y}
            className="kraken-edge"
            markerEnd="url(#kraken-arrow)"
          />
        ))}
      </g>
    </svg>
  );
}

export function KrakenGraphVisualizer({ cwd, open, onClose }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Node | null>(null);
  const resolvedCwdRef = useRef<string | null>(null);
  // Map of node id -> bounding rect of the rendered card. Refreshed
  // by useLayoutEffect after every render + when the panel resizes.
  // Used to draw SVG edges (deps) between the card centers.
  const nodeRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const [layoutTick, setLayoutTick] = useState(0);

  // track resolvedCwdRef with a small wrapper so async race wins are safe
  // (re-uses the same pattern as WorkbenchLiveTail).
  useEffect(() => {
    if (!open || !cwd) {
      setPath(null);
      setBody("");
      return;
    }
    let alive = true;
    const tick = async (currentCwd: string) => {
      let p = path;
      if (!p) {
        p = await findLatestWorkbench(currentCwd);
        if (!alive || resolvedCwdRef.current !== currentCwd) return;
        if (!p) {
          setError("no workbench file found yet — start a Kraken run");
          setPath(null);
          return;
        }
        setPath(p);
        setError(null);
      }
      try {
        const res = await readProjectText({ path: p, cwd: currentCwd, maxBytes: 1_000_000 });
        if (!alive || resolvedCwdRef.current !== currentCwd) return;
        if (res.text) setBody(res.text);
        setError(null);
      } catch (e) {
        if (!alive || resolvedCwdRef.current !== currentCwd) return;
        setError(String(e));
      }
    };
    resolvedCwdRef.current = cwd;
    void tick(cwd);
    const handle = setInterval(() => void tick(cwd), POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cwd]);

  const nodes = useMemo<Node[]>(() => {
    const rows = parseWaveTable(body);
    return rows.map((r, i) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      deps: r.deps
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
      scope: r.scope,
      status: r.status,
      verdict: r.verdict,
      weaknessScore: parseWeaknessScore(r.weaknessScore),
      model: r.model,
      duration: r.duration,
      order: i,
    }));
  }, [body]);

  // Re-measure node positions after every render. The CSS grid lays
  // the cards out, but we need the rendered rectangles to draw
  // edges between centers. The tick state forces a re-render after
  // the layout effect; we don't actually use the rects in this
  // effect (we just kick the measurement).
  useLayoutEffect(() => {
    // The rects are read by renderEdges() via nodeRefs; we just need
    // to make sure the browser has painted before the SVG draws.
    // No-op body — the next render will read the live rects.
  }, [nodes, selected, layoutTick]);

  // Re-measure on resize / scroll. Cheap: O(n) rect reads, no
  // re-render — we just bump a tick so the next render uses fresh
  // positions.
  useEffect(() => {
    const container = nodeRefs.current.get("__container__");
    if (!container) return;
    const ro = new ResizeObserver(() => setLayoutTick((t) => t + 1));
    ro.observe(container);
    const onScroll = () => setLayoutTick((t) => t + 1);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      container.removeEventListener("scroll", onScroll);
    };
  }, [open, nodes.length]);

  if (!open) return null;

  // Empty state: tell the user the workbench is not live yet.
  const hasNodes = nodes.length > 0;

  return (
    <div className="kraken-graph-panel" role="region" aria-label="Kraken graph visualizer">
      <header className="kraken-graph-head">
        <div className="kraken-graph-title">
          <span className="kraken-graph-icon" aria-hidden>🕸️</span>
          <span>Kraken Graph</span>
        </div>
        {onClose ? (
          <button
            type="button"
            className="btn-ghost kraken-graph-close"
            onClick={onClose}
            aria-label="Close graph visualizer"
            title="Close"
          >
            ×
          </button>
        ) : null}
      </header>

      {error ? <div className="kraken-graph-error" role="alert">{error}</div> : null}

      {hasNodes ? (
        <div className="kraken-graph-body">
          <div
            className="kraken-graph-nodes"
            ref={(el) => {
              // The ref is the ResizeObserver target. Tagging with a
              // sentinel id keeps the Map shape uniform.
              if (el) nodeRefs.current.set("__container__", el as unknown as HTMLDivElement);
            }}
          >
            {renderEdges(nodes, nodeRefs.current)}
            {nodes.map((n) => {
              const palette = KIND_COLORS[n.kind] ?? KIND_COLORS["explore"]!;
              const paletteFallback = KIND_COLORS["explore"]!;
              const safe = palette ?? paletteFallback;
              const icon = STATUS_ICONS[n.status] ?? "○";
              const dot = weaknessDot(n.weaknessScore);
              return (
                <button
                  key={n.id}
                  type="button"
                  className={`kraken-node kraken-node-${n.status}`}
                  style={{ background: safe.bg, borderColor: safe.border }}
                  onClick={() => setSelected(n)}
                  title={`${n.id} · ${n.label} · ${n.kind}`}
                  ref={(el) => {
                    if (el) nodeRefs.current.set(n.id, el as unknown as HTMLDivElement);
                  }}
                >
                  <div className="kraken-node-head">
                    <span className="kraken-node-status" aria-hidden>{icon}</span>
                    <span className="kraken-node-kind">{safe.label}</span>
                    {dot ? (
                      <span
                        className="kraken-node-weakness"
                        style={{ background: dot.color }}
                        title={`Bennett weakness ${n.weaknessScore?.toFixed(2)} (${dot.label})`}
                        aria-label={`Weakness ${n.weaknessScore?.toFixed(2)} ${dot.label}`}
                      />
                    ) : null}
                  </div>
                  <div className="kraken-node-id">{n.id}</div>
                  <div className="kraken-node-label">{n.label}</div>
                  {n.deps.length > 0 ? (
                    <div
                      className="kraken-node-deps"
                      title={`depends on: ${n.deps.join(", ")}`}
                    >
                      <span className="kraken-node-deps-arrow" aria-hidden>←</span>
                      <span className="kraken-node-deps-list">
                        {n.deps.length <= 3
                          ? n.deps.join(", ")
                          : `${n.deps.slice(0, 2).join(", ")}, +${n.deps.length - 2}`}
                      </span>
                    </div>
                  ) : null}
                  {n.scope ? (
                    <div className="kraken-node-scope" title={n.scope}>
                      {n.scope.length > 28 ? `${n.scope.slice(0, 28)}…` : n.scope}
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>

          <aside className={`kraken-graph-side${selected ? " is-open" : ""}`}>
            {selected ? (
              <div className="kraken-side-card">
                <header className="kraken-side-head">
                  <div>
                    <div className="kraken-side-kind">
                      {(KIND_COLORS[selected.kind] ?? KIND_COLORS["explore"]!).label}
                    </div>
                    <div className="kraken-side-id">{selected.id}</div>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost kraken-side-close"
                    onClick={() => setSelected(null)}
                    aria-label="Close details"
                  >
                    ×
                  </button>
                </header>
                <h3 className="kraken-side-label">{selected.label}</h3>
                {selected.scope ? (
                  <div className="kraken-side-row">
                    <span className="kraken-side-key">scope</span>
                    <code>{selected.scope}</code>
                  </div>
                ) : null}
                {selected.deps.length > 0 ? (
                  <div className="kraken-side-row">
                    <span className="kraken-side-key">deps</span>
                    <code>{selected.deps.join(", ")}</code>
                  </div>
                ) : null}
                <div className="kraken-side-row">
                  <span className="kraken-side-key">status</span>
                  <span>
                    {STATUS_ICONS[selected.status] ?? "?"} {selected.status}
                  </span>
                </div>
                {selected.verdict ? (
                  <div className="kraken-side-row">
                    <span className="kraken-side-key">verdict</span>
                    <span>
                      {selected.verdict}
                      {typeof selected.weaknessScore === "number" ? (
                        <>
                          {" "}
                          · w={selected.weaknessScore.toFixed(2)}
                        </>
                      ) : null}
                    </span>
                  </div>
                ) : null}
                {selected.verdict ? (
                  <div className="kraken-side-row kraken-side-row-weakness">
                    <span className="kraken-side-key">persona</span>
                    <WeaknessBadge text={`Findings that the reviewer wrote.\n\nVERDICT: ${selected.verdict.toUpperCase()}`} weaknessScore={selected.weaknessScore ?? undefined} />
                  </div>
                ) : null}
                {selected.model ? (
                  <div className="kraken-side-row">
                    <span className="kraken-side-key">model</span>
                    <code>{selected.model}</code>
                  </div>
                ) : null}
                {selected.duration ? (
                  <div className="kraken-side-row">
                    <span className="kraken-side-key">duration</span>
                    <span>{selected.duration}</span>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="kraken-side-empty">
                <span className="kraken-side-empty-icon" aria-hidden>👆</span>
                <span>Click a node to see details</span>
              </div>
            )}
          </aside>
        </div>
      ) : (
        <div className="kraken-graph-empty">
          The workbench is empty. Start a Kraken run and the live DAG will
          appear here.
        </div>
      )}

      <footer className="kraken-graph-foot">
        <span>
          {hasNodes ? `${nodes.length} node${nodes.length === 1 ? "" : "s"}` : "no nodes yet"}
        </span>
        <span className="kraken-graph-foot-sep">·</span>
        <span>{path ? path.split(/[\\/]/).pop() : "no file"}</span>
        <span className="kraken-graph-foot-sep">·</span>
        <span>1.5s poll</span>
      </footer>
    </div>
  );
}
