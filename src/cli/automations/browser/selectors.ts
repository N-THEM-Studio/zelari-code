/**
 * automations/browser/selectors.ts — per-channel login selectors (F3.1).
 *
 * The selectors are DATA, not code: one JSON file per channel under
 * `./selectors/<channel>.json`, editable at runtime (no recompile). A broken
 * CSS/selector set is diagnosed by `zelari-code automation probe <channel>`,
 * never by shipping new code. Each list (`loggedIn` / `loggedOut`) is an
 * ordered fallback chain — the FIRST matching label wins.
 *
 * Resolution order for the data directory: explicit `dir` override →
 * `ZELARI_BROWSER_SELECTORS_DIR` → next to this module → the source tree
 * (dev: bundled CLI running from the repo root). Unknown channel ⇒ hard error.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Channels that have a browser session manager. Keep in sync with ./selectors. */
export const SUPPORTED_CHANNELS = ['x', 'facebook'] as const;
export type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];

/** Zod enum reused by the CLI for `--channel` / positional parsing. */
export const ChannelSchema = z.enum(SUPPORTED_CHANNELS);

/** One labelled selector in a fallback chain. */
export const SelectorEntrySchema = z.object({
  label: z.string().min(1),
  selector: z.string().min(1),
});
export type SelectorEntry = z.infer<typeof SelectorEntrySchema>;

/**
 * Composer/publish fallback chains (F3.2). Every field is an ordered chain; the
 * ones the flow cannot run without (`textbox`, `postButton`) are required, the
 * rest are optional so a channel that only supports login (or a channel whose
 * publish support lands later) still validates.
 */
export const PublishSelectorsSchema = z.object({
  /** Click target that opens the composer from the home timeline. */
  composeEntry: z.array(SelectorEntrySchema).min(1).optional(),
  /** The contenteditable tweet textbox (required to type). */
  textbox: z.array(SelectorEntrySchema).min(1),
  /** The "Post" button (required to publish). */
  postButton: z.array(SelectorEntrySchema).min(1),
  /**
   * Multi-step composer "Next" buttons (it "Avanti", en "Next", …): clicked
   * BETWEEN typing and the post button when Facebook renders the stepped
   * composer — the final "Pubblica/Post" only appears after advancing.
   */
  advanceButtons: z.array(SelectorEntrySchema).min(1).optional(),
  /** Post-publish toast "View" link — the PRIMARY permalink source. */
  toastView: z.array(SelectorEntrySchema).min(1).optional(),
  /** Media file input (optional; missing ⇒ text-only with a warning). */
  fileInput: z.array(SelectorEntrySchema).min(1).optional(),
  /** Nav link to the author's own profile — the FALLBACK permalink source. */
  profileLink: z.array(SelectorEntrySchema).min(1).optional(),
  /** Post anchors on the profile — the FALLBACK permalink source. */
  profilePost: z.array(SelectorEntrySchema).min(1).optional(),
  /**
   * Post-navigation logged-OUT markers (F3.3 hardening): when any of these is
   * present after loading the composer landing page, the cookies passed the
   * local gate but the SERVER rejected the session — the run must stop with
   * ReloginRequired BEFORE any click/typing (localized: 'Accedi', 'Log in', …).
   */
  loggedOutMarkers: z.array(SelectorEntrySchema).min(1).optional(),
});
export type PublishSelectors = z.infer<typeof PublishSelectorsSchema>;

/** The parsed shape of one `selectors/<channel>.json` file. */
export const ChannelSelectorsSchema = z.object({
  channel: z.string().min(1),
  loginUrl: z.string().min(1),
  /** Ordered fallback chain: first present selector means "logged in". */
  loggedIn: z.array(SelectorEntrySchema).min(1),
  /** Ordered fallback chain: first present selector means "logged out". */
  loggedOut: z.array(SelectorEntrySchema).min(1),
  /**
   * Locale-proof PRIMARY login signal: session/auth cookie names — logged in
   * iff ALL of them are present in the persistent profile (X `auth_token`,
   * Facebook `c_user`+`xs`). DOM selectors stay as the fallback because
   * aria-labels get translated and the DOMs are A/B-shuffled.
   */
  sessionCookies: z.array(z.string().min(1)).min(1).optional(),
  /**
   * GDPR cookie-wall "allow all" buttons (localized). EU accounts see this
   * interstitial BEFORE the feed renders — login/health/publish flows dismiss
   * it (the same consent the user gave in the headed session) or every
   * downstream selector would miss. Optional ⇒ older files still validate.
   */
  consentButtons: z.array(SelectorEntrySchema).min(1).optional(),
  /** Composer/publish chains (F3.2). Optional ⇒ facebook.json still validates. */
  publish: PublishSelectorsSchema.optional(),
  notes: z.string().optional(),
  /** Free-form note (e.g. "UNVERIFIED-GUESSES" for the publish chains). */
  _comment: z.string().optional(),
});
export type ChannelSelectors = z.infer<typeof ChannelSelectorsSchema>;

/** Type guard for a supported channel id. */
export function isSupportedChannel(channel: string): channel is SupportedChannel {
  return (SUPPORTED_CHANNELS as readonly string[]).includes(channel);
}

/**
 * Selectors-dir candidates derived from the MODULE location by walking up to the
 * package root (bounded). This is what makes the bundled CLI cwd-INDEPENDENT: the
 * dev bundle sits at `<pkgRoot>/dist/cli/main.bundled.js`, so the source data at
 * `<pkgRoot>/src/cli/automations/browser/selectors` is a couple of levels up —
 * regardless of the `process.cwd()` a spawner (e.g. the Desktop, whose cwd is the
 * user's workdir, not the repo root) chose. Exported for the unit test.
 */
export function moduleRelativeSelectorsDirs(here: string): string[] {
  const out: string[] = [];
  let cur = here;
  for (let i = 0; i < 8; i += 1) {
    const parent = path.dirname(cur);
    if (parent === cur) break; // filesystem root
    out.push(path.join(parent, 'src', 'cli', 'automations', 'browser', 'selectors'));
    out.push(path.join(parent, 'dist', 'cli', 'automations', 'browser', 'selectors'));
    cur = parent;
  }
  return out;
}

/**
 * Locate the directory holding `selectors/*.json`.
 * Explicit `dir` wins; then the env override; then the candidates that work in
 * src (vitest), in a bundled CLI run from ANY cwd (module-relative walk up), and
 * the `process.cwd()` source tree as a last resort.
 */
export function selectorsDir(dir?: string): string {
  if (dir && dir.length > 0) return dir;
  const env = process.env.ZELARI_BROWSER_SELECTORS_DIR?.trim();
  if (env) return env;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'selectors'), // src/cli/automations/browser/selectors (tsx/vitest)
    path.join(here, 'automations', 'browser', 'selectors'), // dist/cli (bundled asset)
    // Bundled CLI spawned from another cwd: reach the source tree relative to
    // THIS module (the Desktop sets cwd = the user's workdir, not the repo root).
    ...moduleRelativeSelectorsDirs(here),
    path.join(process.cwd(), 'src', 'cli', 'automations', 'browser', 'selectors'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * Load + validate the selectors for `channel`. Throws a descriptive Error on an
 * unknown channel, a missing file, malformed JSON, a schema mismatch, or a file
 * whose `channel` field does not match the requested one — the probe surfaces
 * these verbatim.
 */
export async function loadSelectors(channel: string, dir?: string): Promise<ChannelSelectors> {
  if (!isSupportedChannel(channel)) {
    throw new Error(
      `unknown social channel: ${channel} (supported: ${SUPPORTED_CHANNELS.join(', ')})`,
    );
  }
  const file = path.join(selectorsDir(dir), `${channel}.json`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    throw new Error(`selectors file not found: ${file}`);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    throw new Error(`selectors file is malformed JSON: ${file} (${e instanceof Error ? e.message : String(e)})`);
  }
  const parsed = ChannelSelectorsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`selectors file is invalid: ${file} (${issues})`);
  }
  if (parsed.data.channel !== channel) {
    throw new Error(
      `selectors file ${file} declares channel "${parsed.data.channel}", expected "${channel}"`,
    );
  }
  return parsed.data;
}
