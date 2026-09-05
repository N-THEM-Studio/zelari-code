/**
 * Desktop Settings → tool-permission preset (2.32 desktop parity slice).
 *
 * Before this toggle the Desktop had no way to loosen or tighten the
 * fail-closed sidecar: bash/network were silently denied after 2.32 made
 * headless honest. The preset rides run.turn as `permissionPreset` and
 * the CLI allowlists it (serve/permissionBridge.ts) — no env injection.
 *
 * Mounted inside the Agents section; uses the same settings primitives
 * (SettingsCard/SettingsRow/SelectInput) as every other section.
 */
import type { DesktopPrefs } from "../desktopPrefs";
import { PERMISSION_PRESETS, type PermissionPreset } from "../desktopPrefs";
import { SelectInput, SettingsCard, SettingsRow } from "./settings/primitives";

interface Props {
  prefs: DesktopPrefs;
  onPrefsChange: (partial: Partial<DesktopPrefs>) => void;
}

const PRESET_HELP: Record<PermissionPreset, string> = {
  standard:
    "Reads and writes allowed; commands and network ask (fail-closed until the ask bridge ships)",
  strict:
    "Everything that can ask, asks. Safest for untrusted repos; expect frequent blocks in headless runs",
  yolo:
    "Everything allowed without asking. Only for scratch work you are ready to lose",
};

export function PermissionsSection({ prefs, onPrefsChange }: Props) {
  return (
    <SettingsCard
      title="Tool permissions"
      description="Applies to every agent run from this window (per-turn, sidecar-wide). Unknown presets fall back to standard — the sidecar stays fail-closed."
    >
      <SettingsRow label="Preset">
        <SelectInput
          value={prefs.permissionPreset}
          ariaLabel="Permission preset"
          onChange={(v) =>
            onPrefsChange({ permissionPreset: v as PermissionPreset })
          }
        >
          {PERMISSION_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset} — {PRESET_HELP[preset]}
            </option>
          ))}
        </SelectInput>
      </SettingsRow>
    </SettingsCard>
  );
}
