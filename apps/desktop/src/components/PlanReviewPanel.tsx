/**
 * PlanReviewPanel - pre-flight plan review for the desktop (Slice N+4).
 *
 * Reads `.zelari/radio/plan-*.json` files (written by `--plan-only` /
 * `ZELARI_KRAKEN_PLAN_ONLY=1` in the headless flow), shows the graph
 * inline, and offers an "Approve & Run" affordance via copy-to-clipboard
 * of the `zelari-code --run-plan <id>` invocation. The user pastes
 * the command in a terminal (or runs it via the existing shell tool).
 *
 * The "execute from the GUI" path would need a new Tauri command that
 * spawns `zelari-code` as a child process; we deliberately do NOT
 * add it here, because spawning a long-running child from a Tauri
 * window is a separate UX / lifecycle design (cancel, status stream,
 * re-attach on window focus). The copy-to-clipboard is a clean MVP
 * that ships the user-facing capability without those costs.
 *
 * @since v1.31.x - Bennett's Razor UI surface (Slice N / desktop)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { listDir, readProjectTextIfChanged, type FileSignature } from "../agentClient";

interface Props {
  /** Project root. */
  cwd: string | null;
  /** Whether the panel is open. */
  open: boolean;
  /** Close handler. */
  onClose: () => void;
}

interface PlanSummary {
  id: string;
  /** Path of the .json file under .zelari/radio/. */
  path: string;
  /** Plan contents parsed from disk. */
  graph: { id: string; nodes: PlanNode[] } | null;
  /** Wall-clock of the file's last write — the most-recent plan first. */
  mtimeMs: number;
  /** True when the JSON couldn't be parsed. */
  malformed: boolean;
}

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

const PLAN_DIR = ".zelari/radio";
const PLAN_PREFIX = "plan-";
const PLAN_SUFFIX = ".json";
const POLL_INTERVAL_MS = 2000;

/** Per-path cache: last file signature + parsed summary (poll-skip). */
const planFileCache = new Map<string, { sig: FileSignature; entry: PlanSummary }>();

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
        name: e.name,
        id: e.name.slice(PLAN_PREFIX.length, -PLAN_SUFFIX.length),
      }));
    // Read each file to populate the summary. We do this in parallel;
    // a malformed entry is still listed (with the malformed flag).
    // Poll-skip: when a file's signature (mtimeMs+size) is unchanged we
    // reuse the cached summary and skip JSON.parse + entry rebuild.
    const out: PlanSummary[] = [];
    await Promise.all(
      candidates.map(async (c) => {
        const cached = planFileCache.get(c.path);
        const fresh = await readProjectTextIfChanged(
          { path: c.path, cwd, maxBytes: 4_000_000 },
          cached ? cached.sig : null,
        ).catch(() => null);
        if (fresh) {
          const r = fresh.res;
          let graph: PlanSummary["graph"] = null;
          let malformed = false;
          if (r.text) {
            try {
              const parsed = JSON.parse(r.text) as { id?: string; nodes?: PlanNode[] };
              if (parsed && Array.isArray(parsed.nodes)) {
                graph = { id: parsed.id ?? c.id, nodes: parsed.nodes };
              } else {
                malformed = true;
              }
            } catch {
              malformed = true;
            }
          } else {
            malformed = true;
          }
          const entry: PlanSummary = {
            id: c.id,
            path: c.path,
            graph,
            mtimeMs: r.mtimeMs || Date.now(),
            malformed,
          };
          planFileCache.set(c.path, { sig: fresh.sig, entry });
          out.push(entry);
        } else if (cached) {
          // Unchanged signature (or read error): reuse the last summary.
          out.push(cached.entry);
        } else {
          out.push({ id: c.id, path: c.path, graph: null, mtimeMs: 0, malformed: true });
        }
      }),
    );
    // Sort by file name (UUIDs are time-ordered in practice) so the
    // most recent plan is at the top.
    out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return out;
  } catch {
    return [];
  }
}

function buildRunCommand(planId: string): string {
  return `zelari-code --run-plan ${planId} --task "your goal here" --headless`;
}

export function PlanReviewPanel({ cwd, open, onClose }: Props) {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedFor, setCopiedFor] = useState<string | null>(null);

  const tick = useCallback(async () => {
    if (!cwd) {
      setPlans([]);
      return;
    }
    const list = await listPlans(cwd);
    setPlans(list);
    setSelectedId((cur) => {
      if (cur && list.some((p) => p.id === cur)) return cur;
      return list[0]?.id ?? null;
    });
    setError(null);
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    void tick();
    const handle = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => clearInterval(handle);
    // We intentionally re-create the interval when `cwd` flips: the
    // tick closure depends on `cwd`, and re-creating keeps the
    // dependency bookkeeping simple.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cwd]);

  const selected = useMemo(
    () => plans.find((p) => p.id === selectedId) ?? null,
    [plans, selectedId],
  );

  const onCopy = useCallback(async (planId: string) => {
    const cmd = buildRunCommand(planId);
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedFor(planId);
      setTimeout(() => setCopiedFor((cur) => (cur === planId ? null : cur)), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context). Fall back to a
      // visible <pre> the user can copy manually.
      setCopiedFor(`__selectable__:${planId}`);
    }
  }, []);

  if (!open) return null;

  return (
    <aside className="plan-review-panel" role="complementary" aria-label="Kraken plan review">
      <header className="plan-review-head">
        <div className="plan-review-title">
          <span className="plan-review-icon" aria-hidden>📝</span>
          <span>Pre-Flight Plan Review</span>
        </div>
        <button
          type="button"
          className="btn-ghost plan-review-close"
          onClick={onClose}
          aria-label="Close plan review"
          title="Close"
        >
          ×
        </button>
      </header>

      {error ? <div className="plan-review-error" role="alert">{error}</div> : null}

      <div className="plan-review-body">
        {plans.length === 0 ? (
          <div className="plan-review-empty">
            <p>
              No saved plans yet. Run the CLI with{" "}
              <code>--plan-only</code> or{" "}
              <code>ZELARI_KRAKEN_PLAN_ONLY=1</code> to write a plan to{" "}
              <code>.zelari/radio/plan-&lt;id&gt;.json</code>, then come back here to review and run it.
            </p>
            <p className="plan-review-hint">
              A pre-flight plan lets you read the graph the planner will execute
              before any tentacle runs. Nothing happens until you paste the
              <code> --run-plan </code> command in a terminal.
            </p>
          </div>
        ) : (
          <>
            <nav className="plan-review-list" aria-label="Saved plans">
              {plans.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`plan-review-list-item${p.id === selectedId ? " active" : ""}${p.malformed ? " is-malformed" : ""}`}
                  onClick={() => setSelectedId(p.id)}
                  title={p.malformed ? "malformed JSON" : `${p.graph?.nodes.length ?? 0} nodes`}
                >
                  <span className="plan-review-list-id">
                    {p.id.slice(0, 8)}
                    <span className="plan-review-list-id-tail">
                      {p.id.length > 8 ? p.id.slice(-4) : ""}
                    </span>
                  </span>
                  <span className="plan-review-list-meta">
                    {p.malformed
                      ? "malformed"
                      : `${p.graph?.nodes.length ?? 0} node${(p.graph?.nodes.length ?? 0) === 1 ? "" : "s"}`}
                  </span>
                </button>
              ))}
            </nav>

            {selected ? (
              <div className="plan-review-detail">
                <div className="plan-review-detail-head">
                  <code className="plan-review-plan-id">{selected.id}</code>
                  <button
                    type="button"
                    className={`plan-review-approve${copiedFor === selected.id ? " is-copied" : ""}`}
                    onClick={() => void onCopy(selected.id)}
                    title="Copy the `zelari-code --run-plan <id>` command to the clipboard"
                  >
                    {copiedFor === selected.id
                      ? "✓ Copied"
                      : "📋 Approve & copy run command"}
                  </button>
                </div>
                {copiedFor === `__selectable__:${selected.id}` ? (
                  <pre className="plan-review-fallback" aria-label="run command (copy manually)">
                    {buildRunCommand(selected.id)}
                  </pre>
                ) : null}
                {selected.malformed ? (
                  <div className="plan-review-malformed">
                    The plan file is malformed JSON and cannot be reviewed.
                  </div>
                ) : (
                  <PlanNodeList plan={selected} />
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      <footer className="plan-review-foot">
        <span>{plans.length} saved plan{plans.length === 1 ? "" : "s"}</span>
        <span className="plan-review-foot-sep">·</span>
        <span>2s poll</span>
        <span className="plan-review-foot-sep">·</span>
        <span>no execution from the GUI (yet)</span>
      </footer>
    </aside>
  );
}

function PlanNodeList({ plan }: { plan: PlanSummary }) {
  if (!plan.graph) return null;
  const nodes = plan.graph.nodes;
  return (
    <div className="plan-review-nodes">
      <div className="plan-review-nodes-head">
        <span>id</span>
        <span>kind</span>
        <span>label</span>
        <span>deps</span>
      </div>
      <ul className="plan-review-nodes-list">
        {nodes.map((n) => (
          <li key={n.id} className="plan-review-node">
            <code className="plan-review-node-id">{n.id}</code>
            <span className="plan-review-node-kind">{n.kind ?? "—"}</span>
            <span className="plan-review-node-label" title={n.label ?? ""}>
              {n.label ?? ""}
            </span>
            <span className="plan-review-node-deps">
              {n.deps && n.deps.length > 0 ? n.deps.join(", ") : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
