/**
 * verificationAdapters tests — P1.A / t19: multi-ecosystem detection for the
 * native criteria pack.
 *
 * Locks:
 *  - registry resolution: highest detect score wins; empty dir → null;
 *  - node: package-manager via packageManager field + lockfiles
 *    (npm/pnpm/yarn/bun), default npm; missing npm script → null (dropped);
 *  - python/rust/go plans per honest-unknown semantics;
 *  - java/dotnet (t24 §P1.A2): marker-score detection + JVM/.NET plans;
 *  - env overrides still win over ANY adapter plan ('' disables);
 *  - evaluateNativePack actually consumes the registry (wiring not dead code).
 *
 * Fixtures are real tmpdir trees (win32-safe: path.join, no bash-isms).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShellProvider, ShellResult } from '@zelari/core/runtime';
import {
  VERIFICATION_ADAPTERS,
  dotnetAdapter,
  goAdapter,
  javaAdapter,
  nodeAdapter,
  pythonAdapter,
  resolveAdapterForRoot,
  rustAdapter,
} from './index.js';
import { evaluateNativePack, resolvePackCommandsForRoot } from '../nativeVerification.js';

let roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

async function makeRepo(files: Record<string, string> = {}, dirs: string[] = []): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'zelari-adapters-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    if (name.includes('/')) await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf-8');
  }
  for (const dir of dirs) await mkdir(path.join(root, dir), { recursive: true });
  return root;
}

const PACKAGE_JSON = JSON.stringify({
  name: 'fixture',
  scripts: { typecheck: 'tsc --noEmit', test: 'vitest run', build: 'tsc -b' },
});

function stubShell(): ShellProvider {
  return {
    async exec(command: string): Promise<ShellResult> {
      return { exitCode: 0, stdout: `ran ${command}`, stderr: '', durationMs: 1, timedOut: false };
    },
  };
}

describe('resolveAdapterForRoot (registry)', () => {
  it('registers node first, then python/rust/go/java/dotnet (tie-break contract order)', () => {
    expect(VERIFICATION_ADAPTERS[0]).toBe(nodeAdapter);
    expect(VERIFICATION_ADAPTERS.slice(1)).toEqual([
      pythonAdapter,
      rustAdapter,
      goAdapter,
      javaAdapter,
      dotnetAdapter,
    ]);
  });

  it('empty directory → no adapter; pack contributes nothing', async () => {
    const root = await makeRepo();
    expect(await resolveAdapterForRoot(root)).toBeNull();
    const plan = await resolvePackCommandsForRoot({ ZELARI_VERIFY_PACK: '1' }, root);
    expect(plan).toEqual({ typecheckCommand: null, testCommand: null, buildCommand: null });
    expect(plan.typecheckCommand).toBeNull();
    expect(plan.testCommand).toBeNull();
    expect(plan.buildCommand).toBeNull();
    expect(await evaluateNativePack({ env: { ZELARI_VERIFY_PACK: '1' }, cwd: root, shell: stubShell() })).toBeNull();
  });

  it('picks the owning ecosystem and scores 0 on foreign markers (isolation)', async () => {
    const rustRoot = await makeRepo({ 'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n' });
    const resolved = await resolveAdapterForRoot(rustRoot);
    expect(resolved).toBe(rustAdapter);
    expect(await nodeAdapter.detect(rustRoot)).toBe(0);
    expect(await pythonAdapter.detect(rustRoot)).toBe(0);
    expect(await goAdapter.detect(rustRoot)).toBe(0);
    expect(await javaAdapter.detect(rustRoot)).toBe(0);
    expect(await dotnetAdapter.detect(rustRoot)).toBe(0);

    const goRoot = await makeRepo({ 'go.mod': 'module example.com/x\n\ngo 1.22\n' });
    expect(await resolveAdapterForRoot(goRoot)).toBe(goAdapter);

    const gradleRoot = await makeRepo({ gradlew: '#!/bin/sh\n', 'build.gradle': '' });
    expect(await resolveAdapterForRoot(gradleRoot)).toBe(javaAdapter);
    expect(await dotnetAdapter.detect(gradleRoot)).toBe(0);

    const slnRoot = await makeRepo({ 'App.sln': '' });
    expect(await resolveAdapterForRoot(slnRoot)).toBe(dotnetAdapter);
    expect(await javaAdapter.detect(slnRoot)).toBe(0);
  });
});

describe('node adapter — package manager resolution', () => {
  it('package.json without lockfile or field → default npm', async () => {
    const root = await makeRepo({ 'package.json': PACKAGE_JSON });
    const plan = await nodeAdapter.buildPlan(root);
    expect(plan).toEqual({
      typecheckCommand: 'npm run typecheck',
      testCommand: 'npm run test',
      buildCommand: 'npm run build',
    });
  });

  it.each([
    ['package-lock.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
  ])('%s → %s run …', async (lockfile, pm) => {
    const root = await makeRepo({ 'package.json': PACKAGE_JSON, [lockfile]: '' });
    expect((await nodeAdapter.buildPlan(root)).testCommand).toBe(`${pm} run test`);
  });

  it('packageManager field wins and parses corepack-style values', async () => {
    const pkg = JSON.stringify({
      name: 'fixture',
      packageManager: 'pnpm@9.1.0+sha512.abcdef',
      scripts: PACKAGE_JSON ? JSON.parse(PACKAGE_JSON).scripts : {},
    });
    const root = await makeRepo({
      'package.json': pkg,
      'package-lock.json': '', // ignored: explicit field wins
    });
    expect((await nodeAdapter.buildPlan(root)).buildCommand).toBe('pnpm run build');

    const unknownField = JSON.stringify({
      name: 'f',
      packageManager: 'poetry@1.8.0', // not a JS PM → ignored
      scripts: JSON.parse(PACKAGE_JSON).scripts,
    });
    const root2 = await makeRepo({ 'package.json': unknownField, 'yarn.lock': '' });
    expect((await nodeAdapter.buildPlan(root2)).testCommand).toBe('yarn run test');
  });

  it('missing script slot → null (dropped), remaining slots bound', async () => {
    const pkg = JSON.stringify({ name: 'fixture', scripts: { typecheck: 'tsc --noEmit' } });
    const root = await makeRepo({ 'package.json': pkg });
    const plan = await nodeAdapter.buildPlan(root);
    expect(plan.typecheckCommand).toBe('npm run typecheck');
    expect(plan.testCommand).toBeNull();
    expect(plan.buildCommand).toBeNull();
  });

  it('invalid package.json JSON → detected with all-null plan; overrides still rescue', async () => {
    const root = await makeRepo({ 'package.json': '{not json' });
    expect(await resolveAdapterForRoot(root)).toBe(nodeAdapter);
    const bare = await resolvePackCommandsForRoot({}, root);
    expect(bare).toEqual({ typecheckCommand: null, testCommand: null, buildCommand: null });
    const overridden = await resolvePackCommandsForRoot(
      { ZELARI_VERIFY_TEST_CMD: 'vitest run --silent' },
      root,
    );
    expect(overridden.testCommand).toBe('vitest run --silent');
  });
});

describe('rust + go adapters', () => {
  it('Cargo.toml → cargo check / test / build unconditionally', async () => {
    const root = await makeRepo({ 'Cargo.toml': '[package]\nname="x"\nversion="0.1.0"\n' });
    expect(await rustAdapter.buildPlan(root)).toEqual({
      typecheckCommand: 'cargo check',
      testCommand: 'cargo test',
      buildCommand: 'cargo build',
    });
  });

  it('go.mod → vet maps onto the typecheck slot; ./... patterns everywhere', async () => {
    const root = await makeRepo({ 'go.mod': 'module example.com/x\n\ngo 1.22\n' });
    expect(await goAdapter.buildPlan(root)).toEqual({
      typecheckCommand: 'go vet ./...',
      testCommand: 'go test ./...',
      buildCommand: 'go build ./...',
    });
  });
});

describe('python adapter — honest unknowns only', () => {
  it('pyproject.toml referencing pytest → pytest bound (f case)', async () => {
    const pyproject = ['[project]', 'name = "x"', 'version = "0.1.0"', '', '[dependency-groups]', 'dev = ["pytest>=8"]'].join('\n');
    const root = await makeRepo({ 'pyproject.toml': pyproject });
    expect(await resolveAdapterForRoot(root)).toBe(pythonAdapter);
    expect((await pythonAdapter.buildPlan(root)).testCommand).toBe('pytest');
    expect((await pythonAdapter.buildPlan(root)).buildCommand).toBeNull();
  });

  it('tests/ directory heuristic binds pytest even without config mention', async () => {
    const root = await makeRepo({ 'pyproject.toml': '[project]\nname="x"\nversion="0.1.0"\n' }, ['tests']);
    expect((await pythonAdapter.buildPlan(root)).testCommand).toBe('pytest');
  });

  it('no tool references → test/typecheck stay null (never fabricated)', async () => {
    const root = await makeRepo({ 'pyproject.toml': '[project]\nname="x"\nversion="0.1.0"\n' });
    const plan = await pythonAdapter.buildPlan(root);
    expect(plan.testCommand).toBeNull();
    expect(plan.typecheckCommand).toBeNull();
    expect(plan.buildCommand).toBeNull();
  });

  it('mypy referenced → mypy; dedicated configs count by existence; mypy wins over pyright', async () => {
    const token = await makeRepo({ 'pyproject.toml': '[project]\nname="x"\n[tool.mypy]\nstrict=true\n' });
    expect((await pythonAdapter.buildPlan(token)).typecheckCommand).toBe('mypy');

    const pyrightFile = await makeRepo({
      'pyproject.toml': '[project]\nname="x"\nversion="0.1.0"\n',
      'pyrightconfig.json': '{}',
    });
    expect((await pythonAdapter.buildPlan(pyrightFile)).typecheckCommand).toBe('pyright');

    const both = await makeRepo({
      'pyproject.toml': '[project]\nname="x"\n[tool.mypy]\n[tool.pyright]\n',
    });
    expect((await pythonAdapter.buildPlan(both)).typecheckCommand).toBe('mypy');
  });

  it('requirements.txt alone detects (weaker score than pyproject)', async () => {
    const req = await makeRepo({ 'requirements.txt': 'pytest\n' });
    expect(await resolveAdapterForRoot(req)).toBe(pythonAdapter);
    expect((await pythonAdapter.buildPlan(req)).testCommand).toBe('pytest');
  });
});

describe('env overrides stay supreme (h case)', () => {
  it('override replaces an adapter-bound command; trim + empty-disable preserved', async () => {
    const root = await makeRepo({ 'Cargo.toml': '[package]\nname="x"\nversion="0.1.0"\n' });
    const replaced = await resolvePackCommandsForRoot(
      { ZELARI_VERIFY_BUILD_CMD: 'cargo build --release' },
      root,
    );
    expect(replaced.buildCommand).toBe('cargo build --release'); // not 'cargo build'
    expect(replaced.testCommand).toBe('cargo test'); // untouched slot keeps binding

    const disabled = await resolvePackCommandsForRoot(
      { ZELARI_VERIFY_TEST_CMD: '  ', ZELARI_VERIFY_TYPECHECK_CMD: '  tsc -p custom  ' },
      root,
    );
    expect(disabled.testCommand).toBeNull(); // whitespace-only override disables
    expect(disabled.typecheckCommand).toBe('tsc -p custom'); // trimmed
  });

  it('override binds a slot the adapter could NOT bind (drop ≠ permanent blocker)', async () => {
    // Python repo never produces a build command — the env can still supply one.
    const root = await makeRepo({ 'pyproject.toml': '[project]\nname="x"\nversion="0.1.0"\n' });
    const plan = await resolvePackCommandsForRoot({ ZELARI_VERIFY_BUILD_CMD: 'python -m build' }, root);
    expect(plan.buildCommand).toBe('python -m build');
  });
});

describe('evaluateNativePack × adapter registry (wiring is live)', () => {
  it('executes the ADAPTER-produced commands through the engine (no overrides needed)', async () => {
    const root = await makeRepo({
      'go.mod': 'module example.com/x\n\ngo 1.22\n',
      'main.go': 'package main\n',
    });
    const seen: string[] = [];
    const shell: ShellProvider = {
      async exec(command: string): Promise<ShellResult> {
        seen.push(command);
        return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
      },
    };
    const pack = await evaluateNativePack({ env: { ZELARI_VERIFY_PACK: '1' }, cwd: root, shell });
    expect(pack).not.toBeNull();
    expect(seen.sort()).toEqual(['go build ./...', 'go test ./...', 'go vet ./...']);
    expect(pack!.results.filter((r) => r.status === 'pass').length).toBeGreaterThanOrEqual(3);
  });

  it('a failing adapter command still forces fail through the SAME policy path', async () => {
    const root = await makeRepo({
      'Cargo.toml': '[package]\nname="x"\nversion="0.1.0"\n',
      'src/main.rs': 'fn main() {}\n',
    });
    const shell: ShellProvider = {
      async exec(command: string): Promise<ShellResult> {
        return {
          exitCode: command.startsWith('cargo check') ? 101 : 0,
          stdout: '',
          stderr: 'error[E0425]',
          durationMs: 1,
          timedOut: false,
        };
      },
    };
    const pack = await evaluateNativePack({ env: { ZELARI_VERIFY_PACK: '1' }, cwd: root, shell });
    const failed = pack!.results.find((r) => r.status === 'fail');
    expect(failed?.criterionId).toBe('correctness.error-signals'); // typecheck slot = cargo check
  });
});
