/**
 * AuthCard — OAuth (with the Anthropic 3-step stepper) + API key block
 * for one provider. Same agentClient calls as the old SettingsView;
 * feedback moves from the footer banner to per-action toasts.
 */
import { useEffect, useState } from "react";
import { loginOAuth, logoutOAuth, refreshOAuth, setApiKey } from "../../agentClient";
import type { DesktopProviderInfo } from "../../types";
import { formatExpiry } from "./modelUtils";
import {
  BusyDot,
  SettingsCard,
  StatusPill,
  TextInput,
} from "./primitives";
import { useSettingAction } from "./useSettingAction";

export interface AuthCardProps {
  provider: DesktopProviderInfo;
  onRefresh: () => Promise<void>;
}

export function AuthCard({ provider, onRefresh }: AuthCardProps) {
  const { busy, run } = useSettingAction();
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [apiKey, setApiKeyInput] = useState("");
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const id = provider.id;
  const isAnthropic = id === "anthropic";
  const oauthSupported =
    Boolean(provider.oauthSupported) ||
    id === "grok" ||
    id === "chatgpt" ||
    id === "anthropic";

  useEffect(() => {
    setOauthUrl(null);
    setOauthCode("");
    setApiKeyInput("");
    setStep(1);
  }, [id]);

  const signedInWithOauth = provider.hasKey && provider.authKind === "oauth";
  const expiry = formatExpiry(provider.expiresAt);

  const openUrl = async (url: string) => {
    try {
      const { openUrl: open } = await import("@tauri-apps/plugin-opener");
      await open(url);
    } catch {
      /* the URL is also rendered below */
    }
  };

  const doLogin = (code?: string) =>
    void run(async () => {
      const r = await loginOAuth({ provider: id, code });
      if (r.ok === false && r.error) throw new Error(r.error);
      if (r.phase === "need_code") {
        setOauthUrl(r.authorizeUrl ?? null);
        setStep(2);
        if (r.authorizeUrl) await openUrl(r.authorizeUrl);
        return r.message ?? "Sign in in the browser, then paste the code below.";
      }
      setOauthUrl(null);
      setOauthCode("");
      setStep(3);
      await onRefresh();
      return r.message ?? `Signed in to ${provider.displayName}.`;
    });

  const doRefreshToken = () =>
    void run(async () => {
      const r = await refreshOAuth({ provider: id });
      if (r.ok === false && r.error) throw new Error(r.error);
      await onRefresh();
      return r.message ?? `Refreshed ${provider.displayName} token.`;
    });

  const doLogout = () =>
    void run(async () => {
      const r = await logoutOAuth({ provider: id });
      if (r.ok === false && r.error) throw new Error(r.error);
      setOauthUrl(null);
      setOauthCode("");
      setStep(1);
      await onRefresh();
      return r.message ?? `Signed out of ${provider.displayName}.`;
    });

  const saveKey = () =>
    void run(async () => {
      const key = apiKey.trim();
      if (!key) throw new Error("Enter an API key.");
      const r = await setApiKey({ provider: id, key });
      setApiKeyInput("");
      await onRefresh();
      return `Key stored for ${r.provider ?? id} (${r.masked ?? "••••"}).`;
    });

  return (
    <SettingsCard
      title={`Account & keys — ${provider.displayName}`}
      description={
        oauthSupported
          ? "Subscription login (OAuth) or a plain API key. Either one is enough."
          : "Provide an API key for this provider."
      }
    >
      {signedInWithOauth ? (
        <p className="s-card-desc" style={{ marginBottom: 8 }}>
          <StatusPill tone="ok">Signed in · OAuth{expiry ? ` · ${expiry}` : ""}</StatusPill>
          {provider.hasRefreshToken ? (
            <span style={{ marginLeft: 8 }}>refresh token saved</span>
          ) : null}
        </p>
      ) : provider.hasKey ? (
        <p className="s-card-desc" style={{ marginBottom: 8 }}>
          <StatusPill tone="ok">API key set</StatusPill>
          {oauthSupported ? (
            <span style={{ marginLeft: 8 }}>you can still switch to OAuth below</span>
          ) : null}
        </p>
      ) : (
        <p className="s-card-desc" style={{ marginBottom: 8 }}>
          <StatusPill tone="warn">Not configured</StatusPill>
        </p>
      )}

      {oauthSupported && (
        <>
          <h4 className="settings-subhead">Subscription login (OAuth)</h4>
          {isAnthropic && (
            <div className="s-steps" aria-label="Anthropic sign-in steps">
              <span className={`s-step${step === 1 ? " current" : step > 1 ? " done" : ""}`}>
                1 · Open browser
              </span>
              <span className={`s-step${step === 2 ? " current" : step > 2 ? " done" : ""}`}>
                2 · Paste code
              </span>
              <span className={`s-step${step === 3 ? " current" : ""}`}>3 · Complete</span>
            </div>
          )}
          {isAnthropic && step === 2 && (
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <TextInput
                value={oauthCode}
                placeholder="Paste the code from the Anthropic page (CODE#STATE)"
                ariaLabel="Anthropic magic-link code"
                onCommit={(v) => setOauthCode(v)}
              />
              <button
                type="button"
                className="btn-send"
                disabled={busy || !oauthCode.trim()}
                onClick={() => doLogin(oauthCode.trim())}
              >
                Complete sign-in
              </button>
            </div>
          )}
          {oauthUrl && (
            <p className="s-oauth-link">
              Open:{" "}
              <a href={oauthUrl} target="_blank" rel="noreferrer">
                {oauthUrl}
              </a>
            </p>
          )}
          <div className="settings-actions inline">
            <button
              type="button"
              className="btn-send"
              disabled={busy}
              onClick={() => doLogin()}
            >
              {busy ? "Waiting…" : signedInWithOauth ? "Sign in again" : `Sign in with ${provider.displayName}`}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy || !provider.hasRefreshToken}
              onClick={doRefreshToken}
            >
              Refresh token
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy || !provider.hasKey}
              onClick={doLogout}
            >
              Sign out
            </button>
            {busy ? <BusyDot /> : null}
          </div>
        </>
      )}

      <h4 className="settings-subhead">API key</h4>
      <p className="s-card-desc" style={{ marginBottom: 8 }}>
        Stored in the CLI keystore and never shown again. Env var: <code>{provider.envVar}</code>
        {oauthSupported ? " — optional if you use OAuth above." : ""}
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <TextInput
          value={apiKey}
          type="password"
          placeholder="sk-…"
          ariaLabel={`${provider.displayName} API key`}
          onCommit={(v) => setApiKeyInput(v)}
        />
        <button
          type="button"
          className="btn-send"
          disabled={busy || !apiKey.trim()}
          onClick={saveKey}
        >
          {provider.hasKey ? "Replace key" : "Save key"}
        </button>
      </div>
    </SettingsCard>
  );
}
