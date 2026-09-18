/**
 * essentialBashConfig — extensible verification-essential bash classifier
 * (plan K2.5, hardening F21).
 *
 * `isVerificationEssential` (budgetRuntime.ts) originally recognised only a
 * hardcoded npm/tsc/vitest/git set, so a protected-mode run on a
 * cargo/pytest/mvn repo could not execute its own verification commands — a
 * forced BLOCKED. This module loads EXTRA matchers and merges them with the
 * built-in list:
 *
 *   1. built-ins (BUILTIN_ESSENTIAL_BASH, plan §13) — always present;
 *   2. `<root>/.zelari/zelari.config.json` → top-level `essentialBash` (an
 *      array of RegExp SOURCE strings). This is the project settings file
 *      userSettings.ts documents (`SETTINGS_FILE_NAME`); the key is read
 *      directly here because it only feeds the budget classifier;
 *   3. `<root>/package.json` `scripts` — any `<pm> run <script>` whose
 *      `<script>` is declared is essential (repo-native verification entry
 *      points, e.g. a `native-test` script that shells out to cargo/pytest).
 *
 * Fail-open by contract: a missing/unreadable/corrupt config contributes
 * nothing; an invalid user RegExp is IGNORED (warned once) and never breaks
 * the built-in list. Loading is lazy + cached per resolved root; tests reset
 * the cache with resetEssentialBashCache().
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SETTINGS_FILE_NAME } from '../userSettings.js';

/** bash commands that count as verification-essential out of the box (plan §13). */
export const BUILTIN_ESSENTIAL_BASH: readonly RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)\b/,
  /\b(npm|pnpm|yarn|bun)\s+run\s+[\w:-]*(typecheck|lint|build)\b/,
  /\bnpx\s+(vitest|tsc|typescript|eslint)\b/,
  /\b(npx\s+)?tsc\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bnode\s+--run\b/,
  /\bgit\s+(diff|status|log|show)\b/,
];

const PACKAGE_MANAGERS = 'npm|pnpm|yarn|bun';

/** Per-resolved-root memo of the merged list (never keyed by relative path). */
const cache = new Map<string, readonly RegExp[]>();
let warnedInvalidRegex = false;

/** Drop the memo (tests, or a config edit mid-process). */
export function resetEssentialBashCache(): void {
  cache.clear();
  warnedInvalidRegex = false;
}

/** Best-effort JSON object read; absent/unreadable/corrupt → null (fail-open). */
function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** RegExp-source strings from `<root>/.zelari/zelari.config.json` (project scope). */
function settingsExtraSources(root: string): string[] {
  const settings = readJsonObject(path.join(root, '.zelari', SETTINGS_FILE_NAME));
  const raw = settings?.['essentialBash'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/** Compile user RegExp sources; an invalid one is ignored (warned once). */
function compileUserSources(sources: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const source of sources) {
    try {
      out.push(new RegExp(source));
    } catch {
      if (!warnedInvalidRegex) {
        warnedInvalidRegex = true;
        console.warn(
          `[essential-bash] ignoring invalid regex in ${SETTINGS_FILE_NAME}.essentialBash: ${JSON.stringify(source)}`,
        );
      }
    }
  }
  return out;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `<pm> run <script>` matchers for every declared package.json script. */
function scriptPatterns(root: string): RegExp[] {
  const pkg = readJsonObject(path.join(root, 'package.json'));
  const scripts = pkg?.['scripts'];
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
  const out: RegExp[] = [];
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof body !== 'string' || body === '') continue;
    out.push(new RegExp(`\\b(${PACKAGE_MANAGERS})\\s+run\\s+${escapeRegExp(name)}\\b`));
  }
  return out;
}

/**
 * Merged essential-bash matchers for `root`: built-ins ∪ settings extras ∪
 * package.json scripts. Lazy + cached per resolved root. Never throws.
 */
export function loadEssentialBashPatterns(root: string = process.cwd()): readonly RegExp[] {
  const key = path.resolve(root);
  const cached = cache.get(key);
  if (cached) return cached;
  const merged = [
    ...BUILTIN_ESSENTIAL_BASH,
    ...compileUserSources(settingsExtraSources(key)),
    ...scriptPatterns(key),
  ];
  cache.set(key, merged);
  return merged;
}
