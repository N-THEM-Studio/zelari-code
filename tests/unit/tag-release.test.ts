/**
 * tag-release.mjs — guard tests (release-floor F2.3).
 *
 * tag-release is the ONLY supported way to cut a release tag. These tests pin
 * its fail-fast order against a scaffolded throwaway git repo: it must refuse
 * a dirty tree, a version that does not match root package.json, and a tag
 * that already exists — all BEFORE it reaches fetch/push, so no test mutates
 * anything outside its temp dir (v2.43.0 lesson: a tag must never land on an
 * uncommitted tree).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tmpDirs: string[] = [];

// Deterministic identity so `commit`/`tag` never depend on the runner's git config.
const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function scaffold(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-tag-release-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const s of ['tag-release.mjs', 'verify-versions.mjs', 'runtime-floor.mjs']) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', s), path.join(dir, 'scripts', s));
  }
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'zelari-code', version: '9.9.9' }, null, 2) + '\n',
    'utf8',
  );
  git(dir, ['init', '-b', 'main']);
  git(dir, [...identity, 'add', '-A']);
  git(dir, [...identity, 'commit', '-m', 'scaffold']);
  return dir;
}

function run(dir: string, arg?: string) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(dir, 'scripts', 'tag-release.mjs'), ...(arg ? [arg] : [])],
      { cwd: dir, encoding: 'utf8' },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('tag-release (temp copy)', () => {
  it('refuses on dirty tree', () => {
    const dir = scaffold();
    fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'wip\n', 'utf8');
    const res = run(dir, '9.9.9');
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain('not clean');
  });

  it('refuses on version mismatch', () => {
    const dir = scaffold();
    const res = run(dir, '1.2.3');
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain('version');
  });

  it('refuses when tag already exists', () => {
    const dir = scaffold();
    git(dir, [...identity, 'tag', '-a', 'v9.9.9', '-m', 'x']);
    const res = run(dir, '9.9.9');
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain('already exists');
  });
});
