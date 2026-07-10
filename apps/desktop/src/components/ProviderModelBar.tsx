import { useRef, useState } from "react";
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

const DISCOVER_COOLDOWN_MS = 30_000;

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
  const lastDiscoverRef = useRef(0);

  const refreshModels = async (force = false) => {
    if (!provider || disabled) return;
    const now = Date.now();
    if (!force && now - lastDiscoverRef.current < DISCOVER_COOLDOWN_MS) {
      return;
    }
    setDiscovering(true);
    onStatus?.("Refreshing models…");
    try {
      const result = await discoverModels({ provider });
      lastDiscoverRef.current = Date.now();
      const n = result.models?.length ?? 0;
      onStatus?.(n ? `Discovered ${n} models` : "Model list updated");
      if (result.models?.length && !result.models.includes(model) && result.models[0]) {
        onModelChange(result.models[0]);
      }
      const cfg = await getAppConfig();
      onConfigRefresh?.(cfg);
    } catch (e) {
      onStatus?.(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  };

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
          onMouseDown={() => void refreshModels(false)}
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
          {!models.length && <option value="">—</option>}
        </select>
      </label>
      <button
        type="button"
        className="btn-ghost btn-discover"
        disabled={disabled || discovering || !provider}
        title="Refresh model list from provider"
        onClick={() => void refreshModels(true)}
      >
        {discovering ? "…" : "↻"}
      </button>
    </div>
  );
}
