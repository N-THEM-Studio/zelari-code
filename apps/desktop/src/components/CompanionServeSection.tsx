/**
 * Settings → Connections: start/stop zelari-code serve + QR pairing for Android.
 */
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  companionServeStart,
  companionServeStatus,
  companionServeStop,
  type CompanionServeStatus,
} from "../agentClient";
import { formatCompanionPairing } from "../companionPairing";

interface Props {
  workdir: string | null;
  onStatus?: (msg: string) => void;
}

const BIND_PHONE = "0.0.0.0";
const BIND_LOCAL = "127.0.0.1";

export function CompanionServeSection({ workdir, onStatus }: Props) {
  const [st, setSt] = useState<CompanionServeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bind, setBind] = useState(BIND_PHONE);
  const [port, setPort] = useState("7421");
  const [showToken, setShowToken] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await companionServeStatus();
      setSt(s);
      setError(null);
      if (s.running && s.bind) setBind(s.bind);
      if (s.running && s.port) setPort(String(s.port));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const running = st?.running || st?.healthy;
  const phoneUrl = st?.phoneUrl || st?.url || `http://${bind}:${port}`;
  const pairing =
    running && st?.token
      ? formatCompanionPairing(phoneUrl, st.token)
      : null;

  useEffect(() => {
    if (!pairing) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(pairing, {
      width: 280,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0e0e12", light: "#ffffff" },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [pairing]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = Number.parseInt(port, 10);
      const s = await companionServeStart({
        bind: bind.trim() || BIND_PHONE,
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

  const localOnly = bind === BIND_LOCAL;
  const tailscaleIp = st?.tailscaleIp ?? null;

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h2>Mobile connection</h2>
        <span
          className="mcp-meta"
          style={{
            color: st?.healthy ? "var(--accent, #c9a227)" : undefined,
          }}
        >
          {st?.healthy ? "● running" : running ? "○ starting…" : "○ stopped"}
        </span>
      </div>
      <p className="muted">
        Pair the Android companion over Tailscale. Start serve, then scan the
        QR on the phone — it fills the host URL and token in one step.
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
            <option value={BIND_PHONE}>
              0.0.0.0 — phone / Tailscale / LAN
            </option>
            <option value={BIND_LOCAL}>127.0.0.1 — this PC only</option>
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
      <p className="muted" style={{ fontSize: 12.5 }}>
        Tailscale IPv4:{" "}
        {tailscaleIp ? (
          <code>{tailscaleIp}</code>
        ) : (
          <span>
            not detected — install Tailscale, run <code>tailscale up</code> on
            this PC and the phone, then Refresh.
          </span>
        )}
      </p>
      {localOnly && (
        <p className="warn">
          127.0.0.1 is not reachable from the phone. Switch bind to{" "}
          <strong>phone / Tailscale / LAN</strong> before starting.
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

      {running && pairing && (
        <div className="companion-qr-panel">
          <div className="companion-qr-card">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="Companion pairing QR"
                width={220}
                height={220}
              />
            ) : (
              <div className="companion-qr-placeholder">Generating QR…</div>
            )}
          </div>
          <div className="companion-qr-meta">
            <h3 className="settings-subhead" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
              Scan with Zelari Companion
            </h3>
            <p className="muted" style={{ marginBottom: 10 }}>
              On the phone tap <strong>Scan QR from Desktop</strong> (same
              Tailscale tailnet). Never type <code>127.0.0.1</code> — that is
              this PC. If connect still fails: Windows Firewall must allow
              inbound TCP {port} for Node, and <code>tailscale status</code>{" "}
              should list both devices.
            </p>
            <dl className="kv">
              <dt>Phone URL</dt>
              <dd>
                <code>{phoneUrl}</code>{" "}
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 12 }}
                  onClick={() => void copy(phoneUrl, "phone URL")}
                >
                  Copy
                </button>
              </dd>
              <dt>Token</dt>
              <dd>
                {st?.token ? (
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
                  <span className="muted">—</span>
                )}
              </dd>
              <dt>Health</dt>
              <dd>{st?.healthy ? "OK" : "not reachable"}</dd>
              {st?.pid != null && (
                <>
                  <dt>PID</dt>
                  <dd>
                    <code>{st.pid}</code>
                  </dd>
                </>
              )}
            </dl>
          </div>
        </div>
      )}

      {st && !running && (
        <dl className="kv" style={{ marginTop: 14 }}>
          <dt>PC URL</dt>
          <dd>
            <code>{st.url}</code>
          </dd>
          <dt>Token file</dt>
          <dd>
            <code style={{ fontSize: 11 }}>{st.tokenPath}</code>
          </dd>
        </dl>
      )}
    </section>
  );
}
