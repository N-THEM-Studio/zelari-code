/**
 * verificationAdapters/dotnet tests — P1.A2 (t24): depth-1 solution/project
 * detection scores, case-insensitive extension matching, and the
 * unconditional dotnet verb plan (typecheck honest-null).
 *
 * Fixtures are real tmpdir trees (win32-safe: path.join, no bash-isms).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dotnetAdapter, resolveAdapterForRoot } from './index.js';

let roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

async function makeRepo(files: Record<string, string> = {}, dirs: string[] = []): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'zelari-dotnet-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, name), content, 'utf-8');
  }
  for (const dir of dirs) await mkdir(path.join(root, dir), { recursive: true });
  return root;
}

describe('dotnet adapter — detect scoring (depth-1 scan)', () => {
  it.each([
    ['App.sln', 4],
    ['App.slnx', 4],
    ['App.csproj', 3],
    ['App.fsproj', 3],
  ])('%s → %s', async (marker, score) => {
    expect(await dotnetAdapter.detect(await makeRepo({ [marker]: '' }))).toBe(score);
  });

  it('solution outranks bare project when both present', async () => {
    const root = await makeRepo({ 'App.sln': '', 'App.csproj': '' });
    expect(await dotnetAdapter.detect(root)).toBe(4);
  });

  it('extension match is case-insensitive (win32-authored trees)', async () => {
    expect(await dotnetAdapter.detect(await makeRepo({ 'APP.SLN': '' }))).toBe(4);
    expect(await dotnetAdapter.detect(await makeRepo({ 'App.CSPROJ': '' }))).toBe(3);
  });

  it('empty dir / foreign markers / nested-only projects → 0 (depth-1 honesty)', async () => {
    expect(await dotnetAdapter.detect(await makeRepo())).toBe(0);
    expect(await dotnetAdapter.detect(await makeRepo({ 'go.mod': 'module x\n' }))).toBe(0);
    const nested = await makeRepo({}, ['src']);
    await writeFile(path.join(nested, 'src', 'App.csproj'), '', 'utf-8');
    expect(await dotnetAdapter.detect(nested)).toBe(0);
  });

  it('unreadable root → 0, never a throw (filesystem race stays not-applicable)', async () => {
    const missing = path.join(await makeRepo(), 'does-not-exist');
    expect(await dotnetAdapter.detect(missing)).toBe(0);
  });
});

describe('dotnet adapter — buildPlan', () => {
  it('sln root → registry resolves dotnet; test/build bind, typecheck stays null', async () => {
    const root = await makeRepo({ 'App.sln': '' });
    expect(await resolveAdapterForRoot(root)).toBe(dotnetAdapter);
    expect(await dotnetAdapter.buildPlan(root)).toEqual({
      typecheckCommand: null, // compilation IS the check — honest absence
      testCommand: 'dotnet test',
      buildCommand: 'dotnet build',
    });
  });

  it('project-only root → same unconditional verbs (dotnet targets the cwd project)', async () => {
    const root = await makeRepo({ 'App.fsproj': '' });
    expect(await dotnetAdapter.buildPlan(root)).toEqual({
      typecheckCommand: null,
      testCommand: 'dotnet test',
      buildCommand: 'dotnet build',
    });
  });
});
