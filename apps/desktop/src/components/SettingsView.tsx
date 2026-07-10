import { useEffect, useState } from "react";
import { setApiKey, setAppConfig } from "../agentClient";
import type { CliStatus, DesktopConfig, DispatchMode, WorkPhase } from "../types";
import { UpdateSection } from "./UpdateSection";

interface Props {
  config: DesktopConfig | null;
  cli: CliStatus | null;
  defaultMode: DispatchMode;
  defaultPhase: WorkPhase;
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
  onBack,
  onSave,
  onRefresh,
}: Props) {
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

  // Endpoint editing targets openai-compatible by default when switching
  useEffect(() => {
    const p = providers.find((x) => x.id === provider);
    setEndpoint(p?.endpoint ?? "");
  }, [provider, providers]);

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
      setMessage("Saved.");
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
      setMessage(`Key stored for ${r.provider ?? provider} (${r.masked ?? "••••"}).`);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-view">
      <header className="settings-header">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <h1>Settings</h1>
      </header>

      <div className="settings-body">
        <section className="settings-card">
          <h2>Provider & model</h2>
          <p className="muted">
            Persists to CLI <code>provider.json</code>.
          </p>
          <label className="field">
            <span>Active provider</span>
            <select
              value={provider}
              onChange={(e) => {
                const id = e.target.value;
                setProvider(id);
                const p = providers.find((x) => x.id === id);
                setModel(p?.defaultModel || config?.modelByProvider[id] || "");
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
            <select value={model} onChange={(e) => setModel(e.target.value)}>
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
        </section>

        <section className="settings-card">
          <h2>API key</h2>
          <p className="muted">
            Stored in CLI keystore (never shown again). Env var:{" "}
            <code>{active?.envVar ?? "—"}</code>
          </p>
          {active?.hasKey ? (
            <p className="ok-inline">Key on file for {active.displayName}.</p>
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
        </section>

        <section className="settings-card">
          <h2>Custom endpoint</h2>
          <p className="muted">
            OpenAI-compatible base URL (Ollama, LM Studio, vLLM, proxy…). Applies
            to the selected provider via <code>customEndpoints</code>.
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

        <section className="settings-card">
          <h2>Defaults for new chats</h2>
          <label className="field">
            <span>Mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as DispatchMode)}
            >
              <option value="agent">Agent — single LLM</option>
              <option value="council">Council — 6 members</option>
              <option value="zelari">Zelari — mission loop</option>
            </select>
          </label>
          <label className="field">
            <span>Phase</span>
            <select
              value={phase}
              onChange={(e) => setPhase(e.target.value as WorkPhase)}
            >
              <option value="plan">Plan — explore & design only</option>
              <option value="build">Build — implement with tools</option>
            </select>
          </label>
        </section>

        <UpdateSection autoCheck />

        <section className="settings-card">
          <h2>CLI side-car</h2>
          <dl className="kv">
            <dt>Status</dt>
            <dd>{cli?.ok ? "OK" : cli?.message ?? "—"}</dd>
            <dt>Version</dt>
            <dd>{cli?.cliVersion ?? config?.cliVersion ?? "—"}</dd>
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
        </section>

        {error && <p className="error-banner">{error}</p>}
        {message && <p className="ok-banner">{message}</p>}

        <div className="settings-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void onRefresh()}
          >
            Refresh
          </button>
          <button
            type="button"
            className="btn-send"
            disabled={saving || !provider}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save provider & model"}
          </button>
        </div>
      </div>
    </div>
  );
}
