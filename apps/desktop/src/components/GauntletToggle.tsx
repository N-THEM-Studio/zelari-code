interface Props {
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

/** Toggle: next send appends the Gauntlet Loop instructions to the Goal. */
export function GauntletToggle({ value, disabled, onChange }: Props) {
  return (
    <div className="seg-toggle" role="group" aria-label="Gauntlet loop">
      <button
        type="button"
        className={`seg-btn${value ? " active" : ""}`}
        disabled={disabled}
        title="Append the Gauntlet Loop to the next message: builder + critic rounds until the bar is met"
        aria-pressed={value}
        onClick={() => onChange(!value)}
      >
        Gauntlet
      </button>
    </div>
  );
}
