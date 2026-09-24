/**
 * Desktop Settings → tool-permission preset (2.32 desktop parity slice).
 *
 * The preset rides run.turn as `permissionPreset` and the CLI allowlists it
 * (serve/permissionBridge.ts) — no env injection; it applies to that turn
 * only. Rendered as described choices so a new user can tell what each level
 * actually allows without decoding a terse select value.
 *
 * Mounted inside the Agents section; uses the same settings primitives as
 * every other section.
 */
import type { DesktopPrefs, PermissionPreset } from "../desktopPrefs";
import { SettingHelp } from "./SettingHelp";
import { ChoiceList, SettingsCard, type ChoiceOption } from "./settings/primitives";

interface Props {
  prefs: DesktopPrefs;
  onPrefsChange: (partial: Partial<DesktopPrefs>) => void;
}

const PRESET_OPTIONS: readonly ChoiceOption<PermissionPreset>[] = [
  {
    value: "standard",
    label: "Standard",
    badge: "Recommended",
    description: "Reads and edits files freely; asks in chat before running commands or using the network.",
  },
  {
    value: "strict",
    label: "Ask for everything",
    description: "Asks before any action that can ask. Safest for unfamiliar repos; expect frequent prompts.",
  },
  {
    value: "yolo",
    label: "Full auto",
    description: "Allows every category without asking. Project policy and explicit deny rules still apply.",
  },
];

export function PermissionsSection({ prefs, onPrefsChange }: Props) {
  return (
    <SettingsCard
      title="Tool permissions"
      description="What Kraken may do without asking you first. Applies to runs started from this window."
      help={
        <SettingHelp id="tooltip-permissions" label="Tool permissions">
          When an action needs approval, a card appears in the chat with Allow once / Always this
          session / Deny. Rules in the project's .zelari/policy.json always win over this preset.
        </SettingHelp>
      }
    >
      <ChoiceList
        name="permission-preset"
        ariaLabel="Permission preset"
        value={prefs.permissionPreset}
        options={PRESET_OPTIONS}
        onChange={(v) => onPrefsChange({ permissionPreset: v })}
      />
    </SettingsCard>
  );
}
