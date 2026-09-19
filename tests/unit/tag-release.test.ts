/**
 * tag-release.mjs — guard tests (release-floor F2.3).
 *
 * tag-release is the ONLY supported way to cut a release tag. These tests pin
 * its fail-fast order against a scaffolded throwaway git repo: it must refuse
 * a dirty tree, a version that does not match root package.json, and a tag
 * that already exists — all BEFORE it reaches fetch/push, so no test mutates
 * anything outside its temp dir (v2.43.0 lesson: a tag must never land on an
 * uncommitted tree). Since the custody gate, every tag must also declare
 * --scope (a plan phase of ZELARI-2.37-NEXT.md §4, or a written §5 surface
 * exception): these tests pin the refusal without it, the phase whitelist,
 * and that the declaration travels in the annotated tag message.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// These tests spawn real git + node processes per case (init/commit/push/
// fetch/tag). They pass in isolation well under the 5s default, but a full
// parallel suite run (≈20 workers) starves them past it — pin an explicit
// timeout instead of letting the suite flake under load.
vi.setConfig({ testTimeout: 60_000 });

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
  // Deterministic line endings: with a global core.autocrlf=true (typical on
  // Windows) every LF file would report as modified forever and the clean-tree
  // gate would refuse even a fresh scaffold.
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, [...identity, 'add', '-A']);
  git(dir, [...identity, 'commit', '-m', 'scaffold']);
  return dir;
}

// Full scaffold for gates past fetch: stub verify-versions (the temp copy is
// not a real monorepo) and add a local bare "origin" holding main so the
// alignment gate passes. Everything stays inside temp dirs.
function scaffoldAligned(): string {
  const dir = scaffold();
  fs.writeFileSync(path.join(dir, 'scripts', 'verify-versions.mjs'), 'process.exit(0);\n', 'utf8');
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-tag-release-origin-'));
  tmpDirs.push(bareDir);
  git(bareDir, ['init', '--bare', 'origin.git']);
  git(dir, ['remote', 'add', 'origin', path.join(bareDir, 'origin.git')]);
  // The stub rewrites a tracked file — commit it so the clean-tree gate sees a
  // pristine tree, then publish main to the bare origin for the alignment gate.
  git(dir, [...identity, 'add', '-A']);
  git(dir, [...identity, 'commit', '-m', 'stub verify-versions']);
  git(dir, [...identity, 'push', 'origin', 'HEAD:refs/heads/main']);
  return dir;
}

function run(dir: string, ...args: string[]) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(dir, 'scripts', 'tag-release.mjs'), ...args],
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

  it('refuses to tag without --scope (custody gate)', () => {
    const dir = scaffoldAligned();
    const res = run(dir, '9.9.9');
    expect(res.status).toBe(1);
    const out = res.stdout + res.stderr;
    expect(out).toContain('scope');
    expect(out).toContain('§4');
    expect(git(dir, ['tag', '-l']).trim()).toBe('');
  });

  it('refuses an unknown scope value (whitelist)', () => {
    const dir = scaffoldAligned();
    const res = run(dir, '9.9.9', '--scope=plan:UX');
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain('invalid');
    expect(git(dir, ['tag', '-l']).trim()).toBe('');
  });

  it('tags with --scope=plan:<phase> and records it in the tag message', () => {
    const dir = scaffoldAligned();
    const res = run(dir, '9.9.9', '--scope=plan:M1');
    expect(res.status).toBe(0);
    expect(git(dir, ['tag', '-l']).trim()).toBe('v9.9.9');
    expect(git(dir, ['tag', '-l', '--format=%(contents)', 'v9.9.9'])).toContain('scope: plan:M1');
  });

  it('tags with --scope=exception:<reason> and records the exception', () => {
    const dir = scaffoldAligned();
    const res = run(dir, '9.9.9', '--scope=exception:desktop perf emergency');
    expect(res.status).toBe(0);
    expect(git(dir, ['tag', '-l', '--format=%(contents)', 'v9.9.9'])).toContain(
      'exception:desktop perf emergency',
    );
  });
});
