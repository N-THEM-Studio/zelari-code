/**
 * K2.5 (F21) — extensible ESSENTIAL_BASH.
 *
 * The built-in classifier denied every non-JS verification command, so a
 * protected-mode run on a cargo/pytest/mvn repo could not execute its own
 * checks (forced BLOCKED). These tests pin the fix: repo settings
 * (`.zelari/zelari.config.json` → `essentialBash`) and package.json `scripts`
 * add patterns ON TOP of the built-in list, which stays the fail-open fallback
 * (absent/corrupt config → exactly the built-ins).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_ESSENTIAL_BASH,
  loadEssentialBashPatterns,
  resetEssentialBashCache,
} from './essentialBashConfig.js';
import { isVerificationEssential } from './budgetRuntime.js';

let dir: string | undefined;

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zelari-essential-bash-'));
  dir = root;
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

/** Exercise the real wired classifier (protected-mode essential check). */
const essential = (cmd: string, root: string): boolean =>
  isVerificationEssential('bash', { command: cmd }, 'implement', root);

beforeEach(() => {
  resetEssentialBashCache();
});
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});

describe('K2.5 essential-bash — built-in baseline', () => {
  it('bare repo (no config, no package.json) → exactly the built-in list', () => {
    const root = makeRepo({});
    expect([...loadEssentialBashPatterns(root)]).toEqual([...BUILTIN_ESSENTIAL_BASH]);
    expect(essential('npm test', root)).toBe(true);
    expect(essential('git diff --stat', root)).toBe(true);
  });

  it('cargo / pytest / mvn are denied without declared extras (pre-fix behavior)', () => {
    const root = makeRepo({});
    expect(essential('cargo test --workspace', root)).toBe(false);
    expect(essential('pytest -q', root)).toBe(false);
    expect(essential('mvn -q test', root)).toBe(false);
    expect(essential('npm install lodash', root)).toBe(false);
  });
});

describe('K2.5 essential-bash — extras from .zelari/zelari.config.json', () => {
  it('declared regexes admit cargo / pytest / mvn in the fixture repo', () => {
    const root = makeRepo({
      '.zelari/zelari.config.json': JSON.stringify({
        essentialBash: ['\\bcargo\\s+test\\b', '\\bpytest\\b', '\\bmvn\\s+test\\b'],
      }),
    });
    expect(essential('cargo test --workspace', root)).toBe(true);
    expect(essential('pytest -q tests', root)).toBe(true);
    expect(essential('mvn test', root)).toBe(true);
    // a command the extras do not name stays non-essential
    expect(essential('cargo publish', root)).toBe(false);
    expect(essential('rm -rf target', root)).toBe(false);
  });

  it('corrupt settings file → fail-open to exactly the built-in list', () => {
    const root = makeRepo({ '.zelari/zelari.config.json': '{ not json' });
    expect([...loadEssentialBashPatterns(root)]).toEqual([...BUILTIN_ESSENTIAL_BASH]);
    expect(essential('cargo test', root)).toBe(false);
  });

  it('an invalid regex is ignored (warned once) while valid entries + built-ins stay', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = makeRepo({
      '.zelari/zelari.config.json': JSON.stringify({ essentialBash: ['(', '\\bcargo\\b'] }),
    });
    expect(essential('cargo test', root)).toBe(true);
    expect(essential('npm test', root)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a non-array essentialBash value is ignored', () => {
    const root = makeRepo({
      '.zelari/zelari.config.json': JSON.stringify({ essentialBash: 'cargo' }),
    });
    expect([...loadEssentialBashPatterns(root)]).toEqual([...BUILTIN_ESSENTIAL_BASH]);
  });
});

describe('K2.5 essential-bash — package.json scripts', () => {
  it('npm/pnpm run <declared script> becomes essential', () => {
    const root = makeRepo({
      'package.json': JSON.stringify({
        name: 'native-fixture',
        scripts: { 'native-check': 'cargo test --workspace', 'native-audit': 'cargo clippy' },
      }),
    });
    expect(essential('npm run native-check', root)).toBe(true);
    expect(essential('pnpm run native-audit', root)).toBe(true);
    // not declared, and deliberately not a built-in `…(typecheck|lint|build)` name
    expect(essential('npm run native-release', root)).toBe(false);
    expect(essential('npm install cargo', root)).toBe(false); // not a `run` invocation
  });

  it('script names are regex-escaped (a dot is a literal, not a wildcard)', () => {
    const root = makeRepo({
      'package.json': JSON.stringify({ scripts: { 'cargo.check': 'cargo test' } }),
    });
    expect(essential('npm run cargo.check', root)).toBe(true);
    // an unescaped `.` in the script name would wrongly match `cargoXcheck`
    expect(essential('npm run cargoXcheck', root)).toBe(false);
  });
});

describe('K2.5 essential-bash — lazy cache', () => {
  it('is cached per root until resetEssentialBashCache()', () => {
    const root = makeRepo({
      '.zelari/zelari.config.json': JSON.stringify({ essentialBash: [] }),
      'package.json': JSON.stringify({ scripts: {} }),
    });
    const first = loadEssentialBashPatterns(root);
    expect(loadEssentialBashPatterns(root)).toBe(first); // memoized instance
    // A later config edit is NOT seen while the cache is warm…
    writeFileSync(
      path.join(root, '.zelari', 'zelari.config.json'),
      JSON.stringify({ essentialBash: ['\\bcargo\\b'] }),
      'utf8',
    );
    expect(essential('cargo test', root)).toBe(false);
    // …and IS after an explicit reset.
    resetEssentialBashCache();
    expect(essential('cargo test', root)).toBe(true);
  });
});
