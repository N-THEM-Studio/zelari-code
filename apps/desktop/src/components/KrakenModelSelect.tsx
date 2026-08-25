import { SettingHelp } from "./SettingHelp";

export type KrakenModelSelectProps = {
  label: string;
  tooltipId: string;
  tooltip: string;
  value: string;
  models: string[];
  inheritLabel: string;
  onChange: (value: string) => void;
};

/** Role model picker: empty value = Inherit (no Desktop override). */
export function KrakenModelSelect({
  label,
  tooltipId,
  tooltip,
  value,
  models,
  inheritLabel,
  onChange,
}: KrakenModelSelectProps) {
  const savedCustom = Boolean(value) && !models.includes(value);
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
        {models.map((modelId) => (
          <option key={modelId} value={modelId}>
            {modelId}
          </option>
        ))}
      </select>
    </label>
  );
}
