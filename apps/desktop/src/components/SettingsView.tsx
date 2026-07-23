import { useEffect, useState } from "react";
import { setApiKey, setAppConfig } from "../agentClient";
import type { CliStatus, DesktopConfig, DispatchMode, WorkPhase } from "../types";
import { getAppVersion } from "../updater";
import { CliUpdateSection } from "./CliUpdateSection";
import { UpdateSection } from "./UpdateSection";
import { McpSection } from "./McpSection";
import { SkillsSection } from "./SkillsSection";
import { SshSection } from "./SshSection";
import { CompanionServeSection } from "./CompanionServeSection";

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
  { id: "defaults", label: "Defaults", hint: "Mode & phase for new chats" },
  { id: "extensions", label: "Extensions", hint: "MCP servers, skills & store" },
  { id: "connections", label: "Connections", hint: "SSH, Android companion" },
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
  }) => Promise<void>;
  onRefresh: () => Promise<void>;
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
}: Props) {
  const [tab, setTab] = useState<SettingsTab>(() => loadTab());
  const [provider, setProvider] = useState(config?.activeProviderId ?? "");
  const [model, setModel] = useState(
    config?.modelByProvider[config.activeProviderId] ?? "",
  );
  const [mode, setMode] = useState<DispatchMode>(defaultMode);
  const [phase, setPhase] = useState<WorkPhase>(defaultPhase);
  const [customModel, setCustomModel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("…");

  useEffect(() => {
    void getAppVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    if (!config) return;
    setProvider(config.activeProviderId);
    setModel(config.modelByProvider[config.activeProviderId] ?? "");
    const p = config.providers.find((x) => x.id === config.activeProviderId);
    setEndpoint(p?.endpoint ?? "");
  }, [config]);

  const providers = config?.providers ?? [];
  const active = providers.find((p) => p.id === provider);
  const models = active?.models ?? [];

  useEffect(() => {
    const p = providers.find((x) => x.id === provider);
    setEndpoint(p?.endpoint ?? "");
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

                <h3 className="settings-subhead">API key</h3>
                <p className="muted">
                  Stored in CLI keystore (never shown again). Env var:{" "}
                  <code>{active?.envVar ?? "—"}</code>
                </p>
                {active?.hasKey ? (
                  <p className="ok-inline">
                    Key on file for {active.displayName}.
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
                {provider === "grok" && (
                  <p className="muted" style={{ marginTop: 10 }}>
                    Grok OAuth: use CLI <code>/login grok</code> for device flow.
                  </p>
                )}

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
                <p className="muted settings-tip">
                  Tip: cycle mode with{" "}
                  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>, phase with{" "}
                  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>.
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
