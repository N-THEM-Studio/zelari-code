/**
 * WebsiteCredentialForm — Settings → Automations: store / show / remove the
 * website webhook credential directly from the Desktop (no CLI round-trip).
 *
 * The secret is written to the vault by the CLI and is ALWAYS displayed masked
 * (`abcd…wxyz`). `show` runs on mount so the saved endpoint + masked secret
 * state is honest about what is configured.
 */
import { useCallback, useEffect, useState } from "react";
import {
  formatAutomationError,
  manageChannelCredential,
  type ChannelCredentialResult,
} from "../../agentClient";
import { StatusPill } from "./primitives";

export interface WebsiteCredentialFormProps {
  workdir: string | null;
}

type Busy = null | "show" | "store" | "remove";

export function WebsiteCredentialForm({ workdir }: WebsiteCredentialFormProps) {
  const repoPath = workdir ?? "";
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<ChannelCredentialResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);

  const show = useCallback(async () => {
    if (!repoPath) {
      setStatus(null);
      return;
    }
    setBusy("show");
    setError(null);
    try {
      const res = await manageChannelCredential({ action: "show", repoPath });
      setStatus(res);
      setEndpoint(res.endpoint ?? "");
    } catch (e) {
      setError(formatAutomationError(e));
    } finally {
      setBusy(null);
    }
  }, [repoPath]);

  useEffect(() => {
    void show();
  }, [show]);

  const store = async () => {
    if (busy) return;
    setBusy("store");
    setError(null);
    try {
      const res = await manageChannelCredential({
        action: "store",
        repoPath,
        endpoint: endpoint.trim(),
        secret: secret.trim() || undefined,
      });
      setStatus(res);
      setEndpoint(res.endpoint ?? endpoint.trim());
      setSecret("");
    } catch (e) {
      setError(formatAutomationError(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy("remove");
    setError(null);
    try {
      const res = await manageChannelCredential({ action: "remove", repoPath });
      setStatus(res);
      setEndpoint("");
      setSecret("");
    } catch (e) {
      setError(formatAutomationError(e));
    } finally {
      setBusy(null);
    }
  };

  const configured = Boolean(status?.configured);
  const disabled = busy !== null || !repoPath;

  return (
    <div className="s-row stack" aria-label="Credenziali website">
      <div className="s-row-label">
        website{" "}
        <StatusPill tone={configured ? "ok" : "neutral"}>
          {configured ? "configurato" : "non configurato"}
        </StatusPill>
      </div>
      {configured ? (
        <div className="s-row-hint">
          {status?.endpoint}
          {status?.secret ? (
            <>
              {" · secret "}
              <code>{status.secret}</code>
            </>
          ) : null}
        </div>
      ) : (
        <div className="s-row-hint">Webhook non configurato (endpoint + secret).</div>
      )}
      <input
        className="s-input"
        type="text"
        aria-label="Website endpoint"
        placeholder="https://example.com/webhook"
        value={endpoint}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => setEndpoint(e.target.value)}
      />
      <input
        className="s-input"
        type="password"
        aria-label="Website secret"
        placeholder="secret (HMAC)"
        value={secret}
        disabled={disabled}
        autoComplete="new-password"
        onChange={(e) => setSecret(e.target.value)}
      />
      {error ? <StatusPill tone="warn">{error}</StatusPill> : null}
      <div className="settings-actions inline">
        <button type="button" className="btn-send" disabled={disabled} onClick={() => void store()}>
          {busy === "store" ? "Salvo…" : "Salva"}
        </button>
        <button type="button" className="btn-ghost" disabled={disabled} onClick={() => void remove()}>
          {busy === "remove" ? "Rimuovo…" : "Rimuovi"}
        </button>
      </div>
    </div>
  );
}
