/**
 * RunsHistoryCard — Settings → Automations: run history + evidence for ONE
 * automation, opened from a row's "Cronologia" button (the parent owns the
 * selected id). Polls lightly while visible, exactly like AutomationsList.
 *
 * P1: a post is a success ONLY with ok:true AND a url; exit 4
 * (unproven / relogin_required) is a STATE chip, never a red error.
 */
import { useCallback, useEffect, useState } from "react";
import {
  formatAutomationError,
  listAutomationRuns,
  type AutomationRunJson,
} from "../../agentClient";
import { SettingsCard, StatusPill } from "./primitives";

export interface RunsHistoryCardProps {
  workdir: string | null;
  /** null = nothing selected → the card renders nothing. */
  automationId: string | null;
  /** Bumped by the parent to force a refresh (after a sibling mutation). */
  refreshToken?: number;
}

/** Visible poll while the card is mounted — no background daemon. */
const POLL_MS = 30_000;

type Tone = "ok" | "warn" | "neutral";

const STATUS_CHIP: Record<string, { tone: Tone; label: string }> = {
  drafting: { tone: "neutral", label: "bozza" },
  awaiting_approval: { tone: "warn", label: "in attesa" },
  publishing: { tone: "neutral", label: "pubblicazione" },
  completed: { tone: "ok", label: "completato" },
  failed: { tone: "warn", label: "fallito" },
  skipped: { tone: "neutral", label: "saltato" },
  relogin_required: { tone: "warn", label: "ri-login richiesto" },
};

/** status → chip tone + label. Unknown statuses fall back to a neutral chip. */
export function runStatusChip(status: string): { tone: Tone; label: string } {
  return STATUS_CHIP[status] ?? { tone: "neutral", label: status || "sconosciuto" };
}

/** Exit-code badge: 0 ok / 4 unproven (neutral, NOT an error) / 1 failure. */
export function exitBadge(code: number): { tone: Tone; label: string } {
  if (code === 0) return { tone: "ok", label: "exit 0" };
  if (code === 4) return { tone: "neutral", label: "exit 4 · non provato" };
  return { tone: "warn", label: `exit ${code}` };
}

/** ISO stamp → local string; a malformed value is shown verbatim, never hidden. */
export function stampLabel(iso?: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

function RunBlock({ run }: { run: AutomationRunJson }) {
  const chip = runStatusChip(run.status);
  const exit = exitBadge(run.exitCode);
  return (
    <div className="s-row stack">
      <div className="s-row-label">
        <code>{run.runId}</code> <StatusPill tone={chip.tone}>{chip.label}</StatusPill>{" "}
        <StatusPill tone={exit.tone}>{exit.label}</StatusPill>
      </div>
      <div className="s-row-hint">
        {stampLabel(run.startedAt)}
        {run.finishedAt ? ` → ${stampLabel(run.finishedAt)}` : ""}
        {run.reason ? ` · ${run.reason}` : ""}
        {typeof run.costUsd === "number" ? ` · $${run.costUsd.toFixed(4)}` : ""}
      </div>

      {run.draft ? (
        <div className="s-run-block">
          <p className="s-card-desc">{run.draft.text || "(bozza vuota)"}</p>
          {run.draft.generatedBy ? (
            <div className="s-row-hint">
              generato da {run.draft.generatedBy.source}
              {run.draft.generatedBy.provider ? ` · ${run.draft.generatedBy.provider}` : ""}
              {run.draft.generatedBy.model ? `/${run.draft.generatedBy.model}` : ""}
            </div>
          ) : null}
          {(run.draft.warnings ?? []).map((w) => (
            <div className="s-row-hint" key={w}>
              ⚠ {w}
            </div>
          ))}
        </div>
      ) : null}

      {(run.approvals ?? []).map((a, i) => (
        <div className="s-row-hint" key={`${a.at}-${i}`}>
          decisione: {a.decision}
          {a.editedText ? ` — “${a.editedText}”` : ""} · {stampLabel(a.at)}
        </div>
      ))}

      {(run.posts ?? []).map((p, i) => (
        <div className="s-run-block" key={`${p.channel}-${i}`}>
          <div className="s-row-label">
            {p.channel}{" "}
            <StatusPill tone={p.ok && p.url ? "ok" : p.ok ? "neutral" : "warn"}>
              {p.ok ? (p.url ? "pubblicato" : "ok (senza url)") : "fallito"}
            </StatusPill>
            {p.dryRun ? <StatusPill tone="neutral">dry-run</StatusPill> : null}
          </div>
          {p.url ? (
            <a className="s-run-link" href={p.url} target="_blank" rel="noreferrer">
              {p.url}
            </a>
          ) : null}
          {p.screenshot ? <div className="s-row-hint">screenshot: {p.screenshot}</div> : null}
          {p.error ? <div className="s-row-hint">⚠ {p.error}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function RunsHistoryCard({ workdir, automationId, refreshToken = 0 }: RunsHistoryCardProps) {
  const repoPath = workdir ?? "";
  const [runs, setRuns] = useState<AutomationRunJson[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!repoPath || !automationId) {
      setRuns(null);
      setError(null);
      return;
    }
    try {
      const res = await listAutomationRuns(automationId, repoPath);
      setRuns(res.runs);
      setError(null);
    } catch (e) {
      setError(formatAutomationError(e));
    }
  }, [repoPath, automationId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    if (!repoPath || !automationId) return;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load, repoPath, automationId]);

  if (!automationId) return null;

  return (
    <SettingsCard
      title={`Cronologia · ${automationId}`}
      description="Esecuzioni recenti con evidenze: stato, exit code (4 = non provato), bozza, approvazioni e post per canale."
      actions={
        <button type="button" className="btn-ghost" disabled={!repoPath} onClick={() => void load()}>
          Refresh
        </button>
      }
    >
      {error ? <StatusPill tone="warn">{error}</StatusPill> : null}
      {runs === null && !error ? <StatusPill tone="neutral">Loading…</StatusPill> : null}
      {runs !== null && runs.length === 0 ? (
        <p className="s-card-desc" style={{ marginBottom: 0 }}>
          Nessuna esecuzione registrata.
        </p>
      ) : null}
      {(runs ?? []).map((run) => (
        <RunBlock run={run} key={run.runId} />
      ))}
    </SettingsCard>
  );
}
