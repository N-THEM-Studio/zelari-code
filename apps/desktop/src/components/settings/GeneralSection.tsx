/**
 * General — theme (top!), new-chat defaults, execution profile.
 * Every control autosaves through granular callbacks.
 */
import { useEffect, useState } from "react";
import type { DispatchMode, WorkPhase } from "../../types";
import {
  EXECUTION_PROFILES,
  type ExecutionProfile,
} from "../../desktopPrefs";
import { SelectInput, SettingsCard, SettingsRow } from "./primitives";

export interface GeneralSectionProps {
  theme: "dark" | "light";
  onThemeChange: (theme: "dark" | "light") => void;
  defaultMode: DispatchMode;
  defaultPhase: WorkPhase;
  onDefaultsChange: (mode: DispatchMode, phase: WorkPhase) => void;
  profile: ExecutionProfile;
  onProfileChange: (profile: ExecutionProfile) => void;
}

const MODE_OPTIONS: { value: DispatchMode; label: string }[] = [
  { value: "kraken", label: "Kraken — super-agent with tentacles" },
  { value: "council", label: "Council — multi-role pipeline" },
  { value: "zelari", label: "Zelari — long-running missions" },
];

const PROFILE_HINTS: Record<ExecutionProfile, string> = {
  "minimal/v1": "Tools only — no sub-agents, no hooks.",
  "kraken/v1": "Kraken lead + explore/general/verify tentacles (default).",
  "council/v1": "Council roles and phases (Caronte, Nettuno, Lucifero…).",
  "mission/v1": "Zelari mission loop with plan → build → verify.",
};

export function GeneralSection({
  theme,
  onThemeChange,
  defaultMode,
  defaultPhase,
  onDefaultsChange,
  profile,
  onProfileChange,
}: GeneralSectionProps) {
  const [mode, setMode] = useState<DispatchMode>(defaultMode);
  const [phase, setPhase] = useState<WorkPhase>(defaultPhase);

  useEffect(() => setMode(defaultMode), [defaultMode]);
  useEffect(() => setPhase(defaultPhase), [defaultPhase]);

  return (
    <>
      <div className="settings-section-head">
        <h2>General</h2>
        <p>Appearance, what new chats start with, and the execution profile.</p>
      </div>

      <SettingsCard title="Appearance" description="Dark is the default liquid-glass look.">
        <div className="theme-toggle" role="group" aria-label="Color theme">
          <button
            type="button"
            className={theme === "dark" ? "active" : ""}
            onClick={() => onThemeChange("dark")}
          >
            Dark
          </button>
          <button
            type="button"
            className={theme === "light" ? "active" : ""}
            onClick={() => onThemeChange("light")}
          >
            Light
          </button>
        </div>
      </SettingsCard>

      <SettingsCard
        title="New chats"
        description="Mode and phase every fresh conversation starts with. Changing them here also updates the current chat."
      >
        <SettingsRow label="Default mode" hint="Cycle anytime with Ctrl+Shift+D.">
          <SelectInput
            value={mode}
            ariaLabel="Default mode"
            onChange={(v) => {
              const next = v as DispatchMode;
              setMode(next);
              onDefaultsChange(next, phase);
            }}
          >
            {MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectInput>
        </SettingsRow>
        <SettingsRow label="Default phase" hint="Plan reasons before touching files; Build implements.">
          <SelectInput
            value={phase}
            ariaLabel="Default phase"
            onChange={(v) => {
              const next = v as WorkPhase;
              setPhase(next);
              onDefaultsChange(mode, next);
            }}
          >
            <option value="plan">Plan — design first</option>
            <option value="build">Build — implement on disk</option>
          </SelectInput>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Execution profile"
        description="Which execution seams (workspace, shell, sub-agents) the CLI wires up for runs."
      >
        <SettingsRow label="Profile" hint={PROFILE_HINTS[profile]}>
          <SelectInput
            value={profile}
            ariaLabel="Execution profile"
            onChange={(v) => onProfileChange(v as ExecutionProfile)}
          >
            {EXECUTION_PROFILES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </SelectInput>
        </SettingsRow>
      </SettingsCard>
    </>
  );
}
