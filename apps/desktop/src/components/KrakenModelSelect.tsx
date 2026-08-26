import { SettingHelp } from "./SettingHelp";

export type KrakenModelGroup = {
  /** Provider id — used as the option value prefix (`provider/model`). */
  id: string;
  /** Human label for the <optgroup>. */
  label: string;
  /** Model ids offered by this provider (unqualified). */
  models: string[];
};

export type KrakenModelSelectProps = {
  label: string;
  tooltipId: string;
  tooltip: string;
  value: string;
  /** Models of the active/lead provider (stored unqualified). */
  models: string[];
  /** Other configured providers — cross-provider picks (Desktop → CLI). */
  groups?: KrakenModelGroup[];
  /** Label for the active provider's <optgroup>. */
  activeProviderLabel?: string;
  inheritLabel: string;
  onChange: (value: string) => void;
};

/** Role model picker: empty value = Inherit (no Desktop override).
 *  Cross-provider picks are stored provider-qualified ("grok/grok-4") and
 *  split by the CLI (`parseQualifiedModelRef`) at tentacle/planner spawn. */
export function KrakenModelSelect({
  label,
  tooltipId,
  tooltip,
  value,
  models,
  groups = [],
  activeProviderLabel = "Active provider",
  inheritLabel,
  onChange,
}: KrakenModelSelectProps) {
  const groupedModels = groups.flatMap((g) => g.models.map((m) => `${g.id}/${m}`));
  const savedCustom = Boolean(value) && !models.includes(value) && !groupedModels.includes(value);
  return (
    <label className="field">
      <span className="field-label-row">
        <span>{label}</span>
        <SettingHelp id={tooltipId} label={label}>
          {tooltip}
        </SettingHelp>
      </span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{inheritLabel}</option>
        {savedCustom ? (
          <option value={value}>{value} — saved custom model</option>
        ) : null}
        <optgroup label={activeProviderLabel}>
          {models.map((modelId) => (
            <option key={modelId} value={modelId}>
              {modelId}
            </option>
          ))}
        </optgroup>
        {groups.map((g) => (
          <optgroup key={g.id} label={g.label}>
            {g.models.map((modelId) => (
              <option key={`${g.id}/${modelId}`} value={`${g.id}/${modelId}`}>
                {modelId}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
