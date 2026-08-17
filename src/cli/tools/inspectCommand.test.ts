import { mkdtemp, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
import {
  createInspectCommandTool,
  buildInspectCommand,
  resolveNodeModuleBin,
  runSpawn,
  type InspectOperation,
} from './inspectCommand.js';
import {
  scanTsbuildinfo,
  diffFingerprints,
  cleanupArtifacts,
  classifyTypecheckRefusal,
} from './inspectTypecheckSafety.js';
import { createBuiltinToolRegistry } from '../toolRegistry.js';
import { AuditLogger } from '../safety/auditLogger.js';
import { defaultPermissionPolicy } from '../safety/toolPermissions.js';

/**
 * WS3 — inspect_command (piano §3/§7/§9, t3).
 *
 * S3.4: pure argv-builder table, registry gating, spawn semantics.
 * S3.5: typecheck artifact safety fixtures — plain, incremental-with-explicit-
 * in-workspace tsBuildInfoFile (the CLI redirect must win), and composite
 * (the real packages/core shape). Common assertion: the workspace stays
 * byte-for-byte unchanged (zero new *.tsbuildinfo).
 */

// This file lives at <repo>/src/cli/tools/… — do NOT use path.resolve() (cwd
// is packages/core under `npm test --workspace=@zelari/core`, which is what
// the publish workflow runs).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tscPath = resolveNodeModuleBin(repoRoot, path.join('typescript', 'bin', 'tsc'))
  ?? path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const fixtures: string[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

async function newFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zelari-inspect-'));
  fixtures.push(dir);
  return dir;
}

function build(op: InspectOperation, root = repoRoot) {
  return buildInspectCommand(op, { root, cwd: root, tscPath });
}

function buildOk(op: InspectOperation, root = repoRoot) {
  const r = build(op, root);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r;
}

describe('resolveNodeModuleBin — hoisted monorepo walk-up', () => {
  it('finds root-hoisted typescript from a nested package dir', () => {
    const nested = path.join(repoRoot, 'packages', 'core');
    const fromNested = resolveNodeModuleBin(nested, path.join('typescript', 'bin', 'tsc'));
    const fromRoot = resolveNodeModuleBin(repoRoot, path.join('typescript', 'bin', 'tsc'));
    expect(fromNested).toBe(fromRoot);
    expect(fromNested).toBeTruthy();
  });

  it('returns undefined when nothing is found', () => {
    expect(resolveNodeModuleBin(tmpdir(), path.join('definitely-not-a-pkg', 'bin', 'x'))).toBeUndefined();
  });
});

describe('buildInspectCommand — pure argv builder', () => {
  it('git_status plain and --short', () => {
    expect(build({ operation: 'git_status' })).toMatchObject({
      ok: true,
      command: 'git',
      argv: ['status'],
      inspectionClass: 'git-inspection',
    });
    expect(buildOk({ operation: 'git_status', short: true }).argv).toEqual(['status', '--short']);
  });

  it('git_log maps limit/oneline to safe flags only', () => {
    const r = build({ operation: 'git_log', limit: 10, oneline: true });
    if (!r.ok) throw new Error('expected ok');
    expect(r.command).toBe('git');
    expect(r.argv).toEqual(['log', '--oneline', '-n', '10']);
  });

  it('git_diff forces --no-ext-diff --no-textconv (cannot be disabled by input)', () => {
    const r = build({ operation: 'git_diff' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.argv.slice(0, 3)).toEqual(['diff', '--no-ext-diff', '--no-textconv']);
    const staged = build({ operation: 'git_diff', staged: true, path: 'src/a.ts' });
    if (!staged.ok) throw new Error('expected ok');
    expect(staged.argv).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--staged', '--', 'src/a.ts']);
  });

  it('rejects flag-like free strings (git_diff path, git_show ref, npm_view package)', () => {
    expect(build({ operation: 'git_diff', path: '--evil' })).toMatchObject({ ok: false });
    expect(build({ operation: 'git_show', ref: '-x' })).toMatchObject({ ok: false });
    expect(build({ operation: 'npm_view', package: '--json' })).toMatchObject({ ok: false });
  });

  it('git_show carries safety flags; branch_current/ls_files are fixed argv', () => {
    expect(buildOk({ operation: 'git_show', ref: 'HEAD~2' }).argv).toEqual([
      'show',
      '--no-ext-diff',
      '--no-textconv',
      'HEAD~2',
    ]);
    expect(buildOk({ operation: 'git_branch_current' }).argv).toEqual(['branch', '--show-current']);
    expect(buildOk({ operation: 'git_ls_files' }).argv).toEqual(['ls-files']);
  });

  it('node_version and npm_* run via node (no .cmd shim, no shell)', () => {
    const nv = build({ operation: 'node_version' });
    if (!nv.ok) throw new Error('expected ok');
    expect(nv.command).toBe(process.execPath);
    expect(nv.inspectionClass).toBe('env-info');
    const ls = build({ operation: 'npm_ls' });
    if (!ls.ok) throw new Error('expected ok');
    expect(ls.command).toBe(process.execPath);
    expect(ls.argv[0].endsWith('npm-cli.js')).toBe(true);
    expect(ls.argv[1]).toBe('ls');
    const view = build({ operation: 'npm_view', package: 'typescript' });
    if (!view.ok) throw new Error('expected ok');
    expect(view.argv.slice(1)).toEqual(['view', 'typescript']);
  });

  it('typecheck: --noEmit + temp-dir tsBuildInfoFile redirect + resolved project', () => {
    const r = build({ operation: 'typecheck' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.inspectionClass).toBe('project-code-execution');
    expect(r.argv[0]).toBe(tscPath);
    expect(r.argv).toContain('--noEmit');
    expect(r.argv).toContain('--incremental');
    const i = r.argv.indexOf('--tsBuildInfoFile');
    expect(i).toBeGreaterThan(-1);
    expect(r.argv[i + 1]).toContain(path.join('zelari-inspect'));
    expect(r.argv[i + 1].endsWith('.tsbuildinfo')).toBe(true);
    expect(r.argv[r.argv.length - 1].endsWith('tsconfig.json')).toBe(true);
  });

  it('typecheck: different projects hash to different redirect targets', () => {
    const a = build({ operation: 'typecheck', project: 'tsconfig.json' });
    const b = build({ operation: 'typecheck', project: 'packages/core/tsconfig.json' });
    if (!a.ok || !b.ok) throw new Error('expected ok');
    const ai = a.argv.indexOf('--tsBuildInfoFile');
    const bi = b.argv.indexOf('--tsBuildInfoFile');
    expect(a.argv[ai + 1]).not.toBe(b.argv[bi + 1]);
  });
});

describe('runSpawn — no-shell semantics', () => {
  it('kills the process on timeout and reports it', async () => {
    const r = await runSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: repoRoot,
      timeoutMs: 250,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });

  it('spawn error (missing binary) resolves with spawnError, never rejects', async () => {
    const r = await runSpawn('definitely-not-a-real-binary-xyz', [], {
      cwd: repoRoot,
      timeoutMs: 1000,
    });
    expect(r.spawnError).toBeTruthy();
  });
});

describe('S3.5 artifact-safety guard units', () => {
  it('diffFingerprints detects new tsbuildinfo files and git changes', () => {
    const pre = { gitStatus: '', tsbuildinfoFiles: ['a.tsbuildinfo'] };
    const post = { gitStatus: ' M x.ts', tsbuildinfoFiles: ['a.tsbuildinfo', 'b.tsbuildinfo'] };
    const d = diffFingerprints(pre, post);
    expect(d.newTsbuildinfo).toEqual(['b.tsbuildinfo']);
    expect(d.gitStatusChanged).toBe(true);
    expect(diffFingerprints(pre, pre)).toEqual({ newTsbuildinfo: [], gitStatusChanged: false });
  });

  it('cleanupArtifacts removes what it can and reports failures', async () => {
    const dir = await newFixture();
    const keep = path.join(dir, 'real.tsbuildinfo');
    await writeFile(keep, 'x');
    const { cleaned, failed } = await cleanupArtifacts(dir, ['real.tsbuildinfo', 'ghost.tsbuildinfo']);
    expect(cleaned).toEqual(['real.tsbuildinfo']);
    expect(failed).toEqual(['ghost.tsbuildinfo']);
  });

  it('classifyTypecheckRefusal: composite refusal is loud, type errors are not', () => {
    expect(classifyTypecheckRefusal('error TS6379: Composite projects may not disable incremental emit.')).toMatch(
      /composite/i,
    );
    expect(classifyTypecheckRefusal('index.ts(1,1): error TS2322: Type \'string\' is not assignable')).toBeNull();
  });

  it('scanTsbuildinfo skips node_modules and finds nested files', async () => {
    const dir = await newFixture();
    await mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'node_modules', 'x', 'junk.tsbuildinfo'), 'x');
    await writeFile(path.join(dir, 'sub', 'real.tsbuildinfo'), 'x');
    expect(await scanTsbuildinfo(dir)).toEqual(['sub/real.tsbuildinfo']);
  });
});

describe('S3.5 typecheck fixtures — the workspace must stay untouched', () => {
  async function writeProject(dir: string, tsconfig: string): Promise<void> {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'main.ts'), 'export const answer: number = 42;\n');
    await writeFile(path.join(dir, 'tsconfig.json'), tsconfig);
  }

  async function runTypecheck(dir: string): Promise<Record<string, unknown>> {
    const tool = createInspectCommandTool({ root: dir, tscPath });
    const res = await tool.execute({ operation: 'typecheck' }, { cwd: dir } as never);
    if (!res.ok) throw new Error(`typecheck failed hard: ${res.error}`);
    return res.value as Record<string, unknown>;
  }

  it('(a) plain tsconfig: status ok, zero artifacts, tmp redirect used', async () => {
    const dir = await newFixture();
    await writeProject(dir, JSON.stringify({ compilerOptions: { strict: true } }));
    const v = await runTypecheck(dir);
    expect(v['status']).toBe('ok');
    expect(v['exitCode']).toBe(0);
    expect(v['inspectionClass']).toBe('project-code-execution');
    expect(await scanTsbuildinfo(dir)).toEqual([]);
  });

  it('(b) incremental + tsBuildInfoFile explicitly in the workspace: the CLI redirect WINS', async () => {
    const dir = await newFixture();
    await writeProject(
      dir,
      JSON.stringify({
        compilerOptions: { incremental: true, tsBuildInfoFile: './in-workspace.tsbuildinfo' },
      }),
    );
    const v = await runTypecheck(dir);
    expect(v['status']).toBe('ok');
    expect(v['exitCode']).toBe(0);
    // The in-workspace target must NOT exist; only the tmp redirect was used.
    const entries = await readdir(dir);
    expect(entries).not.toContain('in-workspace.tsbuildinfo');
    expect(await scanTsbuildinfo(dir)).toEqual([]);
  });

  it('(c) composite: true (the real packages/core shape): workspace unchanged', async () => {
    const dir = await newFixture();
    await writeProject(
      dir,
      JSON.stringify({ compilerOptions: { composite: true, rootDir: 'src', outDir: 'dist' } }),
    );
    const v = await runTypecheck(dir);
    expect(v['status']).toBe('ok');
    expect(v['exitCode']).toBe(0);
    expect(await scanTsbuildinfo(dir)).toEqual([]);
    const entries = await readdir(dir);
    expect(entries).not.toContain('tsconfig.tsbuildinfo');
    expect(entries).not.toContain('dist');
  });

  it('typecheck reports real type errors as a successful observation (exit != 0, status ok)', async () => {
    const dir = await newFixture();
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'bad.ts'), 'export const x: number = "not a number";\n');
    await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    const v = await runTypecheck(dir);
    // The RUN succeeded (a scoped observation); the compiler verdict is the exit code.
    expect(v['status']).toBe('ok');
    expect(v['exitCode']).toBe(2);
    expect(String(v['output'])).toContain('TS2322');
    expect(await scanTsbuildinfo(dir)).toEqual([]);
  });

  it('TYPESCRIPT_UNAVAILABLE when tsc is missing (loud, no fake empty)', async () => {
    const dir = await newFixture();
    await writeProject(dir, JSON.stringify({ compilerOptions: {} }));
    const tool = createInspectCommandTool({ root: dir, tscPath: path.join(dir, 'nope', 'tsc') });
    const res = await tool.execute({ operation: 'typecheck' }, { cwd: dir } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('TYPESCRIPT_UNAVAILABLE');
  });
});

describe('registry gating (S3.2)', () => {
  it('readOnly registry registers inspect_command INSTEAD of bash', () => {
    const dir = repoRoot;
    const { tools } = createBuiltinToolRegistry({
      root: dir,
      readOnly: true,
      lspProvider: null,
      audit: new AuditLogger(path.join(tmpdir(), `zelari-inspect-audit-${Date.now()}.log`)),
      permissionPolicy: defaultPermissionPolicy({ auto: true }),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain('inspect_command');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('write_file');
  });

  it('planMode registry gets inspect_command too', () => {
    const { tools } = createBuiltinToolRegistry({
      root: repoRoot,
      planMode: true,
      lspProvider: null,
      audit: new AuditLogger(path.join(tmpdir(), `zelari-inspect-audit-${Date.now()}.log`)),
      permissionPolicy: defaultPermissionPolicy({ auto: true }),
    });
    expect(tools.map((t) => t.name)).toContain('inspect_command');
  });

  it('full registry keeps bash and does NOT register inspect_command', () => {
    const { tools } = createBuiltinToolRegistry({
      root: repoRoot,
      lspProvider: null,
      audit: new AuditLogger(path.join(tmpdir(), `zelari-inspect-audit-${Date.now()}.log`)),
      permissionPolicy: defaultPermissionPolicy({ auto: true }),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain('bash');
    expect(names).not.toContain('inspect_command');
  });

  it('kill-switch ZELARI_INSPECT_COMMAND=0 removes it', () => {
    const prev = process.env.ZELARI_INSPECT_COMMAND;
    process.env.ZELARI_INSPECT_COMMAND = '0';
    try {
      const { tools } = createBuiltinToolRegistry({
        root: repoRoot,
        readOnly: true,
        lspProvider: null,
        audit: new AuditLogger(path.join(tmpdir(), `zelari-inspect-audit-${Date.now()}.log`)),
        permissionPolicy: defaultPermissionPolicy({ auto: true }),
      });
      expect(tools.map((t) => t.name)).not.toContain('inspect_command');
    } finally {
      if (prev === undefined) delete process.env.ZELARI_INSPECT_COMMAND;
      else process.env.ZELARI_INSPECT_COMMAND = prev;
    }
  });
});
