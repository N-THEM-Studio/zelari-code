import { useEffect, useRef, useState } from "react";
import { discoverModels, getAppConfig } from "../agentClient";
import type { DesktopConfig } from "../types";

interface Props {
  config: DesktopConfig | null;
  provider: string;
  model: string;
  disabled?: boolean;
  onProviderChange: (id: string) => void;
  onModelChange: (id: string) => void;
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

  return (
    <div className="provider-bar">
      <label className="field-inline">
        <span>Provider</span>
        <select
          value={provider}
          disabled={disabled || !providers.length}
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
      </label>
      <label className="field-inline">
        <span>Model</span>
        <select
          value={models.includes(model) ? model : model || ""}
          disabled={disabled || discovering}
          onFocus={() => void refreshModels(false)}
          onChange={(e) => onModelChange(e.target.value)}
        >
          {!models.includes(model) && model && (
            <option value={model}>{model}</option>
          )}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          {!models.length && (
            <option value="">
              {discovering ? "Loading…" : "—"}
            </option>
          )}
        </select>
      </label>
      <button
        type="button"
        className="btn-ghost btn-discover"
        disabled={disabled || discovering || !provider}
        title="Refresh model list from provider API"
        onClick={() => void refreshModels(true)}
      >
        {discovering ? "…" : "↻"}
      </button>
    </div>
  );
}
