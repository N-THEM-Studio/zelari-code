/**
 * Desktop Settings → tool-permission preset (2.32 desktop parity slice).
 *
 * Before this toggle the Desktop had no way to loosen or tighten the
 * fail-closed sidecar: bash/network were silently denied after 2.32 made
 * headless honest. The preset rides run.turn as `permissionPreset` and
 * the CLI allowlists it (serve/permissionBridge.ts) — no env injection.
 */
import type { DesktopPrefs } from "../desktopPrefs";
import { PERMISSION_PRESETS, type PermissionPreset } from "../desktopPrefs";

interface Props {
  prefs: DesktopPrefs;
  onPrefsChange: (partial: Partial<DesktopPrefs>) => void;
}

const PRESET_HELP: Record<PermissionPreset, string> = {
  standard:
    "Reads and writes allowed; commands and network ask (fail-closed until the ask bridge ships).",
  strict:
    "Everything that can ask, asks. Safest for untrusted repos; expect frequent blocks in headless runs.",
  yolo:
    "Everything allowed without asking. Only for scratch work you are ready to lose.",
};

export function PermissionsSection({ prefs, onPrefsChange }: Props) {
  return (
    <section className="settings-section">
      <h3>Tool permissions</h3>
      <p className="settings-hint">
        Applies to every agent run from this window (per-turn, sidecar-wide).
      </p>
      <div className="settings-row">
        {PERMISSION_PRESETS.map((preset) => (
          <label key={preset} className="settings-option">
            <input
              type="radio"
              name="permission-preset"
              value={preset}
              checked={prefs.permissionPreset === preset}
              onChange={() => onPrefsChange({ permissionPreset: preset })}
            />
            <span>
              <strong>{preset}</strong>
              <small>{PRESET_HELP[preset]}</small>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}
