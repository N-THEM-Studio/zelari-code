import { useEffect, useRef, useState } from "react";
import { discoverModels, getAppConfig } from "../agentClient";
import { thinkingSelectOptions } from "../thinkingCapability";
import type { DesktopConfig } from "../types";

interface Props {
  config: DesktopConfig | null;
  provider: string;
  model: string;
  disabled?: boolean;
  onProviderChange: (id: string) => void;
  onModelChange: (id: string) => void;
  onThinkingChange: (spec: string) => void;
  onConfigRefresh?: (cfg: DesktopConfig) => void;
  onStatus?: (msg: string) => void;
}

/** Per-provider cooldown so switching DeepSeek after MiniMax still discovers. */
const DISCOVER_COOLDOWN_MS = 20_000;

function mergeModelsIntoConfig(
  cfg: DesktopConfig,
  providerId: string,
  models: string[],
): DesktopConfig {
  return {
    ...cfg,
    providers: cfg.providers.map((p) => {
      if (p.id !== providerId) return p;
      const merged = [...models];
      // Keep current default first if missing from API list
      if (p.defaultModel && !merged.includes(p.defaultModel)) {
        merged.unshift(p.defaultModel);
      }
      return { ...p, models: merged };
    }),
  };
}

export function ProviderModelBar({
  config,
  provider,
  model,
  disabled,
  onProviderChange,
  onModelChange,
  onThinkingChange,
  onConfigRefresh,
  onStatus,
}: Props) {
  const providers = config?.providers ?? [];
  const active = providers.find((p) => p.id === provider);
  const models = active?.models?.length
    ? active.models
    : model
      ? [model]
      : [];

  const thinkingValue = active?.thinking ?? "auto";
  const thinkingOptions = thinkingSelectOptions(provider, model);

  const [discovering, setDiscovering] = useState(false);
  const lastDiscoverByProvider = useRef<Record<string, number>>({});
  const inFlightRef = useRef<string | null>(null);

  const refreshModels = async (force = false) => {
    if (!provider || disabled) return;
    if (inFlightRef.current === provider) return;

    const now = Date.now();
    const last = lastDiscoverByProvider.current[provider] ?? 0;
    if (!force && now - last < DISCOVER_COOLDOWN_MS) {
      return;
    }

    // Skip auto-refresh if we already have a rich list unless forced
    if (!force && (active?.models?.length ?? 0) >= 2 && now - last < 60_000) {
      return;
    }

    inFlightRef.current = provider;
    setDiscovering(true);
    onStatus?.(`Refreshing models for ${provider}…`);
    try {
      const result = await discoverModels({ provider });
      lastDiscoverByProvider.current[provider] = Date.now();

      const list = (result.models ?? []).filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      );
      const n = list.length;
      onStatus?.(
        n
          ? `${provider}: ${n} model${n === 1 ? "" : "s"}`
          : `${provider}: no models returned`,
      );

      // Apply list immediately so UI updates even if --print-config fails
      // (Windows UV abort after discovery is common).
      if (n > 0 && config) {
        onConfigRefresh?.(mergeModelsIntoConfig(config, provider, list));
        if (!list.includes(model)) {
          onModelChange(list[0]);
        }
      } else if (n > 0 && !config) {
        // No base config yet — still try print-config below
        if (!list.includes(model) && list[0]) onModelChange(list[0]);
      }

      try {
        const cfg = await getAppConfig();
        onConfigRefresh?.(
          n > 0 ? mergeModelsIntoConfig(cfg, provider, list) : cfg,
        );
      } catch {
        // print-config optional; list already applied above
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Soften UV noise if it leaked through
      if (/UV_HANDLE_CLOSING|Assertion failed/i.test(msg)) {
        onStatus?.(`${provider}: discovery may have succeeded — retry ↻`);
        try {
          const cfg = await getAppConfig();
          onConfigRefresh?.(cfg);
          const found = cfg.providers.find((p) => p.id === provider);
          if (found?.models?.length) {
            onStatus?.(
              `${provider}: ${found.models.length} models (from cache)`,
            );
          }
        } catch {
          onStatus?.(msg.slice(0, 120));
        }
      } else {
        onStatus?.(`${provider}: ${msg.slice(0, 140)}`);
      }
    } finally {
      inFlightRef.current = null;
      setDiscovering(false);
    }
  };

  // When provider changes, discover if list is empty/sparse
  useEffect(() => {
    if (!provider || disabled) return;
    const p = config?.providers.find((x) => x.id === provider);
    if (!p?.hasKey) return;
    if ((p.models?.length ?? 0) < 2) {
      void refreshModels(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on provider switch
  }, [provider]);

  // Grok-style list: the current model stays visible even when it is not in
  // the discovered list yet (same rule the old select used for its extra option).
  const displayModels =
    model && !models.includes(model) ? [model, ...models] : models;

  return (
    <div className="provider-bar pmb">
      <div className="pmb-provider-row">
        <span className="pmb-label">Provider</span>
        <span className="pmb-provider-wrap">
          <select
            className="pmb-provider-select"
            value={provider}
            disabled={disabled || !providers.length}
            aria-label="Provider"
            title="Provider"
            onChange={(e) => onProviderChange(e.target.value)}
          >
            {!providers.length && (
              <option value={provider}>{provider || "—"}</option>
            )}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
                {!p.hasKey ? " (no key)" : ""}
              </option>
            ))}
          </select>
        </span>
      </div>

      <div className="pmb-label">Model</div>
      <div
        className="pmb-model-list"
        role="listbox"
        aria-label="Model"
        aria-disabled={disabled || discovering || undefined}
        onFocus={() => void refreshModels(false)}
      >
        {displayModels.map((m) => (
          <button
            key={m}
            type="button"
            role="option"
            aria-selected={m === model}
            aria-label={m}
            className="pmb-model-option"
            disabled={disabled || discovering || undefined}
            onClick={() => onModelChange(m)}
          >
            <span className="pmb-model-name">{m}</span>
            {m === model && (
              <span className="pmb-model-check" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        ))}
        {!displayModels.length && (
          <div className="pmb-model-empty">
            {discovering ? "Loading…" : "No models — refresh below"}
          </div>
        )}
      </div>

      <div className="pmb-label">Thinking effort</div>
      <div className="pmb-seg" role="radiogroup" aria-label="Thinking effort">
        {thinkingOptions.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            data-value={o.value}
            aria-checked={o.value === thinkingValue}
            className="pmb-seg-btn"
            disabled={disabled || undefined}
            title={o.label}
            onClick={() => onThinkingChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="pmb-refresh-row"
        disabled={disabled || discovering || !provider || undefined}
        title="Refresh model list from provider API"
        aria-label="Refresh models"
        onClick={() => void refreshModels(true)}
      >
        <span aria-hidden="true">{discovering ? "…" : "↻"}</span>
        Refresh models
      </button>
    </div>
  );
}
