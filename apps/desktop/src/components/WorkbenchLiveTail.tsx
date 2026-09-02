/**
 * WorkbenchLiveTail - live tail of the Kraken workbench file.
 *
 * Reads `<cwd>/.zelari/radio/workbench-<id>.md` on a polling timer and
 * renders it as a self-contained Markdown subset. The Kraken engine writes
 * this file via `WorkbenchWriter` (debounced 500ms, atomic rename); we
 * poll every 1500ms here so the UI stays fresh without thrashing IPC.
 *
 * The renderer understands only the constructs the workbench actually
 * emits: headings, paragraphs, bold spans, tables, and a single fenced
 * block. Anything else falls through as raw text. This keeps the bundle
 * dependency-free (no react-markdown) at the cost of fidelity.
 *
 * @since v1.31.x - Bennett's Razor UI surface (Slice N / desktop)
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listDir, readProjectTextIfChanged } from "../agentClient";

interface Props {
  /** Project root (must match the run's cwd). When null, the panel is inert. */
  cwd: string | null;
  /** Whether the panel is open. When false, polling is paused to save cycles. */
  open: boolean;
}

interface State {
  /** Path of the workbench file we are currently tailing. */
  path: string | null;
  /** Raw markdown content. */
  body: string;
  /** When the body was last successfully fetched. */
  fetchedAt: number | null;
  /** True when we are actively polling (vs. waiting for a run to appear). */
  watching: boolean;
  /** Last error message, if any. Cleared on the next successful fetch. */
  error: string | null;
}

const POLL_INTERVAL_MS = 1500;
const WORKBENCH_DIR = ".zelari/radio";
const WORKBENCH_PREFIX = "workbench-";
const WORKBENCH_SUFFIX = ".md";

/**
 * Find the most recent workbench file in `<cwd>/.zelari/radio/`. Returns
 * `null` when no such file exists or the directory is unreachable.
 *
 * Sorting strategy: by mtime would be ideal, but `listDir` returns
 * name/path/isDir only. We sort lexicographically descending — that
 * works because Kraken's `workbench-<id>.md` ids are time-ordered
 * (`crypto.randomUUID()`-derived; new runs have lexicographically
 * greater ids in practice). If that ever stops holding, swap to a
 * stat-based sort by adding size/mtime to DirEntryDto.
 */
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
 * Render a tiny subset of Markdown. Lines starting with `## ` are H2,
 * `| ... |` are table rows, lines starting with `- ` are list items.
 * Inline `**bold**` is honoured. Everything else is plain text.
 *
 * Not a real Markdown parser; it does not handle nested lists, code
 * fences with language tags beyond `text`, or escape sequences. That's
 * intentional: the workbench file is fully under our control and uses
 * a fixed grammar.
 */
function renderMiniMarkdown(src: string): ReactNode {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const inline = (raw: string): ReactNode[] => {
    // Replace **bold** with <strong>. No nested formatting.
    const parts: ReactNode[] = [];
    const re = /\*\*(.+?)\*\*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let sub = 0;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) parts.push(<span key={`t-${sub++}`}>{raw.slice(last, m.index)}</span>);
      parts.push(<strong key={`b-${sub++}`}>{m[1]}</strong>);
      last = m.index + m[0].length;
    }
    if (last < raw.length) parts.push(<span key={`t-${sub++}`}>{raw.slice(last)}</span>);
    return parts;
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block: ```...``` (workbench emits one for "no events yet")
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        body.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      out.push(
        <pre key={`code-${key++}`} className="wb-code">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // H1 / H2 / H3
    const hm = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hm) {
      const level = Math.min(hm[1]!.length, 3);
      out.push(
        <div key={`h-${key++}`} className={`wb-h wb-h${level}`}>
          {inline(hm[2]!)}
        </div>,
      );
      i++;
      continue;
    }

    // Table row. The workbench emits a 3-line block: header, separator,
    // body rows. We collect them as one <table> per contiguous block.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|[\s-:|]+\|/.test(lines[i + 1] ?? "")) {
      const splitRow = (raw: string): string[] => {
        let s = raw.trim();
        if (s.startsWith("|")) s = s.slice(1);
        if (s.endsWith("|")) s = s.slice(0, -1);
        return s.split("|").map((c) => c.trim());
      };
      const header = splitRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      out.push(
        <div key={`tbl-${key++}`} className="wb-table-wrap">
          <table className="wb-table">
            <thead>
              <tr>{header.map((h, j) => <th key={j}>{inline(h)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => <td key={ci}>{inline(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // List item
    if (/^\s*-\s+/.test(line)) {
      out.push(
        <div key={`li-${key++}`} className="wb-li">
          {inline(line.replace(/^\s*-\s+/, ""))}
        </div>,
      );
      i++;
      continue;
    }

    // Blank
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Default: paragraph
    out.push(
      <div key={`p-${key++}`} className="wb-p">
        {inline(line)}
      </div>,
    );
    i++;
  }
  return <>{out}</>;
}

export function WorkbenchLiveTail({ cwd, open }: Props) {
  const [state, setState] = useState<State>({
    path: null,
    body: "",
    fetchedAt: null,
    watching: false,
    error: null,
  });
  // Track the currently-resolved path across async ticks so a stale
  // resolve doesn't stomp a newer one.
  const resolvedCwdRef = useRef<string | null>(null);
  // Last-read file signature (mtimeMs+size). The tail polls every
  // ~1500ms; when the signature is unchanged we skip setState entirely
  // instead of re-rendering identical content.
  const sigRef = useRef<string | null>(null);

  const tick = useCallback(async () => {
    if (!cwd) {
      setState((s) => ({ ...s, watching: false, path: null, body: "", error: null }));
      return;
    }
    const currentCwd = cwd;
    resolvedCwdRef.current = currentCwd;

    let path = state.path;
    if (!path) {
      path = await findLatestWorkbench(currentCwd);
      if (resolvedCwdRef.current !== currentCwd) return; // cwd changed mid-tick
      if (!path) {
        setState((s) => ({
          ...s,
          watching: true,
          path: null,
          body: s.path === null ? "(no workbench file found yet — start a Kraken run)" : s.body,
          error: null,
        }));
        return;
      }
      sigRef.current = null; // new file discovered: force a full fetch
    }

    try {
      const fresh = await readProjectTextIfChanged(
        { path, cwd: currentCwd, maxBytes: 1_000_000 },
        sigRef.current,
      );
      if (resolvedCwdRef.current !== currentCwd) return;
      if (!fresh) return; // signature unchanged: skip parse + setState
      sigRef.current = fresh.sig;
      const res = fresh.res;
      if (res.isDir || res.text == null) {
        setState((s) => ({
          ...s,
          watching: true,
          path,
          fetchedAt: Date.now(),
          body: s.body,
          error: res.note ?? "no content",
        }));
        return;
      }
      setState((s) => ({
        ...s,
        watching: true,
        path,
        body: res.text ?? "",
        fetchedAt: Date.now(),
        error: null,
      }));
    } catch (e) {
      if (resolvedCwdRef.current !== currentCwd) return;
      setState((s) => ({ ...s, watching: true, path, error: String(e) }));
    }
  }, [cwd, state.path]);

  useEffect(() => {
    if (!open || !cwd) {
      setState((s) => ({ ...s, watching: false }));
      return;
    }
    // Run one immediate tick, then on interval.
    void tick();
    const handle = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => clearInterval(handle);
    // We intentionally re-create the interval when `open` flips: the
    // tick closure depends on `cwd`/`state.path`, and re-creating keeps
    // the dependency bookkeeping simple. ~3s of work per toggle is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cwd]);

  if (!open) return null;

  const lastFetched = state.fetchedAt
    ? new Date(state.fetchedAt).toLocaleTimeString()
    : "—";
  const fileName = state.path ? state.path.split(/[\\/]/).pop() : null;

  return (
    <div className="workbench-tail" role="tabpanel" aria-label="Workbench markdown tail">
      <div className="workbench-panel-meta">
        <span className="workbench-meta-item" title={state.path ?? ""}>
          {fileName ?? "no file yet"}
        </span>
        <span className="workbench-meta-item">
          {state.watching ? "● live" : "○ paused"}
        </span>
        <span className="workbench-meta-item">last fetch {lastFetched}</span>
      </div>

      {state.error ? (
        <div className="workbench-error" role="alert">
          {state.error}
        </div>
      ) : null}

      <div className="workbench-panel-body">
        {state.body ? (
          renderMiniMarkdown(state.body)
        ) : (
          <div className="workbench-empty">
            Start a Kraken run to see the live DAG table here. The file is written to
            <code> .zelari/radio/workbench-&lt;id&gt;.md</code> and refreshed on every node
            event.
          </div>
        )}
      </div>
    </div>
  );
}
