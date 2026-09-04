/**
 * userSettings — layered `zelari.config.json` with per-value origin tracking.
 *
 * Layers (lowest → highest precedence):
 *   1. default            documented engine defaults (see DOCUMENTED_DEFAULTS)
 *   2. user file          <zelariHome>/zelari.config.json
 *   3. project file       <cwd>/.zelari/zelari.config.json
 *   4. env                existing ZELARI_* vars stay the override layer
 *
 * Design rules (ADR-0036 adjacent, suggestion B12):
 *   - fail-open: an invalid/unreadable file layer is IGNORED with a warning —
 *     settings are UX knobs, not a security gate (P2 gates live elsewhere);
 *   - no mass env migration: env vars keep winning, the file only feeds the
 *     same knobs when the env var is unset;
 *   - unknown JSON keys are stripped by the Zod schema (tolerant loader).
 *
 * Only env var names VERIFIED in this codebase are mapped (no invented knobs).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { zelariHome } from './paths.js';

/** File name used for both the user and the project layer. */
export const SETTINGS_FILE_NAME = 'zelari.config.json';

const HookFailure = z.enum(['fail-open', 'fail-closed']);
const Permission = z.enum(['ask', 'allow', 'deny']);
const EvolutionMode = z.enum(['0', 'shadow']);

/** Schema for one zelari.config.json layer. Every leaf is optional. */
export const UserSettingsSchema = z.object({
  hooksFailure: HookFailure.optional(),
  strictDone: z.boolean().optional(),
  missionStrict: z.boolean().optional(),
  memory: z.boolean().optional(),
  toolBudgetHard: z.number().int().positive().optional(),
  toolBudgetAgent: z.number().int().positive().optional(),
  permissionExecute: Permission.optional(),
  permissionNetwork: Permission.optional(),
  evolution: EvolutionMode.optional(),
});
export type UserSettingsFile = z.infer<typeof UserSettingsSchema>;
export type SettingsLeafKey = keyof UserSettingsFile;

export const SETTINGS_LEAF_KEYS: readonly SettingsLeafKey[] = [
  'hooksFailure',
  'strictDone',
  'missionStrict',
  'memory',
  'toolBudgetHard',
  'toolBudgetAgent',
  'permissionExecute',
  'permissionNetwork',
  'evolution',
];

/**
 * Documented engine defaults, shown by `--print-settings` when no layer sets
 * the knob. `memory` and `toolBudgetAgent` are intentionally absent: their
 * engine defaults are computed elsewhere and are reported as "(engine default)".
 */
const DOCUMENTED_DEFAULTS: Partial<Record<SettingsLeafKey, unknown>> = {
  hooksFailure: 'fail-open', // permissive TUI; strict surfaces stay fail-closed (policyLoadMode)
  strictDone: true, // ADR-0025: strict done defaults ON
  missionStrict: true, // ADR-0025: mission strict ON
  toolBudgetHard: 180, // --fix-budget recommended value
  permissionExecute: 'ask',
  permissionNetwork: 'ask',
  evolution: '0', // ADR-0036: Evolution Engine v0 default off
};

/** Env vars verified in this repo that override each leaf. */
const ENV_BY_LEAF: Record<SettingsLeafKey, readonly string[]> = {
  hooksFailure: ['ZELARI_HOOKS_FAILURE'],
  strictDone: ['ZELARI_STRICT_DONE'],
  missionStrict: ['ZELARI_MISSION_STRICT'],
  memory: ['ZELARI_MEMORY'],
  toolBudgetHard: ['ZELARI_MAX_TOOL_LOOP_HARD'],
  toolBudgetAgent: ['ZELARI_MODE_MAX_TOOLS_AGENT'],
  permissionExecute: ['ZELARI_PERMISSION_EXECUTE'],
  permissionNetwork: ['ZELARI_PERMISSION_NETWORK'],
  evolution: ['ZELARI_EVOLUTION'],
};

export type SettingsOrigin = 'default' | 'user' | 'project' | 'env';

export interface SettingsEntry {
  key: SettingsLeafKey;
  /** Resolved value; undefined = no layer sets it (engine default applies). */
  value?: unknown;
  origin: SettingsOrigin;
  /** Env var name (env) or absolute file path (user/project) that set it. */
  source?: string;
}

export interface ResolvedUserSettings {
  entries: Record<SettingsLeafKey, SettingsEntry>;
  warnings: string[];
  userPath: string;
  projectPath: string;
}

type EnvLike = Record<string, string | undefined>;

function parseBool(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

function parseIntStrict(raw: string): number | undefined {
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
}

function parseEnum<T extends readonly [string, ...string[]]>(values: T, raw: string): T[number] | undefined {
  const v = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return (values as readonly string[]).includes(v) ? (v as T[number]) : undefined;
}

/** Read + validate one file layer. Invalid layers are skipped with a warning. */
function loadFileLayer(
  file: string,
  origin: 'user' | 'project',
  warnings: string[],
): Partial<UserSettingsFile> {
  if (!existsSync(file)) return {};
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    warnings.push(`${origin}: unreadable (${err instanceof Error ? err.message : String(err)}) — layer ignored`);
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    warnings.push(`${origin}: invalid JSON in ${file} — layer ignored`);
    return {};
  }
  const parsed = UserSettingsSchema.safeParse(json);
  if (!parsed.success) {
    warnings.push(`${origin}: schema validation failed in ${file} — layer ignored`);
    return {};
  }
  return parsed.data;
}

function envValueFor(key: SettingsLeafKey, env: EnvLike): { value: unknown; varName: string } | undefined {
  for (const varName of ENV_BY_LEAF[key]) {
    const raw = env[varName];
    if (raw === undefined || raw === '') continue;
    let value: unknown;
    switch (key) {
      case 'hooksFailure':
        value = parseEnum(['fail-open', 'fail-closed'] as const, raw);
        break;
      case 'permissionExecute':
      case 'permissionNetwork':
        value = parseEnum(['ask', 'allow', 'deny'] as const, raw);
        break;
      case 'evolution':
        value = parseEnum(['0', 'shadow'] as const, raw);
        break;
      case 'toolBudgetHard':
      case 'toolBudgetAgent':
        value = parseIntStrict(raw);
        break;
      default:
        value = parseBool(raw);
    }
    if (value !== undefined) return { value, varName };
    // present but invalid: keep scanning other vars, then fall through to files
  }
  return undefined;
}

/**
 * Resolve every settings leaf across the four layers. Never throws: unreadable
 * layers degrade to warnings (fail-open).
 */
export function resolveUserSettings(opts: { cwd?: string; env?: EnvLike } = {}): ResolvedUserSettings {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const userPath = path.join(zelariHome(), SETTINGS_FILE_NAME);
  const projectPath = path.join(cwd, '.zelari', SETTINGS_FILE_NAME);
  const warnings: string[] = [];

  const userLayer = loadFileLayer(userPath, 'user', warnings);
  const projectLayer = loadFileLayer(projectPath, 'project', warnings);

  const entries = {} as Record<SettingsLeafKey, SettingsEntry>;
  for (const key of SETTINGS_LEAF_KEYS) {
    const fromEnv = envValueFor(key, env);
    if (fromEnv) {
      entries[key] = { key, value: fromEnv.value, origin: 'env', source: fromEnv.varName };
      continue;
    }
    if (projectLayer[key] !== undefined) {
      entries[key] = { key, value: projectLayer[key], origin: 'project', source: projectPath };
      continue;
    }
    if (userLayer[key] !== undefined) {
      entries[key] = { key, value: userLayer[key], origin: 'user', source: userPath };
      continue;
    }
    entries[key] = { key, value: DOCUMENTED_DEFAULTS[key], origin: 'default' };
  }
  return { entries, warnings, userPath, projectPath };
}

/**
 * Only the values a consumer should APPLY (env/file overrides). Defaults are
 * documentation: each engine keeps owning its fallback so this module never
 * becomes a second source of truth for behaviour.
 */
export function settingsOverrides(r: ResolvedUserSettings): Partial<Record<SettingsLeafKey, unknown>> {
  const out: Partial<Record<SettingsLeafKey, unknown>> = {};
  for (const key of SETTINGS_LEAF_KEYS) {
    const e = r.entries[key];
    if (e.origin !== 'default' && e.value !== undefined) {
      (out as Record<string, unknown>)[key] = e.value;
    }
  }
  return out;
}

function fmtValue(v: unknown): string {
  if (v === undefined) return '(engine default)';
  return String(v);
}

function fmtSource(e: SettingsEntry): string {
  if (e.origin === 'env') return `env:${e.source}`;
  if (e.source) {
    const short = e.source.length > 48 ? `…${e.source.slice(-47)}` : e.source;
    return `${e.origin}:${short}`;
  }
  return e.origin;
}

/** Human-readable report for `--print-settings` (no console use inside). */
export function printSettingsReport(opts: { cwd?: string; env?: EnvLike } = {}): string {
  const r = resolveUserSettings(opts);
  const lines: string[] = [];
  lines.push('zelari-code settings — zelari.config.json (origin of every value)');
  lines.push('');
  lines.push('  key                  value              origin');
  lines.push('  ──────────────────── ────────────────── ─────────────────────────────');
  for (const key of SETTINGS_LEAF_KEYS) {
    const e = r.entries[key];
    lines.push(`  ${key.padEnd(20)} ${fmtValue(e.value).padEnd(18)} ${fmtSource(e)}`);
  }
  lines.push('');
  lines.push('layers:');
  lines.push(`  user:    ${r.userPath} (${existsSync(r.userPath) ? 'loaded' : 'not found'})`);
  lines.push(`  project: ${r.projectPath} (${existsSync(r.projectPath) ? 'loaded' : 'not found'})`);
  if (r.warnings.length > 0) {
    lines.push('');
    lines.push('warnings:');
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  lines.push('');
  lines.push('precedence: default < user < project < env');
  return lines.join('\n');
}
