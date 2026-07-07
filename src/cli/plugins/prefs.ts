/**
 * plugins/prefs — persistence of plugin-installation preferences.
 *
 * Stores the "don't ask me again about plugin X" dismissal so the boot gate
 * doesn't nag users who've already decided. Modeled on providerConfig.ts:
 *   - JSON file in ~/.tmp/zelari-code/ alongside provider.json / keys.json
 *   - existsSync + JSON.parse + validate, graceful fallback to defaults on
 *     corrupt/missing file (a broken prefs file must never block boot)
 *   - read-modify-write mutators, mode 0o600 (owner-only) on write
 *
 * Shape:
 *   { version: 1, dontAskAgain: { "<pluginId>": true } }
 *
 * `version` is reserved for forward migration — bumping it lets a future
 * release rewrite the schema without a silent data loss.
 *
 * Env override: ZELARI_PLUGINS_PREFS_FILE (tests + CI isolate the file).
 *
 * @see src/cli/providerConfig.ts — the canonical read-modify-write template
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Persisted plugin preferences (the on-disk shape). */
export interface PluginPrefs {
  /** Schema version. 1 for now; bump on breaking shape changes. */
  version: 1;
  /** pluginId → true means "user dismissed, don't prompt again at boot."
   * `/plugins` re-surfaces muted plugins via includeMuted. */
  dontAskAgain: Record<string, boolean>;
}

const DEFAULTS: PluginPrefs = {
  version: 1,
  dontAskAgain: {},
};

/** Path to the prefs file. Env-overridable for tests. */
export function getPluginPrefsPath(): string {
  return process.env.ZELARI_PLUGINS_PREFS_FILE
    ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'plugins.json');
}

/** Read prefs, falling back to defaults on missing/corrupt file. Never throws. */
export function getPluginPrefs(): PluginPrefs {
  const file = getPluginPrefsPath();
  try {
    if (!existsSync(file)) return { ...DEFAULTS, dontAskAgain: {} };
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PluginPrefs>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.dontAskAgain &&
      typeof parsed.dontAskAgain === 'object'
    ) {
      // Sanitize: keep only boolean-true entries with a non-empty id; drop junk.
      const clean: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed.dontAskAgain)) {
        if (typeof k === 'string' && k.length > 0 && v === true) clean[k] = true;
      }
      return { version: 1, dontAskAgain: clean };
    }
  } catch {
    // Corrupt JSON or unreadable — fall through to defaults.
  }
  return { ...DEFAULTS, dontAskAgain: {} };
}

function writePluginPrefs(prefs: PluginPrefs): void {
  const file = getPluginPrefsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(prefs, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * Mark a plugin as "don't ask again" (user picked 'Don't ask again' in the
 * boot prompt, or `ZELARI_NO_PLUGIN_PROMPT` style dismissal). Idempotent.
 */
export function markDontAskAgain(pluginId: string): void {
  try {
    const prefs = getPluginPrefs();
    prefs.dontAskAgain[pluginId] = true;
    writePluginPrefs(prefs);
  } catch {
    // A failed write (read-only home, full disk) must never block boot.
  }
}

/** Clear the "don't ask again" flag for a plugin (so /plugins can re-offer). */
export function clearDontAskAgain(pluginId: string): void {
  try {
    const prefs = getPluginPrefs();
    delete prefs.dontAskAgain[pluginId];
    writePluginPrefs(prefs);
  } catch {
    // Same fail-safe contract.
  }
}

/** Has the user muted this plugin at the boot prompt? */
export function isMuted(pluginId: string): boolean {
  return getPluginPrefs().dontAskAgain[pluginId] === true;
}
