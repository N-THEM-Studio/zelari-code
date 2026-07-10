import type { DesktopConfig } from "../types";

interface Props {
  config: DesktopConfig | null;
  provider: string;
  model: string;
  disabled?: boolean;
  onProviderChange: (id: string) => void;
  onModelChange: (id: string) => void;
}

export function ProviderModelBar({
  config,
  provider,
  model,
  disabled,
  onProviderChange,
  onModelChange,
}: Props) {
  const providers = config?.providers ?? [];
  const active = providers.find((p) => p.id === provider);
  const models = active?.models?.length
    ? active.models
    : model
      ? [model]
      : [];

  return (
    <div className="provider-bar">
      <label className="field-inline">
        <span>Provider</span>
        <select
          value={provider}
          disabled={disabled || !providers.length}
          onChange={(e) => onProviderChange(e.target.value)}
        >
          {!providers.length && <option value={provider}>{provider || "—"}</option>}
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
          disabled={disabled}
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
    </div>
  );
}
