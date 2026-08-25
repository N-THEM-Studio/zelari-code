import { useEffect, useState } from "react";
import {
  loginOAuth,
  logoutOAuth,
  refreshOAuth,
  setApiKey,
  setAppConfig,
} from "../agentClient";
import type { CliStatus, DesktopConfig, DispatchMode, WorkPhase } from "../types";
import {
  EXECUTION_PROFILES,
  type DesktopPrefs,
  type ExecutionProfile,
} from "../desktopPrefs";
import { getAppVersion } from "../updater";
import { CliUpdateSection } from "./CliUpdateSection";
import { UpdateSection } from "./UpdateSection";
import { McpSection } from "./McpSection";
import { SkillsSection } from "./SkillsSection";
import { SshSection } from "./SshSection";
import { CompanionServeSection } from "./CompanionServeSection";
import { SettingHelp } from "./SettingHelp";
import { KrakenModelSelect } from "./KrakenModelSelect";

type SettingsTab =
  | "provider"
  | "defaults"
  | "updates"
  | "extensions"
  | "connections"
  | "system";

const LS_TAB = "zelari-desktop-settings-tab";

const TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "provider", label: "Provider", hint: "Model, API key, endpoint" },
  { id: "defaults", label: "Defaults", hint: "Mode, phase & 2.0 profile" },
  { id: "extensions", label: "Extensions", hint: "MCP servers, skills & store" },
  { id: "connections", label: "Connections", hint: "Mobile QR, SSH" },
  { id: "updates", label: "Updates", hint: "Desktop app & CLI package" },
  { id: "system", label: "System", hint: "Paths, versions, shortcuts" },
];

/** Monochrome outline icons for settings nav. */
function TabIcon({ id }: { id: SettingsTab }) {
  const common = {
    viewBox: "0 0 16 16",
    className: "settings-tab-icon",
    "aria-hidden": true as const,
  };
  if (id === "provider") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (id === "defaults") {
    return (
      <svg {...common}>
        <path
          d="M3 3.5h10M3 8h10M3 12.5h6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (id === "extensions") {
    return (
      <svg {...common}>
        <path
          d="M6 2.5h4v3h3v4h-3v3H6v-3H3V5.5h3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (id === "connections") {
    return (
      <svg {...common}>
        <path
          d="M4 10.5a3 3 0 0 1 0-6h2M12 5.5a3 3 0 0 1 0 6h-2M6 8h4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (id === "updates") {
    return (
      <svg {...common}>
        <path
          d="M8 2.5v7M5 7l3 3 3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3 12.5h10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect
        x="2.5"
        y="2.5"
        width="11"
        height="11"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M5.5 6h5M5.5 8.5h5M5.5 11h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function loadTab(): SettingsTab {
  try {
    const t = localStorage.getItem(LS_TAB);
    if (
      t === "provider" ||
      t === "defaults" ||
      t === "updates" ||
      t === "extensions" ||
      t === "connections" ||
      t === "system"
    ) {
      return t;
    }
  } catch {
    /* ignore */
  }
  return "provider";
}

export type UiTheme = "dark" | "light";

interface Props {
  config: DesktopConfig | null;
  cli: CliStatus | null;
  defaultMode: DispatchMode;
  defaultPhase: WorkPhase;
  /** Open Folder cwd for project-scoped MCP. */
  workdir?: string | null;
  theme: UiTheme;
  onThemeChange: (theme: UiTheme) => void;
  onBack: () => void;
  onSave: (args: {
    provider: string;
    model: string;
    defaultMode: DispatchMode;
    defaultPhase: WorkPhase;
    prefs: DesktopPrefs;
  }) => Promise<void>;
  onRefresh: () => Promise<void>;
  prefs: DesktopPrefs;
}

export function SettingsView({
  config,
  cli,
  defaultMode,
  defaultPhase,
  workdir = null,
  theme,
  onThemeChange,
  onBack,
  onSave,
  onRefresh,
  prefs,
}: Props) {
  const [tab, setTab] = useState<SettingsTab>(() => loadTab());
  const [provider, setProvider] = useState(config?.activeProviderId ?? "");
  const [model, setModel] = useState(
    config?.modelByProvider[config.activeProviderId] ?? "",
  );
  const [mode, setMode] = useState<DispatchMode>(defaultMode);
  const [phase, setPhase] = useState<WorkPhase>(defaultPhase);
  const [customModel, setCustomModel] = useState("");
  const [profile, setProfile] = useState<ExecutionProfile>(prefs.profile);
  const [strictDone, setStrictDone] = useState(prefs.strictDone);
  const [missionStrict, setMissionStrict] = useState(prefs.missionStrict);
  const [verifyPack, setVerifyPack] = useState(prefs.verifyPack);
  const [verifierReview, setVerifierReview] = useState(
    prefs.verifierReview,
  );
  const [bonAlpha, setBonAlpha] = useState(prefs.bonAlpha);
  const [gauntletLoop, setGauntletLoop] = useState(prefs.gauntletLoop);
  const [krakenExploreModel, setKrakenExploreModel] = useState(
    prefs.krakenExploreModel,
  );
  const [krakenGeneralModel, setKrakenGeneralModel] = useState(
    prefs.krakenGeneralModel,
  );
  const [krakenVerifyModel, setKrakenVerifyModel] = useState(
    prefs.krakenVerifyModel,
  );
  const [krakenPlannerModel, setKrakenPlannerModel] = useState(
    prefs.krakenPlannerModel,
  );
  const [verifierMode, setVerifierMode] = useState<"inherit" | "custom">("inherit");
  const [verifierProvider, setVerifierProvider] = useState("");
  const [verifierModel, setVerifierModel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("…");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthCode, setOauthCode] = useState("");
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);

  useEffect(() => {
    void getAppVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    setProfile(prefs.profile);
    setStrictDone(prefs.strictDone);
    setMissionStrict(prefs.missionStrict);
    setVerifyPack(prefs.verifyPack);
    setVerifierReview(prefs.verifierReview);
    setBonAlpha(prefs.bonAlpha);
    setGauntletLoop(prefs.gauntletLoop);
    setKrakenExploreModel(prefs.krakenExploreModel);
    setKrakenGeneralModel(prefs.krakenGeneralModel);
    setKrakenVerifyModel(prefs.krakenVerifyModel);
    setKrakenPlannerModel(prefs.krakenPlannerModel);
  }, [prefs]);

  useEffect(() => {
    if (!config) return;
    setProvider(config.activeProviderId);
    setModel(config.modelByProvider[config.activeProviderId] ?? "");
    const p = config.providers.find((x) => x.id === config.activeProviderId);
    setEndpoint(p?.endpoint ?? "");
    if (config?.krakenVerifier) {
      setVerifierMode("custom");
      setVerifierProvider(config.krakenVerifier.provider);
      setVerifierModel(config.krakenVerifier.model);
    } else {
      setVerifierMode("inherit");
      setVerifierProvider("");
      setVerifierModel("");
    }
  }, [config]);

  const providers = config?.providers ?? [];
  const active = providers.find((p) => p.id === provider);
  const models = active?.models ?? [];

  useEffect(() => {
    const p = providers.find((x) => x.id === provider);
    setEndpoint(p?.endpoint ?? "");
    setOauthUrl(null);
    setOauthCode("");
  }, [provider, providers]);

  const selectTab = (id: SettingsTab) => {
    setTab(id);
    try {
      localStorage.setItem(LS_TAB, id);
    } catch {
      /* ignore */
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const finalModel = customModel.trim() || model;
      await onSave({
        provider,
        model: finalModel,
        defaultMode: mode,
        defaultPhase: phase,
        prefs: {
          profile,
          strictDone,
          missionStrict,
          verifyPack,
          verifierReview,
          bonAlpha,
          gauntletLoop,
          krakenExploreModel,
          krakenGeneralModel,
          krakenVerifyModel,
          krakenPlannerModel,
        },
      });
      setMessage("Saved provider, model & chat defaults.");
      setCustomModel("");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveEndpoint = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const url = endpoint.trim();
      if (!url) {
        setError("Enter an endpoint URL, or use Clear.");
        return;
      }
      await setAppConfig({ provider, endpoint: url });
      setMessage(`Endpoint saved for ${provider}.`);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveVerifier = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (!verifierProvider || !verifierModel) {
        setError("Pick a verifier provider and model.");
        return;
      }
      await setAppConfig({ verifierProvider, verifierModel });
      setMessage(`Kraken verifier set to ${verifierProvider} / ${verifierModel}.`);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const clearVerifier = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await setAppConfig({ verifierClear: true });
      setVerifierMode("inherit");
      setMessage("Kraken verifier inherits the current model.");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const clearEndpoint = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await setAppConfig({ provider, endpointClear: true });
      setEndpoint("");
      setMessage("Endpoint cleared.");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const oauthSupported =
    Boolean(active?.oauthSupported) ||
    provider === "grok" ||
    provider === "chatgpt" ||
    provider === "anthropic";

  const formatExpiry = (ms?: number | null) => {
    if (!ms) return null;
    const delta = ms - Date.now();
    if (delta <= 0) return "expired";
    const min = Math.round(delta / 60_000);
    if (min < 90) return `expires in ${min}m`;
    const hr = Math.round(min / 60);
    return `expires in ${hr}h`;
  };

  const runOAuthLogin = async (code?: string) => {
    setOauthBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await loginOAuth({ provider, code });
      if (r.ok === false && r.error) {
        setError(r.error);
        return;
      }
      if (r.phase === "need_code") {
        setOauthUrl(r.authorizeUrl ?? null);
        setMessage(
          r.message ??
            "Sign in in the browser, then paste the code below.",
        );
        if (r.authorizeUrl) {
          try {
            const { openUrl } = await import("@tauri-apps/plugin-opener");
            await openUrl(r.authorizeUrl);
          } catch {
            /* URL is shown in the form */
          }
        }
        return;
      }
      setOauthUrl(null);
      setOauthCode("");
      setMessage(r.message ?? `Signed in to ${provider}.`);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOauthBusy(false);
    }
  };

  const runOAuthRefresh = async () => {
    setOauthBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await refreshOAuth({ provider });
      if (r.ok === false && r.error) {
        setError(r.error);
        return;
      }
      setMessage(r.message ?? `Refreshed ${provider} token.`);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOauthBusy(false);
    }
  };

  const runOAuthLogout = async () => {
    setOauthBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await logoutOAuth({ provider });
      if (r.ok === false && r.error) {
        setError(r.error);
        return;
      }
      setOauthUrl(null);
      setOauthCode("");
      setMessage(r.message ?? `Signed out of ${provider}.`);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOauthBusy(false);
    }
  };

  const saveKey = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const key = apiKey.trim();
      if (!key) {
        setError("Enter an API key.");
        return;
      }
      const r = await setApiKey({ provider, key });
      setApiKeyInput("");
      setMessage(
        `Key stored for ${r.provider ?? provider} (${r.masked ?? "••••"}).`,
      );
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const revealConfigDir = async () => {
    const p = config?.configPaths.provider;
    if (!p) return;
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="settings-view">
      <header className="settings-header">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <h1>Settings</h1>
        <button
          type="button"
          className="btn-ghost settings-header-refresh"
          onClick={() => void onRefresh()}
          title="Reload CLI config & status"
        >
          Refresh
        </button>
      </header>

      <div className="settings-shell">
        <nav className="settings-nav" role="tablist" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`settings-nav-item${tab === t.id ? " active" : ""}`}
              title={t.hint}
              onClick={() => selectTab(t.id)}
            >
              <span className="settings-nav-row">
                <TabIcon id={t.id} />
                <span className="settings-nav-label">{t.label}</span>
              </span>
              <span className="settings-nav-hint">{t.hint}</span>
            </button>
          ))}
        </nav>

        <div className="settings-main" role="tabpanel">
          {tab === "provider" && (
              <section className="settings-card settings-card-flush">
                <h2>Provider & model</h2>
                <p className="muted">
                  Persists to CLI <code>provider.json</code>. Active choice is
                  also used by the chat toolbar.
                </p>

                <label className="field">
                  <span>Active provider</span>
                  <select
                    value={provider}
                    onChange={(e) => {
                      const id = e.target.value;
                      setProvider(id);
                      const p = providers.find((x) => x.id === id);
                      setModel(
                        p?.defaultModel ||
                          config?.modelByProvider[id] ||
                          "",
                      );
                    }}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                        {p.hasKey ? "" : " — no API key"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Model</span>
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {!models.includes(model) && model && (
                      <option value={model}>{model}</option>
                    )}
                  </select>
                </label>
                <label className="field">
                  <span>Custom model id (optional)</span>
                  <input
                    type="text"
                    placeholder="e.g. MiniMax-M2.5"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                  />
                </label>

                <h3 className="settings-subhead">
                  Kraken — Advisory verification model
                </h3>
                <p className="muted">
                  Optional LLM judge for Kraken selection (inherit or dedicated
                  provider/model). Advisory only — never a done signal and never
                  a substitute for the deterministic gate or the Verify tentacle.
                  Persists to CLI <code>provider.json</code>.
                </p>
                <label className="field">
                  <span className="field-label-row">
                    <span>Advisory verification model</span>
                    <SettingHelp
                      id="tooltip-advisory-verifier-provider"
                      label="Advisory verifier"
                    >
                      Optional LLM judge that provides an additional review of
                      Kraken&apos;s result. It is advisory and does not replace
                      deterministic verification gates. Its provider and model
                      are configured separately in Provider settings.
                    </SettingHelp>
                  </span>
                  <select
                    value={verifierMode}
                    onChange={(e) => {
                      const v = e.target.value as "inherit" | "custom";
                      setVerifierMode(v);
                      if (v === "custom" && !verifierProvider && providers.length > 0) {
                        const first = providers[0];
                        setVerifierProvider(first.id);
                        setVerifierModel(
                          first.defaultModel || first.models[0] || "",
                        );
                      }
                    }}
                  >
                    <option value="inherit">
                      Same as current model (recommended)
                    </option>
                    <option value="custom">Custom provider + model…</option>
                  </select>
                </label>
                {verifierMode === "custom" && (
                  <>
                    <label className="field">
                      <span>Verifier provider</span>
                      <select
                        value={verifierProvider}
                        onChange={(e) => {
                          const id = e.target.value;
                          setVerifierProvider(id);
                          const p = providers.find((x) => x.id === id);
                          setVerifierModel(
                            p?.defaultModel || p?.models[0] || "",
                          );
                        }}
                      >
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName}
                            {p.hasKey ? "" : " — no API key"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Verifier model</span>
                      <select
                        value={verifierModel}
                        onChange={(e) => setVerifierModel(e.target.value)}
                      >
                        {(providers.find((x) => x.id === verifierProvider)?.models ?? []).map(
                          (m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ),
                        )}
                        {verifierModel &&
                          !(providers.find((x) => x.id === verifierProvider)?.models ?? []).includes(
                            verifierModel,
                          ) && <option value={verifierModel}>{verifierModel}</option>}
                      </select>
                    </label>
                    <div className="settings-actions inline">
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={saving || !verifierProvider || !verifierModel}
                        onClick={() => void saveVerifier()}
                      >
                        {saving ? "Saving…" : "Save verifier"}
                      </button>
                    </div>
                  </>
                )}
                {verifierMode === "inherit" && config?.krakenVerifier && (
                  <div className="settings-actions inline">
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={saving}
                      onClick={() => void clearVerifier()}
                    >
                      {saving ? "Saving…" : "Reset to inherit"}
                    </button>
                  </div>
                )}
                {config?.krakenVerifier && (
                  <p className="muted">
                    Current override: {config.krakenVerifier.provider} /{" "}
                    {config.krakenVerifier.model}
                  </p>
                )}

                {oauthSupported && (
                  <>
                    <h3 className="settings-subhead">Account login (OAuth)</h3>
                    <p className="muted">
                      Subscription login — not an API key. Grok and ChatGPT
                      open a device/magic-link page; Anthropic asks you to
                      paste the code after signing in.
                    </p>
                    {active?.hasKey && active.authKind === "oauth" ? (
                      <p className="ok-inline">
                        Signed in to {active.displayName}
                        {formatExpiry(active.expiresAt)
                          ? ` — ${formatExpiry(active.expiresAt)}`
                          : ""}
                        {active.hasRefreshToken ? " · refresh token saved" : ""}.
                      </p>
                    ) : active?.hasKey ? (
                      <p className="ok-inline">
                        API key on file for {active.displayName}. You can still
                        switch to OAuth below.
                      </p>
                    ) : (
                      <p className="warn">Not signed in for this provider.</p>
                    )}
                    {oauthUrl && (
                      <p className="muted oauth-url">
                        Open:{" "}
                        <a href={oauthUrl} target="_blank" rel="noreferrer">
                          {oauthUrl}
                        </a>
                      </p>
                    )}
                    {provider === "anthropic" && (
                      <label className="field">
                        <span>Paste magic-link code (CODE#STATE)</span>
                        <input
                          type="text"
                          autoComplete="off"
                          placeholder="Paste the code from the Anthropic page"
                          value={oauthCode}
                          onChange={(e) => setOauthCode(e.target.value)}
                        />
                      </label>
                    )}
                    <div className="settings-actions inline">
                      <button
                        type="button"
                        className="btn-send"
                        disabled={oauthBusy || saving}
                        onClick={() => void runOAuthLogin()}
                      >
                        {oauthBusy
                          ? "Waiting…"
                          : active?.hasKey && active.authKind === "oauth"
                            ? "Sign in again"
                            : `Sign in with ${active?.displayName ?? provider}`}
                      </button>
                      {provider === "anthropic" && (
                        <button
                          type="button"
                          className="btn-send"
                          disabled={oauthBusy || saving || !oauthCode.trim()}
                          onClick={() => void runOAuthLogin(oauthCode.trim())}
                        >
                          Complete sign-in
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={
                          oauthBusy || saving || !active?.hasRefreshToken
                        }
                        onClick={() => void runOAuthRefresh()}
                      >
                        Refresh token
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={oauthBusy || saving || !active?.hasKey}
                        onClick={() => void runOAuthLogout()}
                      >
                        Sign out
                      </button>
                    </div>
                  </>
                )}

                <h3 className="settings-subhead">API key</h3>
                <p className="muted">
                  Stored in CLI keystore (never shown again). Env var:{" "}
                  <code>{active?.envVar ?? "—"}</code>
                  {oauthSupported
                    ? " — optional if you use OAuth above."
                    : ""}
                </p>
                {active?.hasKey ? (
                  <p className="ok-inline">
                    {active.authKind === "oauth"
                      ? `OAuth token on file for ${active.displayName}.`
                      : `Key on file for ${active.displayName}.`}
                  </p>
                ) : (
                  <p className="warn">No key for this provider yet.</p>
                )}
                <label className="field">
                  <span>
                    {active?.hasKey ? "Replace key" : "Paste API key"}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="sk-…"
                    value={apiKey}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                  />
                </label>
                <div className="settings-actions inline">
                  <button
                    type="button"
                    className="btn-send"
                    disabled={saving || !apiKey.trim()}
                    onClick={() => void saveKey()}
                  >
                    Save key
                  </button>
                </div>

                <h3 className="settings-subhead">Custom endpoint</h3>
                <p className="muted">
                  OpenAI-compatible base URL (Ollama, LM Studio, vLLM, proxy…).
                  Applies via <code>customEndpoints</code>.
                </p>
                {active?.baseUrl && (
                  <p className="muted">
                    Effective base: <code>{active.baseUrl}</code>
                  </p>
                )}
                <label className="field">
                  <span>Base URL</span>
                  <input
                    type="url"
                    placeholder="http://127.0.0.1:11434/v1"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                  />
                </label>
                <div className="settings-actions inline">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={saving}
                    onClick={() => void clearEndpoint()}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    className="btn-send"
                    disabled={saving || !endpoint.trim()}
                    onClick={() => void saveEndpoint()}
                  >
                    Save endpoint
                  </button>
                </div>
              </section>
          )}

          {tab === "defaults" && (
              <section className="settings-card settings-card-flush">
                <h2>Defaults for new chats</h2>
                <p className="muted">
                  Applied when you create a new chat. Per-chat mode/phase still
                  override from the toolbar.
                </p>
                <label className="field">
                  <span>Mode</span>
                  <select
                    value={mode}
                    onChange={(e) =>
                      setMode(e.target.value as DispatchMode)
                    }
                  >
                    <option value="kraken">Kraken — super-agent</option>
                    <option value="council">Council — 6 members</option>
                    <option value="zelari">Zelari — mission loop</option>
                  </select>
                </label>
                <label className="field">
                  <span>Phase</span>
                  <select
                    value={phase}
                    onChange={(e) =>
                      setPhase(e.target.value as WorkPhase)
                    }
                  >
                    <option value="plan">
                      Plan — explore & design only
                    </option>
                    <option value="build">
                      Build — implement with tools
                    </option>
                  </select>
                </label>
                <h3 className="settings-subhead">Execution profile (2.0)</h3>
                <p className="muted">
                  Capability set recorded on the session spine. Default follows
                  the chat mode; override here for every new run.
                </p>
                <label className="field">
                  <span className="field-label-row">
                    <span>Profile</span>
                    <SettingHelp id="tooltip-execution-profile" label="Execution profile">
                      Selects the capability profile used by the Desktop execution pipeline.
                      kraken/v1 is the normal Kraken profile; other profiles change the available
                      agent workflow and capabilities.
                    </SettingHelp>
                  </span>
                  <select
                    value={profile}
                    onChange={(e) =>
                      setProfile(e.target.value as ExecutionProfile)
                    }
                  >
                    {EXECUTION_PROFILES.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
                <h3 className="settings-subhead">Verification & experiments</h3>
                <p className="muted">
                  These switches are saved locally and applied to every new
                  run, including the floating overlay.
                </p>
                <label className="field field-check">
                  <input
                    type="checkbox"
                    checked={strictDone}
                    onChange={(e) => setStrictDone(e.target.checked)}
                  />
                  <span className="field-label-row">
                    <span>
                      Kraken strict gate — unknown ≠ pass, no done without
                      evidence
                    </span>
                    <SettingHelp id="tooltip-kraken-strict" label="Kraken strict gate">
                      Requires sufficient verification evidence before Kraken can mark a task as
                      complete. An unknown verification state is not treated as a pass.
                    </SettingHelp>
                  </span>
                </label>
                <label className="field field-check">
                  <input
                    type="checkbox"
                    checked={missionStrict}
                    onChange={(e) => setMissionStrict(e.target.checked)}
                  />
                  <span className="field-label-row">
                    <span>
                      Mission strict gate — enabled by default for Zelari
                      missions
                    </span>
                    <SettingHelp id="tooltip-mission-strict" label="Mission strict gate">
                      Applies strict completion evidence rules to Zelari/Mission runs before the
                      mission can be considered complete.
                    </SettingHelp>
                  </span>
                </label>
                <label className="field field-check">
                  <input
                    type="checkbox"
                    checked={verifyPack}
                    onChange={(e) => setVerifyPack(e.target.checked)}
                  />
                  <span className="field-label-row">
                    <span>
                      Native criteria pack — run project typecheck, tests and
                      build when available
                    </span>
                    <SettingHelp id="tooltip-native-pack" label="Native criteria pack">
                      Runs deterministic project checks such as typecheck, tests and build when
                      the project exposes the corresponding commands.
                    </SettingHelp>
                  </span>
                </label>
                <label className="field">
                  <span className="field-label-row">
                    <span>Advisory verifier review</span>
                    <SettingHelp id="tooltip-advisory-review" label="Advisory verifier review">
                      Controls whether Zelari asks the configured advisory verification model for
                      an additional LLM review. This review does not replace deterministic gates.
                    </SettingHelp>
                  </span>
                  <select
                    value={
                      verifierReview === null
                        ? "auto"
                        : verifierReview
                          ? "on"
                          : "off"
                    }
                    onChange={(e) =>
                      setVerifierReview(
                        e.target.value === "auto"
                          ? null
                          : e.target.value === "on",
                      )
                    }
                  >
                    <option value="auto">
                      Automatic — enabled by a dedicated verifier model
                    </option>
                    <option value="on">Always on</option>
                    <option value="off">Always off</option>
                  </select>
                </label>
                <label className="field field-check">
                  <input
                    type="checkbox"
                    checked={bonAlpha}
                    onChange={(e) => setBonAlpha(e.target.checked)}
                  />
                  <span className="field-label-row">
                    <span>
                      Best-of-N alpha (N=3, experimental) — never flips the
                      deterministic gate
                    </span>
                    <SettingHelp id="tooltip-bon-alpha" label="Best-of-N alpha">
                      Experimental test-time compute mode that generates and evaluates multiple
                      candidate solutions. It can increase quality on difficult tasks but also
                      increases latency and model usage.
                    </SettingHelp>
                  </span>
                </label>
                <label className="field field-check">
                  <input
                    type="checkbox"
                    checked={gauntletLoop}
                    onChange={(e) => setGauntletLoop(e.target.checked)}
                  />
                  <span className="field-label-row">
                    <span>
                      Gauntlet Loop — host-driven builder/critic rounds (capped;
                      exclusive with Graph). Same as the top-bar toggle.
                    </span>
                    <SettingHelp id="tooltip-gauntlet-loop" label="Gauntlet Loop">
                      Runs iterative builder-versus-critic rounds so the implementation can be
                      challenged and revised multiple times. Intended for difficult tasks and
                      higher verification effort.
                    </SettingHelp>
                  </span>
                </label>
                <h3 className="settings-subhead">Kraken — Model Routing</h3>
                <p className="muted">
                  Configure which model Kraken uses for each role. Empty /
                  inherit values fall back to Kraken defaults. Inherit sends no
                  Desktop override; Kraken uses its normal model selection and
                  fallback rules.
                </p>
                <div className="field">
                  <span className="field-label-row">
                    <span>Lead model</span>
                    <SettingHelp id="tooltip-kraken-lead" label="Kraken Lead">
                      The main Kraken model. It coordinates the task, decides when to delegate
                      work to tentacles, evaluates their results, and produces the final response.
                      This model is selected from the main model control in the toolbar.
                    </SettingHelp>
                  </span>
                  <p className="muted settings-lead-model">
                    Current toolbar model: {customModel.trim() || model || "not set"}
                  </p>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => selectTab("provider")}
                  >
                    Change in Provider
                  </button>
                </div>
                <KrakenModelSelect
                  label="Explore tentacles"
                  tooltipId="tooltip-kraken-explore"
                  tooltip="Read-oriented Kraken sub-agents used to inspect the repository, locate symbols, understand architecture and gather context. A fast, lower-cost model is usually sufficient because Explore normally does not implement the final code changes."
                  value={krakenExploreModel}
                  models={models}
                  inheritLabel="Inherit / Kraken default"
                  onChange={setKrakenExploreModel}
                />
                <KrakenModelSelect
                  label="General tentacles"
                  tooltipId="tooltip-kraken-general"
                  tooltip="Code-writing Kraken sub-agents used for implementation tasks. They may edit files and perform delegated coding work. Prefer a strong coding model when the task is complex or the changes are high impact."
                  value={krakenGeneralModel}
                  models={models}
                  inheritLabel="Inherit / Kraken lead"
                  onChange={setKrakenGeneralModel}
                />
                <KrakenModelSelect
                  label="Verify tentacles"
                  tooltipId="tooltip-kraken-verify"
                  tooltip="Kraken sub-agents dedicated to checking completed work. They can review changes, inspect test/build results and look for regressions before the parent agent considers the task complete. This is different from the Advisory verification model."
                  value={krakenVerifyModel}
                  models={models}
                  inheritLabel="Inherit / Kraken default"
                  onChange={setKrakenVerifyModel}
                />
                <KrakenModelSelect
                  label="Graph planner"
                  tooltipId="tooltip-kraken-planner"
                  tooltip="Model used to plan Kraken Graph tasks as a dependency graph (DAG). It decides how a large goal can be split into nodes and which work can run in parallel. A fast non-reasoning or lower-latency model is often sufficient for this structured planning step."
                  value={krakenPlannerModel}
                  models={models}
                  inheritLabel="Inherit / Kraken lead"
                  onChange={setKrakenPlannerModel}
                />
                <div className="field">
                  <span className="field-label-row">
                    <span>Advisory verifier</span>
                    <SettingHelp id="tooltip-kraken-advisory" label="Advisory verifier">
                      Optional LLM judge that provides an additional review of Kraken's result.
                      It is advisory and does not replace deterministic verification gates.
                      Its provider and model are configured separately in Provider settings.
                    </SettingHelp>
                  </span>
                  <p className="muted">
                    Configured separately in Provider settings
                  </p>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => selectTab("provider")}
                  >
                    Open Provider settings
                  </button>
                </div>
                <p className="muted">
                  Typical setup: Explore → fast / low-cost · General → strongest
                  coding model · Verify → reliable coding/review model · Planner
                  → fast / low-latency
                </p>
                <p className="muted settings-tip">
                  Tip: cycle mode with{" "}
                  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>, phase with{" "}
                  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>. Click Save
                  provider / defaults to persist profile, gates and
                  experiments.
                </p>
              </section>
          )}

          {tab === "extensions" && (
              <div className="settings-stack">
                <McpSection
                  workdir={workdir}
                  onStatus={(msg) => {
                    setMessage(msg);
                    setError(null);
                  }}
                />
                <SkillsSection
                  workdir={workdir}
                  provider={provider}
                  model={customModel.trim() || model}
                  onStatus={(msg) => {
                    setMessage(msg);
                    setError(null);
                  }}
                />
              </div>
          )}

          {tab === "connections" && (
              <div className="settings-stack">
                <CompanionServeSection
                  workdir={workdir}
                  onStatus={(msg) => {
                    setMessage(msg);
                    setError(null);
                  }}
                />
                <SshSection
                  onStatus={(msg) => {
                    setMessage(msg);
                    setError(null);
                  }}
                />
              </div>
          )}

          {tab === "updates" && (
              <div className="settings-stack">
                <UpdateSection autoCheck />
                <CliUpdateSection cli={cli} onCliRefreshed={onRefresh} />
              </div>
          )}

          {tab === "system" && (
              <div className="settings-stack">
                <section className="settings-card">
                  <h2>Appearance</h2>
                  <p className="muted">
                    Dark is the default liquid-glass look. Light uses the same
                    layout with a blue-tinted light palette.
                  </p>
                  <div
                    className="theme-toggle"
                    role="group"
                    aria-label="Color theme"
                  >
                    <button
                      type="button"
                      className={theme === "dark" ? "active" : ""}
                      onClick={() => onThemeChange("dark")}
                    >
                      Dark
                    </button>
                    <button
                      type="button"
                      className={theme === "light" ? "active" : ""}
                      onClick={() => onThemeChange("light")}
                    >
                      Light
                    </button>
                  </div>
                </section>

                <section className="settings-card">
                  <h2>Versions</h2>
                  <dl className="kv">
                    <dt>Desktop</dt>
                    <dd>
                      <code>v{appVersion}</code>
                    </dd>
                    <dt>CLI</dt>
                    <dd>
                      <code>
                        {cli?.cliVersion
                          ? cli.cliVersion.replace(/^zelari-code\s+/i, "")
                          : "—"}
                      </code>
                    </dd>
                    <dt>CLI status</dt>
                    <dd>{cli?.ok ? "OK" : cli?.message ?? "—"}</dd>
                  </dl>
                </section>

                <section className="settings-card">
                  <h2>Paths</h2>
                  <dl className="kv">
                    <dt>CLI path</dt>
                    <dd>
                      <code>{cli?.cliPath ?? "—"}</code>
                    </dd>
                    <dt>provider.json</dt>
                    <dd>
                      <code>{config?.configPaths.provider ?? "—"}</code>
                    </dd>
                    <dt>keys.json</dt>
                    <dd>
                      <code>{config?.configPaths.keys ?? "—"}</code>
                    </dd>
                  </dl>
                  {config?.configPaths.provider && (
                    <div className="settings-actions inline">
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => void revealConfigDir()}
                      >
                        Open config folder
                      </button>
                    </div>
                  )}
                </section>

                <section className="settings-card">
                  <h2>Keyboard shortcuts</h2>
                  <dl className="kv shortcuts-kv">
                    <dt>
                      <kbd>Esc</kbd>
                    </dt>
                    <dd>Stop active run</dd>
                    <dt>
                      <kbd>Ctrl</kbd>+<kbd>N</kbd>
                    </dt>
                    <dd>New chat</dd>
                    <dt>
                      <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>
                    </dt>
                    <dd>Cycle mode (Agent → Council → Zelari)</dd>
                    <dt>
                      <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>
                    </dt>
                    <dd>Toggle phase (Plan / Build)</dd>
                    <dt>
                      <kbd>Enter</kbd>
                    </dt>
                    <dd>Send message (Shift+Enter for newline)</dd>
                  </dl>
                  <p className="muted">
                    On macOS use <kbd>⌘</kbd> instead of Ctrl.
                  </p>
                </section>

                <section className="settings-card">
                  <h2>MCP tools</h2>
                  <p className="muted">
                    Project MCP servers are loaded from{" "}
                    <code>.zelari/mcp.json</code> (or{" "}
                    <code>~/.zelari-code/mcp.json</code>) when a headless task
                    runs. Desktop inherits the same tools as the CLI.
                  </p>
                  <p className="muted">
                    Kill switch: set env <code>ZELARI_MCP=0</code> to disable MCP
                    registration.
                  </p>
                </section>
              </div>
          )}
        </div>
      </div>

      <footer className="settings-footer">
        <div className="settings-footer-msg">
          {error && <p className="error-banner footer-banner">{error}</p>}
          {message && !error && (
            <p className="ok-banner footer-banner">{message}</p>
          )}
          {!error && !message && (
            <span className="settings-footer-hint">
              Save applies provider, model &amp; defaults
            </span>
          )}
        </div>
        <div className="settings-actions settings-footer-actions">
          <button
            type="button"
            className="btn-send"
            disabled={saving || !provider}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </div>
  );
}
