/**
 * statusChips.ts — the StatusBar chips whose computation is NOT free.
 *
 * v2.32 (S4) put the OS-jail honesty chip in the status bar: "jail: on (bwrap)"
 * / "jail: advisory (win32)". Its value depends only on the environment, the
 * active policy-load surface and the platform — never on the render that shows
 * it. Computing it inside the render body meant a `probeJailBackend()` call per
 * paint (diagnosi 2026-09-15, slice 5), and with a test backend injected
 * `probe()` runs fresh every single call.
 *
 * `cachedJailStatusChip()` resolves the chip ONCE per distinct inputs and hands
 * back the SAME object identity afterwards, so a memoized `<StatusBar>` sees
 * equal props and bails out of the repaint entirely.
 *
 * The cache key is every input that can flip the chip: platform, the jail /
 * permission / policy-load env vars, the CI flag and the registered
 * policy-load surface. A runtime change of any of them re-resolves the chip.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveSessionsDir } from '@zelari/core/session';
import { activeJailMode, probeJailBackend, OS_JAIL_ENV } from '../safety/osJail.js';
import { activePolicyLoadSurface, POLICY_LOAD_MODE_ENV } from '../safety/policyLoadMode.js';
import { loadStatusLineConfig } from '../statusline/statuslineConfig.js';
import { readVerdictFeed, verdictFeedText, type VerdictFeed } from '../statusline/verdictFeed.js';
import { getCurrentSessionId } from '../sessionManager.js';

/** A one-line chip: what to show, and how honest it is (green = on, yellow = advisory). */
export interface StatusChip {
  label: string;
  tone: 'green' | 'yellow';
}

/**
 * t114: is this item part of the user's (or default) status-line order?
 * Answers from the persisted config, so `/statusline off jail` hides the chip
 * on the next repaint. Fail-soft: an unreadable config resolves the DEFAULT
 * order — the bar never loses a chip because a pref file went missing.
 */
export function statusLineItemEnabled(id: string): boolean {
  try {
    return loadStatusLineConfig().items.includes(id);
  } catch {
    return true;
  }
}

/**
 * Jail chip for the StatusBar (v2.32 S4): "jail: on (bwrap)" when a real
 * backend is active AND required, "jail: advisory (win32)" when execution is
 * a VISIBLE fail-open on a platform with no honest backend. `ZELARI_OS_JAIL=off`
 * hides the chip (explicit opt-out, stated in the docs).
 */
export function jailStatusChip(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): StatusChip | null {
  const mode = activeJailMode(env);
  if (mode === 'off') return null;
  const probe = probeJailBackend(platform);
  if (!probe.available) {
    return { label: `jail: advisory (${probe.backend})`, tone: 'yellow' };
  }
  return mode === 'required'
    ? { label: `jail: on (${probe.backend})`, tone: 'green' }
    : { label: `jail: advisory (${probe.backend})`, tone: 'yellow' };
}

/** Every input the chip depends on, flattened into a comparable key. */
function jailChipKey(env: NodeJS.ProcessEnv, platform: string): string {
  return [
    platform,
    env[OS_JAIL_ENV] ?? '',
    env.ZELARI_PERMISSION_PRESET ?? '',
    env[POLICY_LOAD_MODE_ENV] ?? '',
    env.CI ?? '',
    activePolicyLoadSurface(),
  ].join('|');
}

let chipCache: { key: string; chip: StatusChip | null } | null = null;

/**
 * Cached jail chip — safe to call from a render body: the (potentially
 * expensive) probe runs once per distinct key, and repeated calls return the
 * SAME object so `<StatusBar>`'s memo comparator sees identical props.
 */
export function cachedJailStatusChip(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): StatusChip | null {
  const key = jailChipKey(env, platform);
  if (chipCache && chipCache.key === key) return chipCache.chip;
  // t114: the jail chip obeys the status-line configuration — a disabled item
  // resolves to null (hidden) and is cached like any other resolution.
  const chip = statusLineItemEnabled('jail') ? jailStatusChip(env, platform) : null;
  chipCache = { key, chip };
  return chip;
}

/**
 * TEST-ONLY: drop the memoized chip so a test can observe a fresh resolve
 * (injected backend / env). Production never needs it — the key invalidates.
 */
export function resetJailChipCacheForTests(): void {
  chipCache = null;
}

/**
 * t124 (openharness-steal): the `verdict` status-line item — verification
 * progress derived from the CURRENT run's spine (derive-only, ADR-0016/0024).
 * Text and verdict word come from verdictFeed; this module only adds the
 * paint-side caching discipline: the spine is (re)read only when the session
 * id or the log's mtime changes, so a ~30x/s repaint never re-parses it.
 */
export interface VerdictChip {
  label: string;
  tone: 'green' | 'yellow' | 'red';
}

/** Pure: feed -> chip. Exported for tests; never touches disk. */
export function verdictChipFromFeed(
  feed: VerdictFeed | null,
  env: NodeJS.ProcessEnv = process.env,
): VerdictChip | null {
  const label = verdictFeedText(feed, env);
  if (label === null) return null;
  const tone =
    feed?.ready === true ? 'green' : feed?.verdict === 'BLOCKED' ? 'red' : 'yellow';
  return { label, tone };
}

/** Every input the verdict chip depends on, flattened into a comparable key. */
function verdictChipKey(env: NodeJS.ProcessEnv): string {
  const sessionId = getCurrentSessionId();
  let mtime = 'none';
  if (sessionId) {
    try {
      const file = path.join(resolveSessionsDir({ env }), sessionId, 'events.jsonl');
      mtime = existsSync(file) ? String(statSync(file).mtimeMs) : 'none';
    } catch {
      mtime = 'none';
    }
  }
  return `${sessionId ?? 'no-session'}|${env.ZELARI_VERDICT_FEED ?? ''}|${mtime}`;
}

let verdictChipCache: { key: string; chip: VerdictChip | null } | null = null;

/**
 * Cached verdict chip — safe to call from a render body. Opt-in item: it only
 * paints when `/statusline on verdict` added it to the configured order.
 */
export function cachedVerdictStatusChip(env: NodeJS.ProcessEnv = process.env): VerdictChip | null {
  if (!statusLineItemEnabled('verdict')) return null;
  const key = verdictChipKey(env);
  if (verdictChipCache && verdictChipCache.key === key) return verdictChipCache.chip;
  const chip = verdictChipFromFeed(readVerdictFeed({ env }), env);
  verdictChipCache = { key, chip };
  return chip;
}

/** TEST-ONLY: drop the memoized verdict chip (same discipline as the jail chip). */
export function resetVerdictChipCacheForTests(): void {
  verdictChipCache = null;
}
