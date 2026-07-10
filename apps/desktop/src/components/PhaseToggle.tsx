import type { WorkPhase } from "../types";

const PHASES: { id: WorkPhase; label: string; hint: string }[] = [
  { id: "plan", label: "Plan", hint: "Explore & design (no project writes)" },
  { id: "build", label: "Build", hint: "Implement with full tools" },
];

interface Props {
  value: WorkPhase;
  disabled?: boolean;
  onChange: (phase: WorkPhase) => void;
}

export function PhaseToggle({ value, disabled, onChange }: Props) {
  return (
    <div className="seg-toggle" role="group" aria-label="Work phase">
      {PHASES.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`seg-btn phase-${p.id}${value === p.id ? " active" : ""}`}
          disabled={disabled}
          title={p.hint}
          onClick={() => onChange(p.id)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
