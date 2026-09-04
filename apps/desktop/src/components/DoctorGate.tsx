/**
 * 2.32 B5 — first-run doctor gate (Desktop mirror of the TUI gate in
 * src/cli/main.ts `runFirstRunDoctorGate`).
 *
 * When the CLI resolves but `zelari-code --doctor --json` reports a red
 * check, Desktop stops here BEFORE the chat: first red named, its message
 * already contains the exact fix command (`/login`, `--trust`,
 * `--fix-path`). Reaching chat with a red doctor requires an explicit
 * "Continue anyway" click (dichiarato) — never a silent pass.
 */
import { useState } from "react";

export interface DoctorRed {
  name: string;
  message: string;
}

interface Props {
  red: DoctorRed;
  onRecheck: () => Promise<void>;
  /** Explicit "continue anyway" — dismisses the gate for this session. */
  onContinueAnyway: () => void;
}

export function DoctorGate({ red, onRecheck, onContinueAnyway }: Props) {
  const [checking, setChecking] = useState(false);

  const recheck = async () => {
    setChecking(true);
    try {
      await onRecheck();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="setup-overlay" role="dialog" aria-labelledby="doctor-gate-title">
      <div className="setup-card">
        <header className="setup-header">
          <h1 id="doctor-gate-title">Doctor check failed</h1>
          <p className="muted">
            The coding engine is installed but one health check is red. Fix it
            before chatting — the check message names the exact command.
          </p>
        </header>

        <ol className="setup-steps">
          <li className="todo">
            <div className="setup-step-head">
              <span className="setup-badge">✗</span>
              <strong>{red.name}</strong>
            </div>
            <div className="setup-detail">
              <p className="warn">{red.message}</p>
              <p className="muted">
                Then verify from a terminal:{" "}
                <code>zelari-code --doctor</code>
              </p>
            </div>
          </li>
        </ol>

        <div className="setup-detail">
          <button
            type="button"
            className="btn-send"
            disabled={checking}
            onClick={() => void recheck()}
          >
            {checking ? "Re-checking…" : "Re-run doctor"}
          </button>{" "}
          <button
            type="button"
            className="btn-ghost"
            onClick={onContinueAnyway}
          >
            Continue anyway (declared)
          </button>
        </div>
      </div>
    </div>
  );
}
