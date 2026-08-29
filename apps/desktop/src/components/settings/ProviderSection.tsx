/**
 * Models & Providers — provider grid with auth status, model picker,
 * custom model id and advanced endpoint. Click-to-switch autosaves.
 */
import { useEffect, useState } from "react";
import { setAppConfig } from "../../agentClient";
import type { DesktopConfig, DesktopProviderInfo } from "../../types";
import { AuthCard } from "./AuthCard";
import { modelLabel, resolveModelId } from "./modelUtils";
import {
  BusyDot,
  SelectInput,
  SettingsCard,
  SettingsRow,
  StatusPill,
  TextInput,
} from "./primitives";
import { useSettingAction } from "./useSettingAction";

export interface ProviderSectionProps {
  config: DesktopConfig | null;
  onRefresh: () => Promise<void>;
  /** Notifies the chat toolbar (App state) after a successful autosave. */
  onActiveProviderChange: (provider: string, model: string) => void;
}

function authPill(p: DesktopProviderInfo) {
  if (p.hasKey && p.authKind === "oauth") {
    return <StatusPill tone="ok">OAuth</StatusPill>;
  }
  if (p.hasKey) {
    return <StatusPill tone="ok">API key</StatusPill>;
  }
  return <StatusPill tone="warn">Not configured</StatusPill>;
}

export function ProviderSection({
  config,
  onRefresh,
  onActiveProviderChange,
}: ProviderSectionProps) {
  const { busy, run } = useSettingAction();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState("");
  const [endpointDraft, setEndpointDraft] = useState<string | null>(null);

  const providers = config?.providers ?? [];
  const activeId = config?.activeProviderId ?? "";
  const active = providers.find((p) => p.id === activeId) ?? null;
  const currentModel = active
    ? (config?.modelByProvider[active.id] ?? active.defaultModel ?? active.models[0] ?? "")
    : "";

  useEffect(() => {
    setCustomModel("");
    setEndpointDraft(null);
    setPendingId(null);
  }, [activeId]);

  const switchProvider = (id: string) => {
    if (busy || id === activeId) return;
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    const model = config?.modelByProvider[id] || p.defaultModel || p.models[0] || "";
    setPendingId(id);
    void run(async () => {
      await setAppConfig({ provider: id, model });
      await onRefresh();
      onActiveProviderChange(id, model);
      return `Active provider: ${p.displayName}`;
    }).finally(() => setPendingId(null));
  };

  const saveModel = (model: string) =>
    void run(async () => {
      await setAppConfig({ provider: activeId, model });
      await onRefresh();
      onActiveProviderChange(activeId, model);
      return `Model: ${model}`;
    });

  const saveEndpoint = (value: string) => {
    const url = value.trim();
    if (!url) return;
    void run(async () => {
      await setAppConfig({ provider: activeId, endpoint: url });
      await onRefresh();
      return `Endpoint saved for ${active?.displayName ?? activeId}`;
    });
  };

  const clearEndpoint = () =>
    void run(async () => {
      await setAppConfig({ provider: activeId, endpointClear: true });
      setEndpointDraft("");
      await onRefresh();
      return "Endpoint cleared";
    });

  return (
    <>
      <div className="settings-section-head">
        <h2>Models &amp; Providers</h2>
        <p>
          Which AI provider and model new chats use. Click a card to activate it — saves
          immediately to provider.json.
        </p>
      </div>

      <SettingsCard
        title="Active provider"
        description="The highlighted card is used by the chat toolbar and by every new run."
      >
        <div className="s-provider-grid">
          {providers.map((p) => {
            const isActive = p.id === activeId;
            const switching = pendingId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                className={`s-provider-card${isActive ? " active" : ""}`}
                onClick={() => switchProvider(p.id)}
                aria-pressed={isActive}
              >
                <span className="s-provider-name">{p.displayName}</span>
                {authPill(p)}
                <span className="s-provider-model">
                  {modelLabel(config?.modelByProvider[p.id] ?? p.defaultModel)}
                </span>
                {switching ? <BusyDot /> : null}
              </button>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard
        title={`Model — ${active?.displayName ?? "…"}`}
        description="Applies to the active provider only. Persists to CLI provider.json."
      >
        <SettingsRow
          label="Model"
          hint={
            active?.thinkingCapability
              ? "This provider supports thinking/reasoning levels."
              : undefined
          }
        >
          <SelectInput
            value={currentModel}
            ariaLabel="Model"
            disabled={!active}
            onChange={saveModel}
          >
            {(active?.models ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {currentModel && !(active?.models ?? []).includes(currentModel) && (
              <option value={currentModel}>{currentModel}</option>
            )}
          </SelectInput>
          {busy ? <BusyDot /> : null}
        </SettingsRow>
        <SettingsRow
          label="Custom model id"
          hint="Optional — overrides the preset when non-empty (e.g. MiniMax-M2.5, local models)."
        >
          <TextInput
            value={customModel}
            placeholder="e.g. MiniMax-M2.5"
            ariaLabel="Custom model id"
            disabled={!active}
            onCommit={(v) => {
              setCustomModel(v);
              saveModel(resolveModelId(v, currentModel));
            }}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Advanced"
        description="OpenAI-compatible base URL for local runtimes and proxies (Ollama, LM Studio, vLLM…)."
      >
        <SettingsRow
          label="Base URL"
          hint={
            active?.baseUrl ? (
              <>
                Effective base: <code>{active.baseUrl}</code>
              </>
            ) : (
              "Applies via customEndpoints."
            )
          }
        >
          <TextInput
            value={endpointDraft ?? active?.endpoint ?? ""}
            placeholder="http://127.0.0.1:11434/v1"
            ariaLabel="Base URL"
            disabled={!active}
            onCommit={(v) => {
              setEndpointDraft(v);
              saveEndpoint(v);
            }}
          />
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || !active?.endpoint}
            onClick={clearEndpoint}
          >
            Clear
          </button>
        </SettingsRow>
      </SettingsCard>

      {active ? <AuthCard provider={active} onRefresh={onRefresh} /> : null}
    </>
  );
}
