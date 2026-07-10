import { useCallback, useEffect, useState } from "react";
import { checkCliUpdate, updateCli, type CliUpdateCheck } from "../agentClient";
import type { CliStatus } from "../types";

interface Props {
  cli: CliStatus | null;
  onCliRefreshed?: () => void;
}

export function CliUpdateSection({ cli, onCliRefreshed }: Props) {
  const [info, setInfo] = useState<CliUpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await checkCliUpdate();
      setInfo(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const runUpdate = async () => {
    setBusy(true);
    setError(null);
    setLog(null);
    try {
      const target = info?.npmLatest ?? "latest";
      const r = await updateCli({ version: target });
      setLog(r.output || "OK");
      await runCheck();
      onCliRefreshed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const installed =
    info?.installed ??
    (cli?.cliVersion
      ? cli.cliVersion.replace(/^zelari-code\s+v?/i, "").replace(/^v/, "")
      : null);

  return (
    <section className="settings-card">
      <h2>CLI package (npm)</h2>
      <p className="muted">
        The Desktop app is <strong>not</strong> the coding engine. It spawns the
        global <code>zelari-code</code> CLI. Installing a Desktop release from
        GitHub does <em>not</em> upgrade npm.
      </p>
      <dl className="kv">
        <dt>Installed CLI</dt>
        <dd>
          <code>{installed ? `v${installed}` : "not found"}</code>
        </dd>
        <dt>npm latest</dt>
        <dd>
          <code>
            {info?.npmLatest ? `v${info.npmLatest}` : busy ? "…" : "—"}
          </code>
        </dd>
        <dt>Path</dt>
        <dd>
          <code>{cli?.cliPath ?? "—"}</code>
        </dd>
      </dl>

      {info?.updateAvailable && (
        <p className="warn">
          {info.message}
        </p>
      )}
      {info && !info.updateAvailable && installed && (
        <p className="ok-inline">{info.message}</p>
      )}
      {error && <p className="error-banner">{error}</p>}
      {log && (
        <pre className="update-notes">{log.slice(0, 1200)}</pre>
      )}

      <div className="settings-actions inline">
        <button
          type="button"
          className="btn-ghost"
          disabled={busy}
          onClick={() => void runCheck()}
        >
          Check npm
        </button>
        <button
          type="button"
          className="btn-send"
          disabled={busy || (info != null && !info.updateAvailable && !!installed)}
          onClick={() => void runUpdate()}
          title="Runs: npm install -g zelari-code@&lt;latest&gt;"
        >
          {busy ? "Updating…" : "Update CLI"}
        </button>
      </div>
    </section>
  );
}
