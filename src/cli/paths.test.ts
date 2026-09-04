/**
 * paths.test.ts — hermetic coverage for the zelari home + legacy migration.
 *
 * `os.homedir` is mocked to an isolated tmp dir so the legacy roots
 * (exported by paths.ts as LEGACY_ROOT_NAMES) are created INSIDE the
 * sandbox; `ZELARI_HOME` points at a second directory inside the same
 * sandbox for the new home. No test ever touches the real user home.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Shared state for the hoisted `vi.mock` factory below. */
const sandbox = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => sandbox.home;
  return {
    ...actual,
    homedir,
    default: {
      ...(actual as unknown as { default: object }).default,
      homedir,
    },
  };
});

import {
  auditLogPath,
  branchesDir,
  ensureZelariHome,
  keyStorePath,
  LEGACY_ROOT_NAMES,
  metricsPath,
  zelariHome,
  type MigrationMarker,
} from './paths.js';

// Legacy roots live under the MOCKED home (~/.tmp/<name>); the names come
// from the migration table in paths.ts.
const legacyRootDir = (name: (typeof LEGACY_ROOT_NAMES)[number]) =>
  path.join(sandbox.home, '.tmp', name);
const legacyZelariRoot = () => legacyRootDir(LEGACY_ROOT_NAMES[0]);
const legacyAnathemaRoot = () => legacyRootDir(LEGACY_ROOT_NAMES[1]);
// The new home is overridden via ZELARI_HOME (a sibling inside the sandbox).
const newHome = () => path.join(sandbox.home, 'zelari-home');

const ENV_KEYS = ['ZELARI_HOME', 'ANATHEMA_METRICS_FILE'] as const;

function readMarker(home: string): MigrationMarker {
  return JSON.parse(readFileSync(path.join(home, '.migrated'), 'utf-8')) as MigrationMarker;
}

function backupDirsOf(root: string): string[] {
  return readdirSync(path.dirname(root)).filter(
    (entry) => entry.startsWith(path.basename(root) + '.bak-'),
  );
}

describe('zelari home + legacy one-shot migration', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    sandbox.home = mkdtempSync(path.join(os.tmpdir(), 'zelari-paths-'));
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ZELARI_HOME = newHome();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(sandbox.home, { recursive: true, force: true });
  });

  it('(1) migrates both legacy roots: files readable in the new home, backup kept, marker written', () => {
    // Seed both legacy roots with files + a nested directory.
    mkdirSync(path.join(legacyZelariRoot(), 'sessions'), { recursive: true });
    writeFileSync(path.join(legacyZelariRoot(), 'keys.json'), '{"k":1}', 'utf-8');
    writeFileSync(path.join(legacyZelariRoot(), 'sessions', 's1.jsonl'), '{"e":1}', 'utf-8');
    mkdirSync(legacyAnathemaRoot(), { recursive: true });
    writeFileSync(path.join(legacyAnathemaRoot(), 'metrics.jsonl'), '{"m":1}', 'utf-8');

    const home = ensureZelariHome();

    expect(home).toBe(newHome());
    expect(readFileSync(path.join(home, 'keys.json'), 'utf-8')).toBe('{"k":1}');
    expect(readFileSync(path.join(home, 'sessions', 's1.jsonl'), 'utf-8')).toBe('{"e":1}');
    expect(readFileSync(path.join(home, 'metrics.jsonl'), 'utf-8')).toBe('{"m":1}');

    // Each legacy root got exactly one backup, and its entries were moved out.
    for (const root of [legacyZelariRoot(), legacyAnathemaRoot()]) {
      const backups = backupDirsOf(root);
      expect(backups).toHaveLength(1);
      expect(readdirSync(root)).toEqual([]);
    }
    const zelariBackup = path.join(path.dirname(legacyZelariRoot()), backupDirsOf(legacyZelariRoot())[0]);
    expect(readFileSync(path.join(zelariBackup, 'keys.json'), 'utf-8')).toBe('{"k":1}');

    // Marker records the run and is idempotency-guarding.
    const marker = readMarker(home);
    expect(marker.moved).toHaveLength(3);
    expect(marker.from).toContain(legacyZelariRoot());
    expect(marker.from).toContain(legacyAnathemaRoot());
    expect(typeof marker.at).toBe('string');
    expect(new Date(marker.at).getTime()).not.toBeNaN();
  });

  it('(2) never overwrites: a populated new home wins and legacy files stay put', () => {
    mkdirSync(newHome(), { recursive: true });
    writeFileSync(path.join(newHome(), 'keys.json'), '{"k":"new"}', 'utf-8');
    mkdirSync(legacyZelariRoot(), { recursive: true });
    writeFileSync(path.join(legacyZelariRoot(), 'keys.json'), '{"k":"old"}', 'utf-8');

    const home = ensureZelariHome();

    expect(readFileSync(path.join(home, 'keys.json'), 'utf-8')).toBe('{"k":"new"}');
    // Nothing is ever deleted: the conflicting legacy copy stays where it was.
    expect(readFileSync(path.join(legacyZelariRoot(), 'keys.json'), 'utf-8')).toBe('{"k":"old"}');
    const marker = readMarker(home);
    expect(marker.moved).toEqual([]);
  });

  it('(3) marker present: strict no-op (no move, no backup)', () => {
    mkdirSync(newHome(), { recursive: true });
    writeFileSync(
      path.join(newHome(), '.migrated'),
      JSON.stringify({ from: [], at: 'earlier-run', moved: [] }),
      'utf-8',
    );
    mkdirSync(legacyZelariRoot(), { recursive: true });
    writeFileSync(path.join(legacyZelariRoot(), 'keys.json'), '{"k":1}', 'utf-8');

    ensureZelariHome();

    expect(existsSync(path.join(legacyZelariRoot(), 'keys.json'))).toBe(true);
    expect(existsSync(path.join(newHome(), 'keys.json'))).toBe(false);
    expect(readdirSync(path.dirname(legacyZelariRoot())).filter((e) => e.includes('.bak-'))).toEqual([]);
  });

  it('(4) ZELARI_HOME wins over the default home; a specific env var wins over ZELARI_HOME', () => {
    // env ZELARI_HOME > mocked homedir default
    expect(zelariHome()).toBe(newHome());
    expect(metricsPath()).toBe(path.join(newHome(), 'metrics.jsonl'));

    // Blank ZELARI_HOME counts as unset → fall back to ~/.zelari-code.
    process.env.ZELARI_HOME = '';
    expect(zelariHome()).toBe(path.join(sandbox.home, '.zelari-code'));

    // Specific env var > ZELARI_HOME.
    process.env.ZELARI_HOME = newHome();
    process.env.ANATHEMA_METRICS_FILE = path.join(sandbox.home, 'custom-metrics.jsonl');
    expect(metricsPath()).toBe(path.join(sandbox.home, 'custom-metrics.jsonl'));
    // Other getters keep following ZELARI_HOME.
    expect(keyStorePath()).toBe(path.join(newHome(), 'keys.json'));
    expect(branchesDir()).toBe(path.join(newHome(), 'branches'));
    expect(auditLogPath()).toBe(path.join(newHome(), 'audit.jsonl'));
  });

  it('(5) no legacy roots: safe no-op that just creates home + marker', () => {
    const home = ensureZelariHome();

    expect(home).toBe(newHome());
    expect(existsSync(path.join(home, '.migrated'))).toBe(true);
    // The legacy tmp root was never created by the migration itself.
    expect(existsSync(path.join(sandbox.home, '.tmp'))).toBe(false);
    // Second call short-circuits on the marker.
    expect(ensureZelariHome()).toBe(home);
    const marker = readMarker(home);
    expect(marker.moved).toEqual([]);
  });
});
