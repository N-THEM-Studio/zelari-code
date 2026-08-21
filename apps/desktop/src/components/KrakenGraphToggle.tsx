interface Props {
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

/** Single-button toggle for Kraken Graph mode — plans + runs the prompt as
 * a parallel task DAG instead of a normal single-agent/council/zelari turn. */
export function KrakenGraphToggle({ value, disabled, onChange }: Props) {
  return (
    <div className="seg-toggle" role="group" aria-label="Kraken graph mode">
      <button
        type="button"
        className={`seg-btn${value ? " active" : ""}`}
        disabled={disabled}
        title="Plan + execute as a Kraken task graph. Mutually exclusive with Gauntlet."
        onClick={() => onChange(!value)}
      >
        Graph
      </button>
    </div>
  );
}
