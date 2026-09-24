/**
 * AuthCard — step 2 of Models & Providers: connect one provider, either by
 * signing in with a subscription (OAuth, with the Anthropic 3-step stepper)
 * or with an API key. Plain-language copy and ⓘ help on every action.
 */
import { useEffect, useState } from "react";
import { loginOAuth, logoutOAuth, refreshOAuth, setApiKey } from "../../agentClient";
import type { DesktopProviderInfo } from "../../types";
import { SettingHelp } from "../SettingHelp";
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
  const name = provider.displayName;
  // "ChatGPT (OAuth)" → "ChatGPT": the auth hint in the display name reads
  // badly inside "Sign in with …" / "your … subscription".
  const brand = name.replace(/\s*\([^)]*\)\s*$/, "") || name;
  const isAnthropic = id === "anthropic";
  const oauthSupported =
    Boolean(provider.oauthSupported) ||
    id === "grok" ||
    id === "chatgpt" ||
    id === "anthropic" ||
    id === "muse";

  useEffect(() => {
    setOauthUrl(null);
    setOauthCode("");
    setApiKeyInput("");
    setStep(1);
  }, [id]);

  const signedInWithOauth = provider.hasKey && provider.authKind === "oauth";
  const expiry = formatExpiry(provider.expiresAt);
  const expired = expiry === "expired";

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
        return r.message ?? "Finish signing in in the browser, then paste the code below.";
      }
      setOauthUrl(null);
      setOauthCode("");
      setStep(3);
      await onRefresh();
      return r.message ?? `Signed in to ${name}.`;
    });

  const doRefreshToken = () =>
    void run(async () => {
      const r = await refreshOAuth({ provider: id });
      if (r.ok === false && r.error) throw new Error(r.error);
      await onRefresh();
      return r.message ?? `${name} session renewed.`;
    });

  const doLogout = () =>
    void run(async () => {
      const r = await logoutOAuth({ provider: id });
      if (r.ok === false && r.error) throw new Error(r.error);
      setOauthUrl(null);
      setOauthCode("");
      setStep(1);
      await onRefresh();
      return r.message ?? `Signed out of ${name}.`;
    });

  const saveKey = () =>
    void run(async () => {
      const key = apiKey.trim();
      if (!key) throw new Error("Paste an API key first.");
      const r = await setApiKey({ provider: id, key });
      setApiKeyInput("");
      await onRefresh();
      return `API key saved for ${r.provider ?? name} (${r.masked ?? "••••"}).`;
    });

  const status = signedInWithOauth ? (
    <StatusPill tone={expired ? "warn" : "ok"}>
      {expired ? "Session expired — sign in again" : `Signed in${expiry ? ` · ${expiry}` : ""}`}
    </StatusPill>
  ) : provider.hasKey ? (
    <StatusPill tone="ok">Connected with an API key</StatusPill>
  ) : (
    <StatusPill tone="warn">Not connected yet</StatusPill>
  );

  return (
    <SettingsCard
      title={`2 · Connect ${brand}`}
      description={
        oauthSupported
          ? "Sign in with your subscription, or paste an API key — one of the two is enough."
          : "Paste an API key from your provider's dashboard."
      }
      help={
        <SettingHelp id="tooltip-connect" label="Connect">
          Credentials stay on this computer, in the Zelari keystore used by the CLI. They are
          never shown again after saving.
        </SettingHelp>
      }
    >
      <p className="s-card-desc s-auth-status">{status}</p>

      {oauthSupported && (
        <>
          <h4 className="settings-subhead">
            Sign in with your {brand} subscription
            <span className="s-row-help-inline">
              <SettingHelp id="tooltip-oauth" label="Subscription sign-in">
                Uses the plan you already pay for (no API key needed). A browser window opens to
                confirm; the session is renewed automatically while it lasts.
              </SettingHelp>
            </span>
          </h4>
          {isAnthropic && (
            <div className="s-steps" aria-label="Anthropic sign-in steps">
              <span className={`s-step${step === 1 ? " current" : step > 1 ? " done" : ""}`}>
                1 · Open browser
              </span>
              <span className={`s-step${step === 2 ? " current" : step > 2 ? " done" : ""}`}>
                2 · Paste code
              </span>
              <span className={`s-step${step === 3 ? " current" : ""}`}>3 · Done</span>
            </div>
          )}
          {isAnthropic && step === 2 && (
            <div className="s-inline-form">
              <TextInput
                value={oauthCode}
                placeholder="Paste the code shown on the Anthropic page"
                ariaLabel="Anthropic sign-in code"
                onCommit={(v) => setOauthCode(v)}
              />
              <button
                type="button"
                className="btn-send"
                disabled={busy || !oauthCode.trim()}
                onClick={() => doLogin(oauthCode.trim())}
              >
                Finish sign-in
              </button>
            </div>
          )}
          {oauthUrl && (
            <p className="s-oauth-link">
              If the browser did not open:{" "}
              <a href={oauthUrl} target="_blank" rel="noreferrer">
                {oauthUrl}
              </a>
            </p>
          )}
          <div className="settings-actions inline">
            <button type="button" className="btn-send" disabled={busy} onClick={() => doLogin()}>
              {busy ? "Waiting…" : signedInWithOauth ? "Sign in again" : `Sign in with ${brand}`}
            </button>
            {signedInWithOauth ? (
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || !provider.hasRefreshToken}
                onClick={doRefreshToken}
                title={
                  provider.hasRefreshToken
                    ? "Extend the current session without signing in again"
                    : "This provider did not give a renewable session — use Sign in again"
                }
              >
                Renew session
              </button>
            ) : null}
            {provider.hasKey ? (
              <button
                type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={doLogout}
                title="Remove the saved sign-in / key from this computer"
              >
                Disconnect
              </button>
            ) : null}
            {busy ? <BusyDot /> : null}
          </div>
        </>
      )}

      <h4 className="settings-subhead">
        {oauthSupported ? "Or use an API key" : "API key"}
        <span className="s-row-help-inline">
          <SettingHelp id="tooltip-api-key" label="API key">
            Create one in your provider's dashboard. It is stored locally and never displayed
            again. You can also set the environment variable {provider.envVar} instead.
          </SettingHelp>
        </span>
      </h4>
      <div className="s-inline-form">
        <TextInput
          value={apiKey}
          type="password"
          placeholder={provider.hasKey ? "Paste a new key to replace the saved one" : "Paste your API key"}
          ariaLabel={`${name} API key`}
          onCommit={(v) => setApiKeyInput(v)}
        />
        <button type="button" className="btn-send" disabled={busy || !apiKey.trim()} onClick={saveKey}>
          {provider.hasKey ? "Replace key" : "Save key"}
        </button>
      </div>
    </SettingsCard>
  );
}
