/**
 * Settings → Connections: start/stop zelari-code serve for Android companion.
 */
import { useCallback, useEffect, useState } from "react";
import {
  companionServeStart,
  companionServeStatus,
  companionServeStop,
  type CompanionServeStatus,
} from "../agentClient";

interface Props {
  workdir: string | null;
  onStatus?: (msg: string) => void;
}

export function CompanionServeSection({ workdir, onStatus }: Props) {
  const [st, setSt] = useState<CompanionServeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bind, setBind] = useState("127.0.0.1");
  const [port, setPort] = useState("7421");
  const [showToken, setShowToken] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await companionServeStatus();
      setSt(s);
      setError(null);
      if (s.bind) setBind(s.bind);
      if (s.port) setPort(String(s.port));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = Number.parseInt(port, 10);
      const s = await companionServeStart({
        bind: bind.trim() || "127.0.0.1",
        port: Number.isFinite(p) ? p : 7421,
        project: workdir,
      });
      setSt(s);
      onStatus?.(s.message);
      if (!s.healthy) {
        setError(s.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await companionServeStop();
      setSt(s);
      onStatus?.("Companion serve stopped");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onStatus?.(`Copied ${label}`);
    } catch {
      onStatus?.("Copy failed");
    }
  };

  const running = st?.running || st?.healthy;
  const url = st?.url || `http://${bind}:${port}`;

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h2>Android companion</h2>
        <span
          className={`mcp-meta${running ? "" : ""}`}
          style={{
            color: st?.healthy ? "var(--accent, #c9a227)" : undefined,
          }}
        >
          {st?.healthy ? "● running" : running ? "○ starting…" : "○ stopped"}
        </span>
      </div>
      <p className="muted">
        Start <code>zelari-code serve</code> so the Android app can connect over
        Tailscale or LAN. Uses the monorepo/dev CLI resolved by Desktop (run{" "}
        <code>npm run build:cli</code> if start fails).
      </p>

      {error && <p className="error-banner">{error}</p>}

      <div className="settings-row">
        <label className="field">
          <span>Bind</span>
          <select
            value={bind}
            onChange={(e) => setBind(e.target.value)}
            disabled={!!running || busy}
          >
            <option value="127.0.0.1">127.0.0.1 (this PC only)</option>
            <option value="0.0.0.0">0.0.0.0 (LAN / all interfaces)</option>
          </select>
        </label>
        <label className="field">
          <span>Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={!!running || busy}
          />
        </label>
      </div>

      <p className="muted" style={{ fontSize: 12.5 }}>
        Project:{" "}
        <code>{workdir || "— open a folder (Open Folder) for --project"}</code>
      </p>
      {bind === "0.0.0.0" && (
        <p className="muted" style={{ fontSize: 12.5 }}>
          On the phone use <code>http://&lt;PC-Tailscale-or-LAN-IP&gt;:{port}</code>
          , not 127.0.0.1.
        </p>
      )}

      <div className="settings-actions inline">
        {!running ? (
          <button
            type="button"
            className="btn-send"
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? "Starting…" : "Start companion serve"}
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => void stop()}
          >
            {busy ? "Stopping…" : "Stop"}
          </button>
        )}
        <button
          type="button"
          className="btn-ghost"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh status
        </button>
      </div>

      {st && (
        <dl className="kv" style={{ marginTop: 14 }}>
          <dt>URL (PC)</dt>
          <dd>
            <code>{url}</code>{" "}
            <button
              type="button"
              className="btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => void copy(url, "URL")}
            >
              Copy
            </button>
          </dd>
          <dt>Health</dt>
          <dd>{st.healthy ? "OK" : "not reachable"}</dd>
          {st.pid != null && (
            <>
              <dt>PID</dt>
              <dd>
                <code>{st.pid}</code>
              </dd>
            </>
          )}
          <dt>Token file</dt>
          <dd>
            <code style={{ fontSize: 11 }}>{st.tokenPath}</code>
          </dd>
          <dt>Token</dt>
          <dd>
            {st.token ? (
              <>
                <code style={{ fontSize: 12 }}>
                  {showToken ? st.token : "••••••••••••••••"}
                </code>{" "}
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 12 }}
                  onClick={() => setShowToken((v) => !v)}
                >
                  {showToken ? "Hide" : "Show"}
                </button>{" "}
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 12 }}
                  onClick={() => void copy(st.token, "token")}
                >
                  Copy
                </button>
              </>
            ) : (
              <span className="muted">— (start serve once to create)</span>
            )}
          </dd>
        </dl>
      )}
    </section>
  );
}
