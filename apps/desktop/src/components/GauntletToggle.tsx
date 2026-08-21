interface Props {
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

/** Toggle: next send runs the host-driven builder/critic loop. */
export function GauntletToggle({ value, disabled, onChange }: Props) {
  return (
    <div className="seg-toggle" role="group" aria-label="Gauntlet loop">
      <button
        type="button"
        className={`seg-btn${value ? " active" : ""}`}
        disabled={disabled}
        title="Capped builder/critic loop. Mutually exclusive with Graph. Parent cannot write."
        aria-pressed={value}
        onClick={() => onChange(!value)}
      >
        Gauntlet
      </button>
    </div>
  );
}
