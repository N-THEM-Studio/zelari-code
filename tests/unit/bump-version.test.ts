/**
 * bump-version / verify-versions — temp-copy contract tests (alignment
 * plan, phase 4). Both scripts run against a scaffolded throwaway repo so
 * the tests can prove: no invented changelog notes, no partial writes on
 * failure, full representation coverage, idempotence, drift detection.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tmpDirs: string[] = [];

function scaffold(changelogEntries: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-bump-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'bump-version.mjs'),
    path.join(dir, 'scripts', 'bump-version.mjs'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'verify-versions.mjs'),
    path.join(dir, 'scripts', 'verify-versions.mjs'),
  );

  const w = (rel: string, content: string) =>
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
  const wj = (rel: string, obj: unknown) => w(rel, JSON.stringify(obj, null, 2) + '\n');

  wj('package.json', {
    name: 'zelari-code',
    version: '2.32.0',
    engines: { npm: '>=11.7.0' },
    packageManager: 'npm@11.7.0',
    devDependencies: { '@zelari/core': '2.32.0' },
  });
  fs.mkdirSync(path.join(dir, 'packages/core/src'), { recursive: true });
  wj('packages/core/package.json', { name: '@zelari/core', version: '2.32.0' });
  w('packages/core/src/version.ts', `export const CORE_VERSION = '2.32.0';\n`);
  w('packages/core/README.md', `# core\n\nCurrent version: **2.32.0**\n`);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  w('docs/GUIDA.md', `Versione documento:** 2.32.0\n`);
  w('README.md', `# scaffold\n`);
  fs.mkdirSync(path.join(dir, 'apps/desktop/src-tauri'), { recursive: true });
  wj('apps/desktop/package.json', { name: '@zelari/desktop', version: '2.32.0' });
  w('apps/desktop/src-tauri/Cargo.toml', `[package]\nname = "zelari-desktop"\nversion = "2.32.0"\n`);
  wj('apps/desktop/src-tauri/tauri.conf.json', { version: '2.32.0' });
  w(
    'apps/desktop/src-tauri/Cargo.lock',
    `[[package]]\nname = "zelari-desktop"\nversion = "2.32.0"\n`,
  );
  wj('package-lock.json', {
    version: '2.32.0',
    packages: {
      '': { version: '2.32.0', devDependencies: { '@zelari/core': '2.32.0' } },
      'packages/core': { version: '2.32.0' },
      'node_modules/@zelari/core': { version: '2.32.0' },
    },
  });
  w(
    'CHANGELOG.md',
    changelogEntries.map((v) => `## [${v}] - 2026-01-01\n\n- scaffold entry ${v}\n`).join('\n'),
  );
  return dir;
}

function run(dir: string, script: string, arg?: string) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(dir, 'scripts', script), ...(arg ? [arg] : [])],
      { cwd: dir, encoding: 'utf8' },
    );
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const readJson = (dir: string, rel: string) => JSON.parse(read(dir, rel));

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('bump-version (temp copy)', () => {
  it('rejects invalid input without touching any manifest', () => {
    const dir = scaffold(['2.32.0']);
    const res = run(dir, 'bump-version.mjs', 'not-a-version');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('neither a bump keyword');
    expect(readJson(dir, 'package.json').version).toBe('2.32.0');
  });

  it('patch bump updates every representation and never edits the changelog', () => {
    const dir = scaffold(['2.32.0', '2.32.1']);
    const changelogBefore = read(dir, 'CHANGELOG.md');
    const res = run(dir, 'bump-version.mjs', 'patch');
    expect(res.status).toBe(0);

    expect(readJson(dir, 'package.json').version).toBe('2.32.1');
    expect(readJson(dir, 'package.json').devDependencies['@zelari/core']).toBe('2.32.1');
    expect(readJson(dir, 'packages/core/package.json').version).toBe('2.32.1');
    expect(readJson(dir, 'apps/desktop/package.json').version).toBe('2.32.1');
    expect(readJson(dir, 'apps/desktop/src-tauri/tauri.conf.json').version).toBe('2.32.1');
    expect(read(dir, 'apps/desktop/src-tauri/Cargo.toml')).toContain('version = "2.32.1"');
    expect(read(dir, 'apps/desktop/src-tauri/Cargo.lock')).toContain('version = "2.32.1"');
    expect(read(dir, 'packages/core/src/version.ts')).toContain("'2.32.1'");
    expect(read(dir, 'packages/core/README.md')).toContain('Current version: **2.32.1**');
    expect(read(dir, 'docs/GUIDA.md')).toContain('Versione documento:** 2.32.1');
    const lock = readJson(dir, 'package-lock.json');
    expect(lock.version).toBe('2.32.1');
    expect(lock.packages[''].version).toBe('2.32.1');
    expect(lock.packages['packages/core'].version).toBe('2.32.1');

    // The bump stamps versions only: the changelog is byte-identical (no
    // invented notes, no hardcoded 2026-07-10 entry).
    expect(read(dir, 'CHANGELOG.md')).toBe(changelogBefore);
  });

  it('refuses to bump when the target changelog entry is missing (no partial writes)', () => {
    const dir = scaffold(['2.32.0']);
    const res = run(dir, 'bump-version.mjs', '2.32.1');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('CHANGELOG.md has no "## [2.32.1]" entry');
    expect(readJson(dir, 'package.json').version).toBe('2.32.0');
    expect(readJson(dir, 'apps/desktop/package.json').version).toBe('2.32.0');
  });

  it('accepts an explicit prerelease version', () => {
    const dir = scaffold(['2.32.0', '2.33.0-rc.1']);
    const res = run(dir, 'bump-version.mjs', '2.33.0-rc.1');
    expect(res.status).toBe(0);
    expect(readJson(dir, 'package.json').version).toBe('2.33.0-rc.1');
    expect(read(dir, 'apps/desktop/src-tauri/Cargo.toml')).toContain('version = "2.33.0-rc.1"');
  });

  it('re-running the same version is idempotent', () => {
    const dir = scaffold(['2.32.0', '2.32.1']);
    expect(run(dir, 'bump-version.mjs', 'patch').status).toBe(0);
    const before = readJson(dir, 'package.json');
    const lockBefore = readJson(dir, 'package-lock.json');
    const res = run(dir, 'bump-version.mjs', '2.32.1');
    expect(res.status).toBe(0);
    expect(readJson(dir, 'package.json')).toEqual(before);
    expect(readJson(dir, 'package-lock.json')).toEqual(lockBefore);
  });
});

describe('verify-versions (temp copy)', () => {
  it('passes on a coherent scaffold', () => {
    const dir = scaffold(['2.32.0']);
    const res = run(dir, 'verify-versions.mjs');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('coherent');
  });

  it('detects an out-of-lockstep desktop manifest', () => {
    const dir = scaffold(['2.32.0']);
    const pkgPath = path.join(dir, 'apps/desktop/package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({ version: '9.9.9' }, null, 2), 'utf8');
    const res = run(dir, 'verify-versions.mjs');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('apps/desktop/package.json version is "9.9.9"');
  });

  it('detects a stale Cargo.lock zelari-desktop stanza', () => {
    const dir = scaffold(['2.32.0']);
    fs.writeFileSync(
      path.join(dir, 'apps/desktop/src-tauri/Cargo.lock'),
      `[[package]]\nname = "zelari-desktop"\nversion = "1.0.0"\n`,
      'utf8',
    );
    const res = run(dir, 'verify-versions.mjs');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('zelari-desktop stanza version is "1.0.0"');
  });
});
