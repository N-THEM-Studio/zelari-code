/**
 * TentacleTracePanel (Desktop, F2 of the lead-chat plan).
 *
 * F1 made the tentacle rows of the active mission visible in the sidebar.
 * F2 makes them clickable: picking a row opens this panel, which tails what
 * the run actually wrote to `.zelari/radio/` for that tentacle.
 *
 * What it tails, honestly — there is no per-tentacle transcript file on
 * disk. Two radio artifacts are readable today, with different scopes:
 *
 *   `.zelari/radio/<sessionId>.jsonl` — the LIVE per-run radio trail
 *     (spawn/progress/done/tool lines). Per-TENTACLE attribution is by
 *     `description`, which the CLI fills with the spawn title (`taskTool.ts`
 *     `agent_spawned.title = args.description`). The file is scoped to the
 *     whole run, so when no line carries this tentacle's title we say so and
 *     show the run tail instead of pretending.
 *   `.zelari/radio/workbench-<graphId>.md` — the file WorkbenchLiveTail
 *     always read: live, but scoped to the GRAPH, not the tentacle. Used
 *     only as a fallback (mission without a spine session id) and labelled
 *     as run-scoped in the header.
 *
 * Reads reuse WorkbenchLiveTail's `useRadioTail` (same immediate tick +
 * 1500ms cadence, same mtime+size skip): no new polling loop, no new Tauri
 * channel, no new IPC command. Rendering reuses the same mini-markdown
 * subset for the `.md` fallback and the shared `workbench-panel*` classes so
 * no CSS had to be added.
 */
import { useMemo } from "react";
import { roleGlyph, statusGlyph, type ActivityAgent } from "../activity";
import {
  renderMiniMarkdown,
  useRadioTail,
  type TailSource,
} from "./WorkbenchLiveTail";

/** Radio root, relative to the run's cwd (same constant as the tail). */
const RADIO_DIR = ".zelari/radio";

/** Graph-scoped fallback: the tail WorkbenchLiveTail already knew about. */
const WORKBENCH_FALLBACK: TailSource = { dir: RADIO_DIR, prefix: "workbench-", suffix: ".md" };

/** Rendered event cap (the JSONL grows for the whole run). */
const MAX_ROWS = 60;
/** Parsed tail cap: only the end of the file is needed, never the whole run. */
const MAX_PARSE_CHARS = 64_000;
/** Detail excerpt cap, mirroring the radio's own 240-char radio detail. */
const MAX_DETAIL = 220;

export interface TentacleTracePanelProps {
  /** Selected tentacle; `null` closes the panel (component returns null). */
  agent: ActivityAgent | null;
  /** Project root of the mission — file reads are sandboxed to it. */
  cwd: string | null;
  /** Spine/radio session id of the mission (`Conversation.sessionId`). */
  sessionId?: string | null;
  /** Close handler owned by App. */
  onClose: () => void;
}

/** One line of `.zelari/radio/<session>.jsonl` (KrakenRadioEvent subset). */
interface RadioRow {
  ts?: string;
  kind?: string;
  agent?: string;
  description?: string;
  detail?: string;
  ok?: boolean;
}

interface TraceView {
  rows: RadioRow[];
  /** `tentacle` = rows attributable to this agent; `run` = whole-run tail. */
  scope: "tentacle" | "run";
  /** One honest line about why this scope was chosen. */
  note: string;
}

/** CLI-side sanitizer for radio file names (`tools/krakenRadio.ts`): look for
 * the same basename the writer produced. */
function safeSessionId(id: string): string {
  return (id || "default").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

/** Priority order: the mission's own live radio trail first, then the
 * graph-scoped workbench markdown (labelled run-scoped when used). */
function sourcesFor(sessionId: string | null): TailSource[] {
  return sessionId
    ? [{ dir: RADIO_DIR, name: `${safeSessionId(sessionId)}.jsonl` }, WORKBENCH_FALLBACK]
    : [WORKBENCH_FALLBACK];
}

/** Parse the tail of a JSONL body; fail-open per line, since the CLI appends
 * without a lock and the last line may be a partial fragment. */
function parseRows(body: string): RadioRow[] {
  const text = body.length > MAX_PARSE_CHARS ? body.slice(-MAX_PARSE_CHARS) : body;
  const lines = text.split(/\r?\n/);
  // When we cut the head, the first line is very likely a fragment.
  if (text.length !== body.length) lines.shift();
  const out: RadioRow[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") out.push(parsed as RadioRow);
    } catch {
      /* partial or corrupt line: skip it, never throw */
    }
  }
  return out;
}

/**
 * Events attributable to `agent`. The radio mirrors the spawn title into
 * `description`, so an exact title match is the strongest signal available;
 * anything weaker is reported as run-scoped rather than guessed.
 */
function traceView(rows: RadioRow[], agent: ActivityAgent): TraceView {
  const title = (agent.title ?? "").trim();
  const role = typeof agent.role === "string" ? agent.role.trim() : "";
  if (title) {
    const mine = rows.filter((r) => (r.description ?? "").trim() === title);
    if (mine.length > 0) {
      return {
        rows: mine.slice(-MAX_ROWS),
        scope: "tentacle",
        note: `filtrata su questo tentacle (titolo "${title}")`,
      };
    }
    return {
      rows: rows.slice(-MAX_ROWS),
      scope: "run",
      note: `nessun evento con il titolo di questo tentacle — coda dell'intera run`,
    };
  }
  if (role) {
    return {
      rows: rows.slice(-MAX_ROWS),
      scope: "run",
      note: `tentacle senza titolo: coda dell'intera run (ruolo ${role})`,
    };
  }
  return {
    rows: rows.slice(-MAX_ROWS),
    scope: "run",
    note: "tentacle senza titolo né ruolo: coda dell'intera run",
  };
}

/** `HH:MM:SS` from the radio's ISO timestamp; never throws on junk. */
function clock(ts?: string): string {
  if (!ts) return "—";
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return "—";
  try {
    return parsed.toLocaleTimeString();
  } catch {
    return "—";
  }
}

function excerpt(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

/** One radio line: time · kind · agent · description (+ detail excerpt). */
function TraceRows({ rows }: { rows: RadioRow[] }) {
  return (
    <div>
      {rows.map((r, i) => (
        <div
          key={`${r.ts ?? "t"}-${i}`}
          className="tentacle-trace-event"
          data-kind={r.kind ?? "unknown"}
          data-ok={r.ok === undefined ? undefined : String(r.ok)}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "baseline",
            padding: "3px 0",
            fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
            fontSize: "0.8em",
            lineHeight: 1.45,
            color: "var(--text-secondary)",
          }}
        >
          <span style={{ opacity: 0.6, whiteSpace: "nowrap" }}>{clock(r.ts)}</span>
          <span style={{ color: "var(--text)", whiteSpace: "nowrap" }}>
            {r.kind ?? "?"}
            {r.kind === "done" ? (r.ok === false ? " ✗" : " ✓") : ""}
          </span>
          <span style={{ opacity: 0.75, whiteSpace: "nowrap" }}>{r.agent ?? "—"}</span>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {r.description ?? ""}
            {r.detail ? <span style={{ opacity: 0.65 }}> — {excerpt(r.detail)}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

export function TentacleTracePanel({
  agent,
  cwd,
  sessionId,
  onClose,
}: TentacleTracePanelProps) {
  const sources = useMemo(() => sourcesFor(sessionId ?? null), [sessionId]);
  // Hooks first (rules of hooks): the tail is paused when nothing is selected.
  const state = useRadioTail({ cwd, open: Boolean(agent && cwd), sources });

  if (!agent) return null;

  const isJsonl = (state.path ?? "").endsWith(".jsonl");
  const fileName = state.path ? state.path.split(/[\\/]/).pop() : null;
  const view = isJsonl ? traceView(parseRows(state.body), agent) : null;
  const lastFetched = state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString() : "—";

  const scopeLine = !state.path
    ? `Trace: nessun file in ${RADIO_DIR} per questa missione`
    : isJsonl && view
      ? `Trace: ${fileName} · ${view.note}`
      : `Trace: ${fileName} · file per grafo/run, non per tentacle (missione senza sessionId radio)`;

  return (
    <aside
      className="workbench-panel"
      role="complementary"
      aria-label="Trace live del tentacle"
      data-scope={isJsonl ? "radio" : "workbench"}
    >
      <header className="workbench-panel-head">
        <div className="workbench-panel-title">
          <span className="workbench-panel-icon" aria-hidden>
            {statusGlyph(agent.status)}
          </span>
          <span>{agent.title || agent.id}</span>
        </div>
        <button
          type="button"
          className="btn-ghost workbench-panel-close"
          onClick={onClose}
          aria-label="Chiudi il trace del tentacle"
          title="Chiudi (×)"
        >
          ×
        </button>
      </header>

      <div className="workbench-panel-meta">
        <span className="workbench-meta-item">
          {roleGlyph(agent.role)} {agent.role}
        </span>
        <span className="workbench-meta-item" title={state.path ?? ""}>
          {fileName ?? "no file yet"}
        </span>
        <span className="workbench-meta-item">{state.watching ? "● live" : "○ paused"}</span>
        <span className="workbench-meta-item">last fetch {lastFetched}</span>
      </div>

      <div
        className="workbench-meta-item tentacle-trace-scope"
        style={{ padding: "8px 18px 0", opacity: 0.8 }}
      >
        {scopeLine}
        {agent.phaseMessage ? <span> · {agent.phaseMessage}</span> : null}
      </div>

      {state.error ? (
        <div className="workbench-error" role="alert">
          {state.error}
        </div>
      ) : null}

      <div className="workbench-panel-body">
        {!state.path ? (
          <div className="workbench-empty">
            Nessun file letto da <code>{RADIO_DIR}</code> per questa missione. Il trace compare
            quando la run scrive <code>.zelari/radio/&lt;sessionId&gt;.jsonl</code> (trail live del
            tentacle) o <code>.zelari/radio/workbench-&lt;graphId&gt;.md</code> (tabella DAG della
            run).
          </div>
        ) : isJsonl && view ? (
          view.rows.length > 0 ? (
            <TraceRows rows={view.rows} />
          ) : (
            <div className="workbench-empty">{fileName} è vuoto: nessun evento radio ancora.</div>
          )
        ) : state.body ? (
          renderMiniMarkdown(state.body)
        ) : (
          <div className="workbench-empty">{fileName} è ancora vuoto.</div>
        )}
      </div>
    </aside>
  );
}
