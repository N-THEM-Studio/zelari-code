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
import { requestNotifyPermission } from "../../inboxNotify";
import { ACCENT_PRESETS, DEFAULT_ACCENT_COLOR } from "../../theme/accent";
import { BAFFETTI_PRESETS } from "../../theme/baffetti";
import { SelectInput, SettingsCard, SettingsRow, Toggle } from "./primitives";

export interface GeneralSectionProps {
  theme: "dark" | "light";
  onThemeChange: (theme: "dark" | "light") => void;
  defaultMode: DispatchMode;
  defaultPhase: WorkPhase;
  onDefaultsChange: (mode: DispatchMode, phase: WorkPhase) => void;
  profile: ExecutionProfile;
  onProfileChange: (profile: ExecutionProfile) => void;
  /** Baffetti (brand mark) master color — #rrggbb. */
  mustacheColor: string;
  onMustacheColorChange: (color: string) => void;
  /** UI accent override — #rrggbb. `undefined` = Auto (follow the mode). */
  accentColor?: string;
  /** Empty string clears back to Auto. */
  onAccentColorChange: (color: string) => void;
  /**
   * WS2 (inbox as notification bus): fire a native Desktop notification when
   * a run is waiting on you. Turning it ON also asks the webview for the
   * notification permission — the click is the user gesture the Web API
   * requires (see inboxNotify.ts).
   */
  inboxNotifications: boolean;
  onInboxNotificationsChange: (next: boolean) => void;
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
  mustacheColor,
  onMustacheColorChange,
  accentColor,
  onAccentColorChange,
  inboxNotifications,
  onInboxNotificationsChange,
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
        <SettingsRow
          label="Baffetti"
          hint="Tints the brand mark, borders and dividers — master color plus two intensity variants."
        >
          <div className="baffetti-swatches" role="group" aria-label="Baffetti color">
            {BAFFETTI_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`baffetti-swatch${mustacheColor === p.color ? " active" : ""}`}
                title={p.label}
                aria-label={p.label}
                aria-pressed={mustacheColor === p.color}
                style={{ background: p.color }}
                onClick={() => onMustacheColorChange(p.color)}
              />
            ))}
            <input
              type="color"
              className="baffetti-custom"
              aria-label="Custom baffetti color"
              title="Custom"
              value={mustacheColor}
              onChange={(e) => onMustacheColorChange(e.target.value)}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label="Accent color"
          hint="Colors buttons, focus and chat accents. Auto follows the mode."
        >
          <div
            className="baffetti-swatches"
            role="group"
            aria-label="Accent color"
          >
            <button
              type="button"
              className={`accent-auto${accentColor ? "" : " active"}`}
              aria-label="Auto — follow the mode"
              title="Auto — follow the mode"
              aria-pressed={!accentColor}
              onClick={() => onAccentColorChange("")}
            >
              Auto
            </button>
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`baffetti-swatch accent-swatch${
                  accentColor === p.color ? " active" : ""
                }`}
                title={p.label}
                aria-label={p.label}
                aria-pressed={accentColor === p.color}
                style={{ background: p.color }}
                onClick={() => onAccentColorChange(p.color)}
              />
            ))}
            <input
              type="color"
              className="baffetti-custom"
              aria-label="Custom accent color"
              title="Custom"
              value={accentColor ?? DEFAULT_ACCENT_COLOR}
              onChange={(e) => onAccentColorChange(e.target.value)}
            />
          </div>
        </SettingsRow>
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

      <SettingsCard
        title="Notifications"
        description="The /inbox signals, delivered by the OS — so a run that needs you can reach you while the window is in the background."
      >
        <SettingsRow
          label="Inbox notifications"
          hint="One native notification when a run waits on you: a permission/tool ask, an ask_user question, or a tentacle that finished or failed. Turning it on asks for the OS permission."
        >
          <Toggle
            checked={inboxNotifications}
            label="Inbox notifications"
            onChange={(next) => {
              onInboxNotificationsChange(next);
              // The click IS the user gesture the Web Notification API requires;
              // when it is already granted this resolves without a prompt.
              if (next) void requestNotifyPermission();
            }}
          />
        </SettingsRow>
      </SettingsCard>
    </>
  );
}
