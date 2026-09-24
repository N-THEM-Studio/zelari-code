/**
 * Models & Providers — a guided three-step flow: choose a provider, connect
 * the account, pick a model. Rarely-touched connection details (base URL, API
 * style) live in a collapsible block. Every control autosaves.
 */
import { useEffect, useState } from "react";
import { setAppConfig } from "../../agentClient";
import type { DesktopConfig, DesktopProviderInfo } from "../../types";
import { SettingHelp } from "../SettingHelp";
import { AuthCard } from "./AuthCard";
import { modelLabel } from "./modelUtils";
import {
  BusyDot,
  ChoiceList,
  Collapsible,
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

/** Sentinel option value of the model picker that reveals the free-text field. */
const OTHER_MODEL = "__other__";

/** Providers whose whole point is a user-supplied endpoint. */
const ENDPOINT_PROVIDERS = new Set(["openai-compatible", "custom"]);

export function connectionPill(p: DesktopProviderInfo) {
  if (p.hasKey && p.authKind === "oauth") {
    return p.expiresAt && p.expiresAt <= Date.now() ? (
      <StatusPill tone="warn">Sign-in expired</StatusPill>
    ) : (
      <StatusPill tone="ok">Connected · sign-in</StatusPill>
    );
  }
  if (p.hasKey) return <StatusPill tone="ok">Connected · API key</StatusPill>;
  return <StatusPill tone="warn">Not connected</StatusPill>;
}

export function ProviderSection({
  config,
  onRefresh,
  onActiveProviderChange,
}: ProviderSectionProps) {
  const { busy, run } = useSettingAction();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [typingOther, setTypingOther] = useState(false);
  const [endpointDraft, setEndpointDraft] = useState<string | null>(null);

  const providers = config?.providers ?? [];
  const activeId = config?.activeProviderId ?? "";
  const active = providers.find((p) => p.id === activeId) ?? null;
  const presetModels = active?.models ?? [];
  const currentModel = active
    ? (config?.modelByProvider[active.id] ?? active.defaultModel ?? presetModels[0] ?? "")
    : "";
  const isCustomModel = Boolean(currentModel) && !presetModels.includes(currentModel);
  const showOtherField = typingOther || isCustomModel || presetModels.length === 0;

  useEffect(() => {
    setTypingOther(false);
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
      return `Now using ${p.displayName}`;
    }).finally(() => setPendingId(null));
  };

  const saveModel = (model: string) => {
    const m = model.trim();
    if (!m || m === currentModel) return;
    void run(async () => {
      await setAppConfig({ provider: activeId, model: m });
      await onRefresh();
      onActiveProviderChange(activeId, m);
      return `Model set to ${m}`;
    });
  };

  const saveEndpoint = (value: string) => {
    const url = value.trim();
    if (!url) return;
    void run(async () => {
      await setAppConfig({ provider: activeId, endpoint: url });
      await onRefresh();
      return `Server address saved for ${active?.displayName ?? activeId}`;
    });
  };

  const clearEndpoint = () =>
    void run(async () => {
      await setAppConfig({ provider: activeId, endpointClear: true });
      setEndpointDraft("");
      await onRefresh();
      return "Back to the default server address";
    });

  const saveApiStyle = (style: "chat" | "responses") =>
    void run(async () => {
      await setAppConfig({ provider: activeId, apiStyle: style });
      await onRefresh();
      return style === "responses" ? "Using the Responses API" : "Using Chat Completions";
    });

  return (
    <>
      <div className="settings-section-head">
        <h2>Models &amp; Providers</h2>
        <p>
          Choose the AI service Zelari talks to, connect your account, then pick a model.
          Changes apply from your next message.
        </p>
      </div>

      <SettingsCard
        title="1 · Choose a provider"
        description="Click a card to use it for new messages. Every chat can still switch model from the bar above the composer."
        help={
          <SettingHelp id="tooltip-provider" label="Provider">
            A provider is the company or server that runs the AI model (for example OpenAI,
            Anthropic, xAI, a local Ollama). You can connect several and switch any time.
          </SettingHelp>
        }
      >
        <div className="s-provider-grid">
          {providers.map((p) => {
            const isActive = p.id === activeId;
            return (
              <button
                key={p.id}
                type="button"
                className={`s-provider-card${isActive ? " active" : ""}`}
                onClick={() => switchProvider(p.id)}
                aria-pressed={isActive}
                title={isActive ? `${p.displayName} is in use` : `Use ${p.displayName}`}
              >
                <span className="s-provider-name">{p.displayName}</span>
                {connectionPill(p)}
                <span className="s-provider-model">
                  {modelLabel(config?.modelByProvider[p.id] ?? p.defaultModel)}
                </span>
                {pendingId === p.id ? <BusyDot /> : null}
              </button>
            );
          })}
        </div>
      </SettingsCard>

      {active ? <AuthCard provider={active} onRefresh={onRefresh} /> : null}

      <SettingsCard
        title={`3 · Model${active ? ` — ${active.displayName}` : ""}`}
        description="The model new messages use with this provider."
      >
        <SettingsRow
          label="Model"
          hint={active?.thinkingCapability ? "Supports adjustable thinking effort (set it in the chat bar)." : undefined}
          help={
            <SettingHelp id="tooltip-model" label="Model">
              Bigger models are usually smarter but slower and pricier; “mini”, “flash” or “fast”
              variants are quicker and cheaper. Pick “Other…” to type a model id that is not
              listed (new releases, local models).
            </SettingHelp>
          }
        >
          <SelectInput
            value={showOtherField ? OTHER_MODEL : currentModel}
            ariaLabel="Model"
            disabled={!active || busy}
            onChange={(v) => {
              if (v === OTHER_MODEL) {
                setTypingOther(true);
                return;
              }
              setTypingOther(false);
              saveModel(v);
            }}
          >
            {presetModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={OTHER_MODEL}>Other… (type a model id)</option>
          </SelectInput>
          {busy ? <BusyDot /> : null}
        </SettingsRow>
        {showOtherField ? (
          <SettingsRow
            label="Model id"
            hint="Exactly as the provider names it. Saved when you press Enter or leave the field."
          >
            <TextInput
              value={isCustomModel ? currentModel : ""}
              placeholder="e.g. my-local-model"
              ariaLabel="Model id"
              disabled={!active}
              onCommit={saveModel}
            />
          </SettingsRow>
        ) : null}
      </SettingsCard>

      {active ? (
        <SettingsCard>
          <Collapsible
            summary="Advanced connection settings"
            hint="Only needed for local runtimes, proxies or self-hosted servers."
            defaultOpen={ENDPOINT_PROVIDERS.has(active.id) || Boolean(active.endpoint)}
          >
            <SettingsRow
              label="Server address"
              hint={
                active.baseUrl ? (
                  <span className="s-hint-block">
                    In use: <code>{active.baseUrl}</code>
                  </span>
                ) : (
                  "Leave empty to use the provider's default."
                )
              }
              help={
                <SettingHelp id="tooltip-base-url" label="Server address">
                  The base URL requests are sent to — e.g. http://127.0.0.1:11434/v1 for Ollama or
                  LM Studio. Only change it if you run your own server or a proxy.
                </SettingHelp>
              }
            >
              <TextInput
                value={endpointDraft ?? active.endpoint ?? ""}
                placeholder="http://127.0.0.1:11434/v1"
                ariaLabel="Server address"
                onCommit={(v) => {
                  setEndpointDraft(v);
                  saveEndpoint(v);
                }}
              />
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || !active.endpoint}
                onClick={clearEndpoint}
                title="Go back to the provider's default address"
              >
                Reset
              </button>
            </SettingsRow>
            {active.apiStyle ? (
              <SettingsRow
                label="API format"
                stacked
                help={
                  <SettingHelp id="tooltip-api-style" label="API format">
                    How requests are shaped. Almost every provider speaks Chat Completions; pick
                    Responses only if your server documents the OpenAI Responses API.
                  </SettingHelp>
                }
              >
                <ChoiceList
                  name="api-style"
                  ariaLabel="API format"
                  value={active.apiStyle}
                  disabled={busy}
                  onChange={saveApiStyle}
                  options={[
                    {
                      value: "chat",
                      label: "Chat Completions",
                      badge: "Most providers",
                      description: "POST /chat/completions — the standard OpenAI-compatible format.",
                    },
                    {
                      value: "responses",
                      label: "Responses API",
                      description: "POST /responses — newer OpenAI format, supported by fewer servers.",
                    },
                  ]}
                />
              </SettingsRow>
            ) : null}
          </Collapsible>
        </SettingsCard>
      ) : null}
    </>
  );
}
