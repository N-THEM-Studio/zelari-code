/**
 * statuslineConfig — persisted configuration for the configurable status line
 * (t114).
 *
 * WHERE: `<zelariHome>/statusline.json` (`ZELARI_STATUSLINE_CONFIG_FILE`
 * overrides it for tests / CI isolation) — the same home-scoped JSON
 * convention as plugins/prefs.ts and providerConfig.ts, with the same
 * read-modify-write + fail-soft contract:
 *   - a missing/corrupt/unreadable file degrades to DEFAULTS with a warning,
 *     never a throw (a broken UX knob must not break boot — P2);
 *   - unknown item ids are dropped by normalization (an old file can never
 *     resurrect a chip that no longer exists, nor inject a new one);
 *   - `custom` is present in `items` ONLY while a custom command is
 *     configured, so enabling/disabling the script is a single field.
 *
 * SHAPE (version 1):
 *   { "version": 1,
 *     "items": ["model", "jail", "custom", …],
 *     "custom": { "command": "node ~/status.js", "timeoutMs": 1500 } | null }
 *
 * DEFAULTS: `items` = the StatusBar's current chip order (DEFAULT_STATUSLINE_ITEMS)
 * and `custom` = null — zero visible change until a user opts in.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ZELARI_HOME_ENV, zelariHome } from '../paths.js';
import {
  DEFAULT_STATUSLINE_ITEMS,
  STATUSLINE_CUSTOM_ID,
  isStatusLineItemId,
} from './statuslineItems.js';

/** Default timeout for the custom item script. */
export const DEFAULT_STATUSLINE_TIMEOUT_MS = 1500;

/** Hard ceiling for a user-supplied timeout (a status line never blocks). */
export const MAX_STATUSLINE_TIMEOUT_MS = 30_000;

/** A custom item's text is capped at this many characters. */
export const STATUSLINE_MAX_TEXT_CHARS = 120;

export interface StatusLineCustomConfig {
  command: string;
  timeoutMs: number;
}

export interface StatusLineConfig {
  items: string[];
  custom: StatusLineCustomConfig | null;
}

const CustomSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(MAX_STATUSLINE_TIMEOUT_MS).optional(),
});

const ConfigSchema = z.object({
  version: z.literal(1).optional(),
  items: z.array(z.string()).optional(),
  custom: CustomSchema.nullable().optional(),
});

/** The zero-opt-in default: today's chip order, no custom script. */
export function defaultStatusLineConfig(): StatusLineConfig {
  return { items: [...DEFAULT_STATUSLINE_ITEMS], custom: null };
}

/** Path of the persisted config (env-overridable, like the other prefs files). */
export function statusLineConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ZELARI_STATUSLINE_CONFIG_FILE?.trim();
  if (override) return override;
  // An INJECTED env must isolate the home too, not just the file: otherwise a
  // caller passing `{ env: { ZELARI_HOME: tmp } }` (tests, CI, headless with a
  // synthetic home) would silently read/write the REAL `~/.zelari-code`.
  const home = env[ZELARI_HOME_ENV]?.trim();
  return path.join(home || zelariHome(), 'statusline.json');
}

/**
 * Coerce arbitrary JSON into a valid config. Drops unknown/duplicate ids,
 * re-adds `custom` exactly when a command exists, and preserves the caller's
 * order otherwise.
 *
 * An ABSENT `items` key means "not configured yet" ⇒ the default order; an
 * EXPLICIT empty array means the user disabled every item and MUST survive
 * normalization (otherwise turning off the last chip would silently re-enable
 * the whole bar — the opposite of what `/statusline off` just reported).
 */
export function normalizeStatusLineConfig(raw: unknown): StatusLineConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) return defaultStatusLineConfig();
  const command = parsed.data.custom?.command?.trim();
  const custom: StatusLineCustomConfig | null = command
    ? { command, timeoutMs: parsed.data.custom?.timeoutMs ?? DEFAULT_STATUSLINE_TIMEOUT_MS }
    : null;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const id of parsed.data.items ?? DEFAULT_STATUSLINE_ITEMS) {
    if (id === STATUSLINE_CUSTOM_ID) continue; // re-added below by the custom field
    if (!isStatusLineItemId(id) || seen.has(id)) continue;
    seen.add(id);
    items.push(id);
  }
  if (custom && !items.includes(STATUSLINE_CUSTOM_ID)) items.push(STATUSLINE_CUSTOM_ID);
  return { items, custom };
}

export interface StatusLineConfigIoOptions {
  file?: string;
  env?: NodeJS.ProcessEnv;
}

/** Read the persisted config; corrupt/missing file ⇒ DEFAULT (fail-soft). */
export function loadStatusLineConfig(opts: StatusLineConfigIoOptions = {}): StatusLineConfig {
  const file = opts.file ?? statusLineConfigPath(opts.env);
  try {
    if (!existsSync(file)) return defaultStatusLineConfig();
    return normalizeStatusLineConfig(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return defaultStatusLineConfig();
  }
}

/**
 * Persist a config. Returns false (never throws) when the write fails — a
 * read-only home must not take the TUI down.
 */
export function saveStatusLineConfig(
  config: StatusLineConfig,
  opts: StatusLineConfigIoOptions = {},
): boolean {
  const file = opts.file ?? statusLineConfigPath(opts.env);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const body = { version: 1 as const, items: config.items, custom: config.custom };
    writeFileSync(file, JSON.stringify(body, null, 2), { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Enable/disable one item (enabling `custom` without a command is a no-op). */
export function setItemEnabled(config: StatusLineConfig, id: string, enabled: boolean): StatusLineConfig {
  if (!isStatusLineItemId(id)) return config;
  if (id === STATUSLINE_CUSTOM_ID && enabled && !config.custom) return config;
  const has = config.items.includes(id);
  if (enabled === has) return config;
  return enabled
    ? { ...config, items: [...config.items, id] }
    : { ...config, items: config.items.filter((i) => i !== id) };
}

/** Move an item one slot up (`delta: -1`) or down (`delta: +1`). */
export function moveItem(config: StatusLineConfig, id: string, delta: number): StatusLineConfig {
  const from = config.items.indexOf(id);
  if (from < 0) return config;
  const to = Math.min(config.items.length - 1, Math.max(0, from + delta));
  if (to === from) return config;
  const items = [...config.items];
  items.splice(from, 1);
  items.splice(to, 0, id);
  return { ...config, items };
}

/**
 * Set (or clear) the custom command. Setting it appends/enables `custom` at
 * the end of the item list; clearing removes it from the list too.
 */
export function setCustomCommand(
  config: StatusLineConfig,
  command: string | null,
  timeoutMs?: number,
): StatusLineConfig {
  const trimmed = command?.trim() ?? '';
  if (trimmed.length === 0) {
    return { items: config.items.filter((i) => i !== STATUSLINE_CUSTOM_ID), custom: null };
  }
  const custom: StatusLineCustomConfig = {
    command: trimmed,
    timeoutMs: timeoutMs ?? config.custom?.timeoutMs ?? DEFAULT_STATUSLINE_TIMEOUT_MS,
  };
  const items = config.items.includes(STATUSLINE_CUSTOM_ID)
    ? config.items
    : [...config.items, STATUSLINE_CUSTOM_ID];
  return { items, custom };
}

/** Read-modify-write helper: applies `mutate`, persists, never throws. */
export function updateStatusLineConfig(
  mutate: (current: StatusLineConfig) => StatusLineConfig,
  opts: StatusLineConfigIoOptions = {},
): { ok: boolean; config: StatusLineConfig } {
  const next = normalizeStatusLineConfig(mutate(loadStatusLineConfig(opts)));
  const ok = saveStatusLineConfig(next, opts);
  return { ok, config: next };
}
