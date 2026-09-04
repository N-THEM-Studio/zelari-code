/**
 * paths — single source of truth for every persistent path zelari-code owns.
 *
 * Everything lives under ONE home directory:
 *   ~/.zelari-code/          (override with the ZELARI_HOME env var)
 *
 * Precedence for every getter: specific env var > ZELARI_HOME > default
 * (e.g. ANATHEMA_METRICS_FILE beats ZELARI_HOME for the metrics file).
 *
 * Migration: older release lines scattered state under two legacy roots:
 *
 *   ┌────────────────────────┬────────────────────────────────────────────┐
 *   │ Legacy root            │ Contents                                   │
 *   ├────────────────────────┼────────────────────────────────────────────┤
 *   │ ~/.tmp/zelari-code/    │ keys.json, provider.json, plugins.json,    │
 *   │                        │ skill-cache.json, council-feedback.json,   │
 *   │                        │ metrics.jsonl, skill-history.jsonl,        │
 *   │                        │ audit.jsonl, sessions/, branches/,         │
 *   │                        │ models.json, oauth-pending.json, skills/,  │
 *   │                        │ current.txt, semantic/                     │
 *   │ ~/.tmp/anathema-coder/ │ same layout (pre-rename project name)      │
 *   └────────────────────────┴────────────────────────────────────────────┘
 *
 * `ensureZelariHome()` performs a NON-destructive one-shot migration the
 * first time any path is resolved (never at import time):
 *   1. each legacy root is backed up to `<root>.bak-<ISO timestamp>`;
 *   2. its entries are moved into the new home, but ONLY when the
 *      destination does not exist yet (the new home always wins);
 *   3. a `.migrated` marker is written so later calls are a strict no-op.
 * Nothing is ever deleted: entries whose destination already exists stay
 * under the legacy root.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Env var that overrides the whole home directory. */
export const ZELARI_HOME_ENV = 'ZELARI_HOME';

/** Marker file (inside the home) that makes the legacy migration one-shot. */
const MIGRATION_MARKER = '.migrated';

/**
 * Legacy roots to migrate, by directory name under `~/.tmp/`.
 * `anathema-coder` is the pre-rename project name; both may exist on a
 * machine that skipped releases. Exported so tests can derive the same
 * roots without duplicating the literals.
 */
export const LEGACY_ROOT_NAMES = ['zelari-code', 'anathema-coder'] as const;

/** One moved entry, as recorded in the `.migrated` marker. */
export interface MovedEntry {
  from: string;
  to: string;
}

/** Shape of the `.migrated` marker file (JSON). */
export interface MigrationMarker {
  /** Legacy roots considered by the migration run. */
  from: string[];
  /** ISO timestamp of the run. */
  at: string;
  /** Entries actually moved into the home. */
  moved: MovedEntry[];
}

/** Legacy roots under the user's home (resolved lazily — never at import). */
function legacyRoots(): string[] {
  return LEGACY_ROOT_NAMES.map((name) => path.join(homedir(), '.tmp', name));
}

/**
 * Resolve the zelari-code home directory.
 * `ZELARI_HOME` wins when set and non-empty; default is `~/.zelari-code`.
 * Pure: no filesystem side effects (see `ensureZelariHome` for those).
 */
export function zelariHome(): string {
  const override = process.env[ZELARI_HOME_ENV]?.trim();
  if (override) return override;
  return path.join(homedir(), '.zelari-code');
}

/**
 * Read a path-like env var. Returns undefined when unset or blank so that
 * `envPath(X) ?? default` never resolves to an empty path.
 */
function envPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Join `parts` under the home, ensuring the home exists first. */
function homePath(...parts: string[]): string {
  return path.join(ensureZelariHome(), ...parts);
}

// ---------------------------------------------------------------------------
// Typed getters — specific env var > ZELARI_HOME > default
// ---------------------------------------------------------------------------

/** provider.json — provider routing state. */
export function providerConfigPath(): string {
  return envPath('ANATHEMA_PROVIDER_CONFIG_FILE') ?? homePath('provider.json');
}

/** keys.json — provider API keys. */
export function keyStorePath(): string {
  return envPath('ANATHEMA_KEYSTORE_FILE') ?? homePath('keys.json');
}

/** plugins.json — plugin-installation preferences. */
export function pluginsPrefsPath(): string {
  return envPath('ZELARI_PLUGINS_PREFS_FILE') ?? homePath('plugins.json');
}

/** skill-cache.json — skill output cache. */
export function skillCachePath(): string {
  return envPath('ANATHEMA_SKILL_CACHE_FILE') ?? homePath('skill-cache.json');
}

/** council-feedback.json — council member ratings. */
export function councilFeedbackPath(): string {
  return envPath('ANATHEMA_COUNCIL_FEEDBACK_FILE') ?? homePath('council-feedback.json');
}

/** metrics.jsonl — runtime telemetry. */
export function metricsPath(): string {
  return envPath('ANATHEMA_METRICS_FILE') ?? homePath('metrics.jsonl');
}

/** audit.jsonl — tool-invocation audit log. */
export function auditLogPath(): string {
  return envPath('ANATHEMA_AUDIT_LOG') ?? homePath('audit.jsonl');
}

/** skill-history.jsonl — skill invocation history. */
export function skillHistoryPath(): string {
  return envPath('ANATHEMA_SKILL_HISTORY_FILE') ?? homePath('skill-history.jsonl');
}

/** sessions/ — session JSONL files. */
export function sessionsDir(): string {
  return envPath('ANATHEMA_SESSIONS_DIR') ?? homePath('sessions');
}

/** branches/ — session branch snapshots. */
export function branchesDir(): string {
  return envPath('ANATHEMA_BRANCHES_DIR') ?? homePath('branches');
}

/** current.txt — current session id marker. */
export function currentSessionPath(): string {
  return envPath('ANATHEMA_CURRENT_SESSION_FILE') ?? homePath('current.txt');
}

/** models.json — discovered model-id cache. */
export function modelsCachePath(): string {
  return envPath('ANATHEMA_MODELS_FILE') ?? homePath('models.json');
}

/** oauth-pending.json — in-flight PKCE verifications. */
export function oauthPendingPath(): string {
  return envPath('ANATHEMA_OAUTH_PENDING_FILE') ?? homePath('oauth-pending.json');
}

/** skills/ — user skills exported by the CLI. */
export function skillsDir(): string {
  return envPath('ANATHEMA_SKILL_DIR') ?? homePath('skills');
}

/** semantic/ — per-project semantic index cache (file name is hashed per root). */
export function semanticStateDir(): string {
  return homePath('semantic');
}

/** trust.json — trusted-folder store. */
export function trustConfigPath(): string {
  return homePath('trust.json');
}

// ---------------------------------------------------------------------------
// One-shot legacy migration (non-destructive, marker-guarded)
// ---------------------------------------------------------------------------

/**
 * Ensure the home exists and run the one-shot legacy migration.
 * Idempotent: once the `.migrated` marker exists this is a strict no-op.
 * Never throws — a broken/unwritable home must not take the CLI down.
 */
export function ensureZelariHome(): string {
  const home = zelariHome();
  try {
    if (existsSync(path.join(home, MIGRATION_MARKER))) return home;
    mkdirSync(home, { recursive: true });
    const moved = migrateLegacyRoots(home);
    const marker: MigrationMarker = {
      from: legacyRoots(),
      at: new Date().toISOString(),
      moved,
    };
    writeFileSync(
      path.join(home, MIGRATION_MARKER),
      JSON.stringify(marker, null, 2) + '\n',
      'utf-8',
    );
  } catch {
    // Fail-open: keep returning a usable path even if the disk says no.
  }
  return home;
}

/** Move legacy-root entries into `home`. Destinations that already exist win. */
function migrateLegacyRoots(home: string): MovedEntry[] {
  const moved: MovedEntry[] = [];
  for (const root of legacyRoots()) {
    if (path.resolve(root) === path.resolve(home)) continue; // never migrate into self
    if (!existsSync(root)) continue;
    backupLegacyRoot(root);
    for (const entry of readdirSync(root)) {
      const src = path.join(root, entry);
      const dest = path.join(home, entry);
      if (existsSync(dest)) continue; // new home wins; legacy copy stays put
      try {
        renameSync(src, dest);
        moved.push({ from: src, to: dest });
      } catch {
        // Locked/unmovable entry (AV, indexer): keep it in the legacy root.
      }
    }
  }
  return moved;
}

/** Copy a legacy root to `<root>.bak-<ISO timestamp>` before touching it. */
function backupLegacyRoot(root: string): void {
  // ':' is illegal in Windows file names — flatten the ISO timestamp.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${root}.bak-${stamp}`;
  if (existsSync(backup)) return;
  cpSync(root, backup, { recursive: true });
}
