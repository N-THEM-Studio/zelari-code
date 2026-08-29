import { useCallback, useEffect, useRef, useState } from "react";
import {
  queryMemory,
  type MemoryDetailResponse,
  type MemoryNodeDto,
  type MemoryRecallDto,
  type MemorySearchResponse,
} from "../agentClient";

interface Props {
  cwd: string | null;
  refreshKey?: number;
  onStatus?: (message: string) => void;
}

const KINDS = [
  "all", "fact", "decision", "constraint", "finding", "failure",
  "procedure", "verification", "hypothesis", "preference", "artifact",
];

function shortDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function sourceText(node: MemoryNodeDto): string {
  const entries = Object.entries(node.source).filter(([, value]) => value);
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(" · ") : "unknown";
}

function Score({ node, score }: { node: MemoryNodeDto; score?: number }) {
  return (
    <span className="memory-score" title="importance / confidence / retrieval score">
      I {node.importance.toFixed(2)} · C {node.confidence.toFixed(2)}
      {score !== undefined ? ` · R ${score.toFixed(2)}` : ""}
    </span>
  );
}

export function MemoryExplorer({ cwd, refreshKey = 0, onStatus }: Props) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [results, setResults] = useState<MemoryRecallDto[]>([]);
  const [stats, setStats] = useState<MemorySearchResponse["stats"]>();
  const [selected, setSelected] = useState<MemoryDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const search = useCallback(async () => {
    if (!cwd) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const response = await queryMemory<MemorySearchResponse>(cwd, {
        operation: "search",
        query,
        limit: 40,
        ...(kind !== "all" ? { kinds: [kind] } : {}),
        useGraph: true,
      });
      if (id !== requestId.current) return;
      if (!response.ok) throw new Error(response.error ?? "Memory search failed");
      setResults(response.results ?? []);
      setStats(response.stats);
      if (response.warnings?.length) onStatus?.(response.warnings.join(" · "));
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setResults([]);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [cwd, kind, onStatus, query]);

  const openDetail = useCallback(async (memoryId: string) => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const response = await queryMemory<MemoryDetailResponse>(cwd, {
        operation: "detail",
        memoryId,
      });
      if (!response.ok || !response.node) throw new Error(response.error ?? "Memory not found");
      setSelected(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setSelected(null);
    setResults([]);
    setError(null);
    if (cwd) void search();
  }, [cwd, refreshKey]); // search intentionally runs on explicit refresh/cwd only

  if (!cwd) return <div className="git-muted pad">Open a folder to explore project memory.</div>;

  if (selected?.node) {
    const node = selected.node;
    return (
      <div className="memory-explorer memory-detail">
        <button type="button" className="memory-back" onClick={() => setSelected(null)}>← Results</button>
        <div className="memory-detail-head">
          <div>
            <span className={`memory-kind kind-${node.kind}`}>{node.kind}</span>
            <span className={`memory-state state-${node.status}`}>{node.status}</span>
            <span className="memory-visibility">{node.visibility}</span>
          </div>
          <Score node={node} />
        </div>
        <div className="memory-content">{node.content}</div>
        <section className="memory-section">
          <h4>Provenance</h4>
          <div>{sourceText(node)}</div>
          <div>Created {shortDate(node.createdAt)} · updated {shortDate(node.updatedAt)}</div>
          {node.tags.length ? <div>Tags: {node.tags.join(", ")}</div> : null}
        </section>
        <section className="memory-section">
          <h4>Relations ({selected.related?.length ?? 0})</h4>
          {selected.related?.length ? selected.related.map(({ edge, node: related }) => (
            <button key={edge.id} type="button" className="memory-related" onClick={() => void openDetail(related.id)}>
              <span>{edge.from === node.id ? "→" : "←"} {edge.relation}</span>
              <span>{related.kind} · {related.content.slice(0, 110)}{related.content.length > 110 ? "…" : ""}</span>
            </button>
          )) : <div className="memory-empty">No typed relations.</div>}
        </section>
        <section className="memory-section">
          <h4>History ({selected.history?.length ?? 0})</h4>
          <ol className="memory-timeline">
            {selected.history?.map((version) => (
              <li key={version.versionId}>
                <div>r{version.revision} · {version.snapshot.status}</div>
                <small>{shortDate(version.recordedAt)} · {version.actor ?? "unknown"} · {version.reason ?? "updated"}</small>
              </li>
            ))}
          </ol>
        </section>
      </div>
    );
  }

  return (
    <div className="memory-explorer">
      <form className="memory-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search project memory…" aria-label="Search project memory" />
        <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Memory kind">
          {KINDS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button type="submit" disabled={loading}>{loading ? "…" : "Search"}</button>
      </form>
      {stats ? (
        <div className="memory-summary">
          {stats.active}/{stats.nodes} active · {stats.edges} edges · semantic {stats.semanticIndex}
          {stats.semanticModel ? ` · ${stats.semanticIndexed ?? 0} indexed` : ""}
        </div>
      ) : null}
      {error ? <div className="memory-error">{error}</div> : null}
      {!loading && !error && results.length === 0 ? (
        <div className="memory-empty">
          {stats && stats.nodes > 0
            ? query.trim() || kind !== "all"
              ? "No matching memories — try a different query or kind."
              : `${stats.nodes} memories stored — type a query to search them.`
            : "Memory is empty for this project. Memories (decisions, findings, failures) are captured automatically while the agent works — run a task and check back."}
        </div>
      ) : null}
      <div className="memory-results">
        {results.map(({ node, score }) => (
          <button key={node.id} type="button" className="memory-result" onClick={() => void openDetail(node.id)}>
            <div className="memory-result-head">
              <span className={`memory-kind kind-${node.kind}`}>{node.kind}</span>
              <span className={`memory-state state-${node.status}`}>{node.status}</span>
              <Score node={node} score={score} />
            </div>
            <div className="memory-result-content">{node.content}</div>
            <small>{sourceText(node)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
