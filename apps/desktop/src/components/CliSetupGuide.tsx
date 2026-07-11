/**
 * First-run / missing-CLI setup guide.
 * Desktop installer does NOT bundle the coding engine — users need Node + zelari-code.
 */
import { useState } from "react";
import { updateCli } from "../agentClient";
import type { CliStatus } from "../types";

interface Props {
  cli: CliStatus | null;
  /** Still probing status on launch. */
  loading?: boolean;
  onRefresh: () => Promise<void>;
  onOpenSettings: () => void;
  onDismiss?: () => void;
}

export function CliSetupGuide({
  cli,
  loading,
  onRefresh,
  onOpenSettings,
  onDismiss,
}: Props) {
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasNode = Boolean(cli?.node);
  const hasCli = Boolean(cli?.ok && cli?.cliPath);
  const needsGuide = !loading && cli !== null && !cli.ok;

  if (loading || !needsGuide) return null;

  const installCli = async () => {
    setInstalling(true);
    setError(null);
    setLog(null);
    try {
      const r = await updateCli({ version: "latest" });
      setLog(r.output?.slice(0, 800) || `Installed ${r.package ?? "zelari-code"}`);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="setup-overlay" role="dialog" aria-labelledby="setup-title">
      <div className="setup-card">
        <header className="setup-header">
          <h1 id="setup-title">Setup required</h1>
          <p className="muted">
            Zelari Desktop is the UI shell. The coding engine is the separate{" "}
            <code>zelari-code</code> CLI (npm). The installer does{" "}
            <strong>not</strong> install it automatically.
          </p>
        </header>

        <ol className="setup-steps">
          <li className={hasNode ? "done" : "todo"}>
            <div className="setup-step-head">
              <span className="setup-badge">{hasNode ? "✓" : "1"}</span>
              <strong>Node.js ≥ 20</strong>
            </div>
            {hasNode ? (
              <p className="setup-detail ok-inline">
                Found: <code>{cli?.node}</code>
              </p>
            ) : (
              <div className="setup-detail">
                <p className="muted">
                  Install from{" "}
                  <a
                    href="https://nodejs.org/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    nodejs.org
                  </a>{" "}
                  (LTS), then restart Zelari Desktop so PATH is refreshed.
                </p>
              </div>
            )}
          </li>

          <li className={hasCli ? "done" : "todo"}>
            <div className="setup-step-head">
              <span className="setup-badge">{hasCli ? "✓" : "2"}</span>
              <strong>Install zelari-code CLI</strong>
            </div>
            <div className="setup-detail">
              {hasCli ? (
                <p className="ok-inline">
                  Ready · <code>{cli?.cliVersion ?? cli?.cliPath}</code>
                </p>
              ) : (
                <>
                  <p className="muted">
                    {cli?.message ||
                      "CLI not found on PATH. Install the global package:"}
                  </p>
                  <pre className="setup-code">npm install -g zelari-code</pre>
                  {hasNode ? (
                    <button
                      type="button"
                      className="btn-send"
                      disabled={installing}
                      onClick={() => void installCli()}
                    >
                      {installing
                        ? "Installing CLI…"
                        : "Install CLI (npm install -g)"}
                    </button>
                  ) : (
                    <p className="warn">
                      Install Node first — then use the button or the command
                      above.
                    </p>
                  )}
                </>
              )}
            </div>
          </li>

          <li className="todo">
            <div className="setup-step-head">
              <span className="setup-badge">3</span>
              <strong>API key (Settings)</strong>
            </div>
            <div className="setup-detail">
              <p className="muted">
                After the CLI is ready, add a provider key under Settings →
                Provider so the agent can call a model.
              </p>
              <button
                type="button"
                className="btn-ghost"
                onClick={onOpenSettings}
              >
                Open Settings
              </button>
            </div>
          </li>
        </ol>

        {error && <p className="error-banner">{error}</p>}
        {log && <pre className="update-notes setup-log">{log}</pre>}

        <footer className="setup-footer">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void onRefresh()}
          >
            Recheck status
          </button>
          {onDismiss ? (
            <button type="button" className="btn-ghost" onClick={onDismiss}>
              Continue anyway
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
