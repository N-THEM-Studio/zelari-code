/**
 * Tentacles panel — the composer pill that decides who Kraken hands work to.
 *
 * Moved out of Settings → Agents so the choice sits next to the prompt it
 * shapes. Nothing new is stored: the panel edits the SAME prefs Settings used
 * to (`krakenDelegation`, the four `kraken*Model` overrides and the three
 * `kraken*Thinking` overrides), App writes them through `patchDesktopPrefs`
 * (localStorage) and they ride run.turn on the next send. `""` is always
 * "inherit" — for models and for thinking — never a second sentinel.
 *
 * Unqualified model ids belong to the chat's provider; picks from another
 * provider are stored qualified (`grok/grok-4`) and split by the CLI
 * (`parseQualifiedModelRef`) when the tentacle or the planner spawns.
 */
import {
  normalizeThinkingEffort,
  TENTACLE_THINKING_OPTIONS,
  type DelegationPolicy,
  type DesktopPrefs,
} from "../desktopPrefs";
import type { DesktopConfig } from "../types";

export type TentaclePrefs = Pick<
  DesktopPrefs,
  | "krakenDelegation"
  | "krakenExploreModel"
  | "krakenGeneralModel"
  | "krakenVerifyModel"
  | "krakenPlannerModel"
  | "krakenExploreThinking"
  | "krakenGeneralThinking"
  | "krakenVerifyThinking"
>;

export interface TentaclesPanelProps {
  config: DesktopConfig | null;
  /** The chat's provider: its models are the unqualified options. */
  provider: string;
  value: TentaclePrefs;
  disabled?: boolean;
  onChange: (partial: Partial<TentaclePrefs>) => void;
}

const DELEGATION_CHOICES: readonly {
  id: DelegationPolicy;
  label: string;
  short: string;
  description: string;
}[] = [
  {
    id: "automatic",
    label: "Automatic",
    short: "Auto",
    description: "Kraken decides: small tasks it does itself, bigger ones it splits across tentacles.",
  },
  {
    id: "prefer",
    label: "Prefer",
    short: "Prefer",
    description: "Delegate most non-trivial research and edits — more parallel, more tokens.",
  },
  {
    id: "aggressive",
    label: "Maximum",
    short: "Max",
    description: "Kraken only coordinates; almost everything goes to tentacles.",
  },
  {
    id: "lead-only",
    label: "Lead only",
    short: "Lead only",
    description: "No tentacles unless you ask for them — simplest and cheapest.",
  },
];

type ModelKey = "krakenExploreModel" | "krakenGeneralModel" | "krakenVerifyModel" | "krakenPlannerModel";
type ThinkingKey = "krakenExploreThinking" | "krakenGeneralThinking" | "krakenVerifyThinking";

const ROLES: readonly { label: string; hint: string; model: ModelKey; thinking: ThinkingKey | null }[] = [
  {
    label: "Explorer",
    hint: "Reads and researches, never edits. A fast, cheap model is usually enough.",
    model: "krakenExploreModel",
    thinking: "krakenExploreThinking",
  },
  {
    label: "Builder",
    hint: "Writes the code. Prefer your strongest coding model.",
    model: "krakenGeneralModel",
    thinking: "krakenGeneralThinking",
  },
  {
    label: "Checker",
    hint: "Runs the checks before Kraken may call the task done.",
    model: "krakenVerifyModel",
    thinking: "krakenVerifyThinking",
  },
  {
    label: "Planner",
    hint: "Kraken Graph only: turns the goal into a plan of sub-tasks.",
    model: "krakenPlannerModel",
    thinking: null,
  },
];

/** Roles with at least one override (model or thinking). */
export function customizedRoles(value: TentaclePrefs): number {
  return ROLES.filter((r) => value[r.model] || (r.thinking && value[r.thinking])).length;
}

/** Pill text: the delegation policy, plus how many roles are customized. */
export function tentaclesSummary(value: TentaclePrefs): string {
  const choice = DELEGATION_CHOICES.find((c) => c.id === value.krakenDelegation);
  const custom = customizedRoles(value);
  return ["Tentacles", choice?.short ?? "Auto", custom > 0 ? `${custom} custom` : null]
    .filter(Boolean)
    .join(" · ");
}

const RESET_ROLES: Partial<TentaclePrefs> = {
  krakenExploreModel: "",
  krakenGeneralModel: "",
  krakenVerifyModel: "",
  krakenPlannerModel: "",
  krakenExploreThinking: "",
  krakenGeneralThinking: "",
  krakenVerifyThinking: "",
};

export function TentaclesPanel({ config, provider, value, disabled, onChange }: TentaclesPanelProps) {
  const providers = config?.providers ?? [];
  const lead = providers.find((p) => p.id === provider);
  const leadModels = lead?.models ?? [];
  const others = providers.filter((p) => p.id !== provider);
  const qualified = others.flatMap((p) => p.models.map((m) => `${p.id}/${m}`));
  const current = DELEGATION_CHOICES.find((c) => c.id === value.krakenDelegation) ?? DELEGATION_CHOICES[0];
  const leadOnly = value.krakenDelegation === "lead-only";

  const modelOptions = (saved: string) => (
    <>
      <option value="">Main model</option>
      {saved && !leadModels.includes(saved) && !qualified.includes(saved) ? (
        <option value={saved}>{saved} — saved custom model</option>
      ) : null}
      <optgroup label={lead?.displayName ?? (provider || "Chat provider")}>
        {leadModels.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </optgroup>
      {others.map((p) => (
        <optgroup key={p.id} label={p.hasKey ? p.displayName : `${p.displayName} (not connected)`}>
          {p.models.map((m) => (
            <option key={`${p.id}/${m}`} value={`${p.id}/${m}`}>
              {m}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );

  return (
    <div className="tentacles-panel">
      <div className="composer-popover-title">Delegation</div>
      <div className="seg-toggle tentacles-delegation" role="group" aria-label="Delegation">
        {DELEGATION_CHOICES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`seg-btn${c.id === current.id ? " active" : ""}`}
            aria-pressed={c.id === current.id}
            disabled={disabled}
            title={c.description}
            onClick={() => onChange({ krakenDelegation: c.id })}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="composer-popover-help">{current.description}</p>

      <div className={`tentacles-roles${leadOnly ? " is-muted" : ""}`}>
        <span className="composer-popover-title">Tentacle</span>
        <span className="composer-popover-title">Model</span>
        <span className="composer-popover-title">Thinking</span>
        {ROLES.map(({ label, hint, model, thinking }) => (
          <div key={model} className="tentacles-role" role="group" aria-label={label}>
            <span className="composer-popover-label" title={hint}>
              {label}
            </span>
            <select
              className="composer-popover-select"
              value={value[model]}
              disabled={disabled}
              aria-label={`${label} model`}
              title={hint}
              onChange={(e) => onChange({ [model]: e.target.value } as Partial<TentaclePrefs>)}
            >
              {modelOptions(value[model])}
            </select>
            {thinking ? (
              <select
                className="composer-popover-select"
                value={value[thinking] || "inherit"}
                disabled={disabled}
                aria-label={`${label} thinking effort`}
                onChange={(e) =>
                  // `inherit` comes back as "" — the one "no override" value.
                  onChange({ [thinking]: normalizeThinkingEffort(e.target.value) } as Partial<TentaclePrefs>)
                }
              >
                {TENTACLE_THINKING_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <span className="composer-popover-label tentacles-na" title="The planner has no thinking override">
                —
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="composer-popover-row">
        <p className="composer-popover-help">
          Tentacle picks never change the chat model. Applied from the next run.
        </p>
        {customizedRoles(value) > 0 ? (
          <button
            type="button"
            className="btn-ghost tentacles-reset"
            disabled={disabled}
            onClick={() => onChange(RESET_ROLES)}
          >
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}
