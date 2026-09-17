/**
 * ChannelProbePanel — Settings → Automations: per-channel selector/session
 * diagnostic ("why is my session not working?"). Delegates to the CLI probe and
 * renders the step list. A failed probe (exit 1) is a VALID report, never error.
 */
import { useState } from "react";
import {
  automationChannelProbe,
  formatAutomationError,
  type AutomationProbeReport,
} from "../../agentClient";
import { StatusPill } from "./primitives";

export interface ChannelProbePanelProps {
  workdir: string | null;
  channel: string;
}

export function ChannelProbePanel({ workdir, channel }: ChannelProbePanelProps) {
  const repoPath = workdir ?? "";
  const [report, setReport] = useState<AutomationProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const probe = async () => {
    if (!repoPath || busy) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await automationChannelProbe(channel, repoPath));
    } catch (e) {
      setReport(null);
      setError(formatAutomationError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="s-row stack">
      <div className="s-row-label">
        Diagnostica {channel}{" "}
        {report ? (
          <StatusPill tone={report.ok ? "ok" : "warn"}>{report.ok ? "ok" : "problemi"}</StatusPill>
        ) : null}
      </div>
      {error ? <StatusPill tone="warn">{error}</StatusPill> : null}
      {report ? (
        <ul className="s-probe-steps">
          {report.steps.map((s) => (
            <li key={s.step}>
              <StatusPill tone={s.ok ? "ok" : "warn"}>{s.ok ? "ok" : "x"}</StatusPill>{" "}
              <span className="s-row-label">{s.step}</span>
              {s.detail ? <div className="s-row-hint">{s.detail}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="s-row-control">
        <button
          type="button"
          className="btn-ghost"
          disabled={busy || !repoPath}
          onClick={() => void probe()}
        >
          {busy ? "Diagnostica…" : "Diagnostica"}
        </button>
      </div>
    </div>
  );
}
