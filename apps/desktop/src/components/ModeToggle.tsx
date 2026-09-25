import type { DispatchMode } from "../types";

/** Council is no longer offered in the Desktop: Kraken covers multi-role work
 *  through its tentacles (composer → Tentacles). Legacy council chats and
 *  defaults normalize to Kraken (`chatStorage.normalizeConv`, `loadDefaults`). */
const MODES: { id: DispatchMode; label: string; hint: string }[] = [
  { id: "kraken", label: "Kraken", hint: "Super-agent lead with tentacles" },
  { id: "zelari", label: "Zelari", hint: "Mission loop" },
];

interface Props {
  value: DispatchMode;
  disabled?: boolean;
  onChange: (mode: DispatchMode) => void;
}

export function ModeToggle({ value, disabled, onChange }: Props) {
  return (
    <div className="seg-toggle" role="group" aria-label="Dispatch mode">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`seg-btn${value === m.id ? " active" : ""}`}
          disabled={disabled}
          title={m.hint}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
