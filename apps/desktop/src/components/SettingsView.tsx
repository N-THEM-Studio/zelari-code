import { useEffect, useState } from "react";
import type { CliStatus, DesktopConfig, DispatchMode, WorkPhase } from "../types";

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
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) return;
    setProvider(config.activeProviderId);
    setModel(config.modelByProvider[config.activeProviderId] ?? "");
  }, [config]);

  const providers = config?.providers ?? [];
  const active = providers.find((p) => p.id === provider);
  const models = active?.models ?? [];

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
            Persists to CLI <code>provider.json</code> (same as TUI{" "}
            <code>/provider</code> / <code>/model</code>).
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
            <span>Custom model id (optional override)</span>
            <input
              type="text"
              placeholder="e.g. MiniMax-M2.5"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
            />
          </label>
          {active && !active.hasKey && (
            <p className="warn">
              No key for {active.displayName}. Run in a terminal:{" "}
              <code>zelari-code</code> then <code>/login {active.id}</code> (or
              set <code>{active.envVar}</code>).
            </p>
          )}
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
          <p className="muted">
            API keys are never shown here. Manage credentials via the CLI.
          </p>
        </section>

        {error && <p className="error-banner">{error}</p>}
        {message && <p className="ok-banner">{message}</p>}

        <div className="settings-actions">
          <button type="button" className="btn-ghost" onClick={() => void onRefresh()}>
            Refresh
          </button>
          <button
            type="button"
            className="btn-send"
            disabled={saving || !provider}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
