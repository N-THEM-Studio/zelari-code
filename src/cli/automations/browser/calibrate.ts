/**
 * automations/browser/calibrate.ts — selector calibration from the LIVE DOM.
 *
 * Borrowed from OpenBot's `dev:automation` idea (drive the real app, dump the
 * accessible tree by role/name): this opens the channel composer with the
 * logged-in profile and dumps role/aria-label/text of every control in the
 * dialog, so selector JSON can be fixed with DATA instead of guesses. It is
 * strictly non-destructive: no text is ever typed, the post button is never
 * clicked, and the dialog is closed with Escape.
 *
 * Output: a JSON report under <root>/.zelari/automations/calibration/ plus a
 * human summary with suggested post-button selectors.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultContextOpener,
  NAV_TIMEOUT_MS,
  profileDir,
  type ContextOpener,
  type PersistentContextLike,
} from './session.js';
import { isSupportedChannel, loadSelectors, SUPPORTED_CHANNELS, type ChannelSelectors } from './selectors.js';

/** Where the composer lives, per channel (feed/home, not the login page). */
const CALIBRATE_HOME: Record<string, string> = {
  x: 'https://x.com/home',
  facebook: 'https://www.facebook.com/',
};

/** Session cookie names that prove a usable login (locale-proof). */
const SESSION_COOKIES: Record<string, string[]> = {
  x: ['auth_token'],
  facebook: ['c_user', 'xs'],
};

/** One dumped control (JSON-safe; text capped). */
export interface ControlDump {
  tag: string;
  role?: string;
  aria?: string;
  testid?: string;
  text: string;
  disabled?: boolean;
}

export interface CalibrationReport {
  channel: string;
  ok: boolean;
  reason?: string;
  checkedAt: string;
  entryMatched?: string;
  textBoxMatched?: string;
  /** Which of the CURRENT postButton selectors are present right now. */
  postButtonPresent: string[];
  /** Heuristically interesting buttons (label/name matches post verbs). */
  postButtonCandidates: string[];
  controls: ControlDump[];
  reportPath?: string;
}

export interface CalibrateDeps {
  opener?: ContextOpener;
  cwd?: string;
  headless?: boolean;
  /** Where reports are written (default <root>/.zelari/automations/calibration). */
  outDir?: string;
  /** Injectable fs writer for tests. */
  writeReport?: (file: string, body: string) => Promise<void>;
  now?: () => string;
}

/**
 * Pick buttons whose accessible name/text looks like a submit-post verb,
 * localized (en/it/es/pt/fr/de). Pure — unit-tested directly.
 */
export function suggestPostButtons(controls: readonly ControlDump[]): string[] {
  const re = /^(post|pubblica|publish|publicar|publier|veröffentlichen|pubblica ora)\b/i;
  const out: string[] = [];
  for (const c of controls) {
    const isButton = c.role === 'button' || c.tag === 'button' || c.tag === 'input';
    if (!isButton) continue;
    const name = c.aria ?? c.text ?? '';
    if (!name || !re.test(name.trim())) continue;
    const label = c.aria ? `aria="${c.aria}"` : `text="${c.text}"`;
    const entry = `[${c.tag}${c.role ? `[role=${c.role}]` : ''}${c.testid ? `[data-testid=${c.testid}]` : ''} ${label}]`;
    if (!out.includes(entry)) out.push(entry);
  }
  return out.slice(0, 8);
}

/** Heuristic textbox candidates (role=textbox / contenteditable / textarea). */
export function suggestTextBoxes(controls: readonly ControlDump[]): string[] {
  return controls
    .filter((c) => c.role === 'textbox' || c.tag === 'textarea' || c.tag === 'div')
    .slice(0, 8)
    .map((c) => `[${c.tag}${c.role ? `[role=${c.role}]` : ''}${c.testid ? `[data-testid=${c.testid}]` : ''}]`);
}

/** Dump selector: controls inside a dialog first, then a broad fallback. */
const DUMP_IN_DIALOG =
  'div[role="dialog"] [role="button"], div[role="dialog"] button, div[role="dialog"] [role="textbox"], ' +
  'div[role="dialog"] [role="link"], div[role="dialog"] input[type="file"]';
const DUMP_BROAD = '[role="button"], button, [role="textbox"]';

function timestampName(nowIso: string): string {
  const t = nowIso.replace(/[:.]/g, '-');
  return t.slice(0, 19);
}

/**
 * Run one calibration pass. Throws only for unknown channel / bad selectors;
 * every runtime problem becomes `ok:false` + `reason` (never a partial dump
 * presented as success — P1).
 */
export async function runCalibration(channel: string, deps: CalibrateDeps = {}): Promise<CalibrationReport> {
  if (!isSupportedChannel(channel)) {
    throw new Error(`unknown social channel: ${channel} (supported: ${SUPPORTED_CHANNELS.join(', ')})`);
  }
  const sel: ChannelSelectors = await loadSelectors(channel);
  const opener = deps.opener ?? defaultContextOpener;
  const headless = deps.headless ?? true;
  const now = deps.now ?? (() => new Date().toISOString());
  const base: CalibrationReport = {
    channel,
    ok: false,
    checkedAt: now(),
    postButtonPresent: [],
    postButtonCandidates: [],
    controls: [],
  };

  const ctx: PersistentContextLike | null = await opener({ channel, headless, cwd: deps.cwd });
  if (!ctx) return { ...base, reason: 'playwright-unavailable' };
  let page = (await ctx.newPage()) as NonNullable<Awaited<ReturnType<PersistentContextLike['newPage']>>>;
  try {
    await page.goto(CALIBRATE_HOME[channel], { timeout: 45_000, waitUntil: 'domcontentloaded' });
    await page.hasSelector('body', 5_000);

    // GDPR consent wall first (EU profiles): it hides the feed otherwise.
    for (const c of sel.consentButtons ?? []) {
      if (await page.hasSelector(c.selector, 2_000)) {
        await page.click?.(c.selector, { timeout: 3_000 }).catch(() => undefined);
        break;
      }
    }

    // Locale-proof login proof: session cookies, then DOM logged-out markers.
    const cookies = (await ctx.cookies?.()) ?? [];
    const names = new Set(cookies.map((k) => k.name));
    const required = SESSION_COOKIES[channel] ?? [];
    if (!required.every((n) => names.has(n))) {
      return { ...base, reason: `relogin_required (profile lacks ${required.join('+')})` };
    }

    // Open the composer: first matching entry wins (record WHICH one).
    if (!sel.publish) return { ...base, reason: 'selectors file has no publish section' };
    const entries = sel.publish.composeEntry ?? [];
    if (entries.length === 0) {
      return { ...base, reason: 'selectors file has no publish.composeEntry chain' };
    }
    let entryLabel: string | undefined;
    for (const e of entries) {
      if (await page.hasSelector(e.selector, 2_000)) {
        entryLabel = e.label;
        await page.click?.(e.selector, { timeout: 5_000 }).catch(() => undefined);
        break;
      }
    }
    if (!entryLabel) return { ...base, reason: 'composer-open: no entry selector matched (update publish.composeEntry)' };

    let textBoxSel: string | undefined;
    for (const t of sel.publish.textbox) {
      if (await page.hasSelector(t.selector, 4_000)) {
        textBoxSel = t.selector;
        break;
      }
    }
    if (!textBoxSel) return { ...base, reason: 'composer-textbox: no textbox selector matched', entryMatched: entryLabel };

    // The dump: dialog-scoped first; broad fallback when no dialog rendered.
    let controls = (await page.controls?.(DUMP_IN_DIALOG)) ?? [];
    if (controls.length === 0) controls = (await page.controls?.(DUMP_BROAD)) ?? [];
    controls = controls.slice(0, 100);

    const postButtonPresent: string[] = [];
    for (const b of sel.publish.postButton) {
      if (await page.hasSelector(b.selector, 1_000)) postButtonPresent.push(b.selector);
    }

    const report: CalibrationReport = {
      ...base,
      ok: true,
      entryMatched: entryLabel,
      textBoxMatched: textBoxSel,
      postButtonPresent,
      postButtonCandidates: suggestPostButtons(controls),
      controls,
    };

    // Persist the evidence next to the runs (never inside selectors/).
    const outDir = deps.outDir ?? path.join(deps.cwd ?? process.cwd(), '.zelari', 'automations', 'calibration');
    const file = path.join(outDir, `${channel}-${timestampName(report.checkedAt)}.json`);
    const write = deps.writeReport ?? (async (f, body) => {
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, body, 'utf-8');
    });
    await write(file, JSON.stringify(report, null, 2));
    return { ...report, reportPath: file };
  } finally {
    await page.press?.('Escape').catch(() => undefined);
    await ctx.close().catch(() => undefined);
    page = undefined as unknown as typeof page;
  }
}

/** Human summary (used by the CLI when not --json). */
export function formatCalibrationReport(r: CalibrationReport): string {
  const head = `calibrate ${r.channel}: ${r.ok ? 'dump ok' : `FAILED (${r.reason ?? 'unknown'})`} (${r.checkedAt})`;
  if (!r.ok) return head;
  const lines = [
    head,
    `  entry:   ${r.entryMatched}`,
    `  textbox: ${r.textBoxMatched}`,
    `  post button now present: ${r.postButtonPresent.length ? r.postButtonPresent.join(' | ') : 'NONE (calibrate it!)'}`,
    `  post button candidates:  ${r.postButtonCandidates.length ? r.postButtonCandidates.join(' , ') : 'none matched post verbs'}`,
    `  controls dumped: ${r.controls.length}`,
  ];
  if (r.reportPath) lines.push(`  report: ${r.reportPath}`);
  return lines.join('\n');
}
