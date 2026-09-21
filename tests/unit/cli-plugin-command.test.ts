/**
 * cli-plugin-command.test.ts — WS6 `zelari-code plugin validate|list|enable|disable`.
 *
 * The exit code IS the contract here, so every test drives the real entry point
 * (`runPluginCommand`) on real temp projects and asserts the returned code plus
 * what reached stdout/stderr — no internal function is stubbed.
 *
 * The end-to-end cycle (list → enable → list → disable → list) runs on a tmp
 * PROJECT so the repo's own `.zelari/plugins.json` is never touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultBundleRoots,
  discoverBundles,
  parsePluginFlags,
  pluginHelpText,
  runPluginCommand,
} from '../../src/cli/plugins/bundleCommand.js';
import { readBundleState } from '../../src/cli/plugins/bundleState.js';
import { BUNDLE_MANIFEST_FILE } from '../../src/cli/plugins/bundleManifest.js';

// Repo root resolved from THIS file, never from process.cwd(): on CI the suite
// runs via `npm test --workspace=@zelari/core` (cwd = packages/core), and the
// shipped example bundle lives at the repo root.
const EXAMPLE = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'examples',
  'extensions',
  'zelari-plugin-example',
);
const EXAMPLE_NAME = 'zelari-plugin-example';

let project = '';

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'zelari-plugin-cli-'));
  const dest = path.join(project, 'examples', 'extensions', EXAMPLE_NAME);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(EXAMPLE, dest, { recursive: true });
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Collect stdout/stderr for the duration of one call. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  try {
    const code = await runPluginCommand(argv);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
}

describe('plugin command — flags and help', () => {
  it('reads --cwd and --help, and ignores a value-less flag (acp parity)', () => {
    expect(parsePluginFlags(['plugin', 'validate', '--cwd', '/work'])).toEqual({ cwd: '/work' });
    expect(parsePluginFlags(['plugin', '--help'])).toEqual({ help: true });
    expect(parsePluginFlags(['plugin', '-h'])).toEqual({ help: true });
    expect(parsePluginFlags(['plugin', '--cwd'])).toEqual({});
  });

  it('help names the subcommand and every subcommand', () => {
    const help = pluginHelpText();
    expect(help).toContain('zelari-code plugin');
    for (const sub of ['validate', 'list', 'enable', 'disable']) expect(help).toContain(sub);
    expect(help).toContain('--cwd');
  });

  it('--help exits 0; a missing or unknown subcommand exits 1', async () => {
    const help = await run(['plugin', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('zelari-code plugin');

    const none = await run(['plugin']);
    expect(none.code).toBe(1);
    expect(none.out).toContain('zelari-code plugin');

    const unknown = await run(['plugin', 'install']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown subcommand 'install'");
  });
});

describe('plugin validate', () => {
  it('exits 1 with a usage line when no directory is given', async () => {
    const res = await run(['plugin', 'validate']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('usage: zelari-code plugin validate <dir>');
  });

  it('exits 0 on the shipped example bundle and reports what it found', async () => {
    const res = await run(['plugin', 'validate', EXAMPLE, '--cwd', project]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('OK: valid bundle');
    expect(res.out).toContain(`${EXAMPLE_NAME} v1.0.0`);
    expect(res.out).toContain('skills:   1 (repo-hygiene)');
    expect(res.out).toContain('hooks:    1 (PermissionRequest, observer)');
    expect(res.out).toContain('mcp:      1 (echo-example, command)');
    // Fail-closed default: a bundle nobody enabled says so.
    expect(res.out).toContain('state:    disabled');
    expect(res.err).toBe('');
  });

  it('exits 1 and names file + field for a broken bundle', async () => {
    const broken = path.join(project, 'broken-bundle');
    await mkdir(broken, { recursive: true });
    await writeFile(
      path.join(broken, BUNDLE_MANIFEST_FILE),
      JSON.stringify({
        name: 'broken-bundle',
        version: '1.0.0',
        skills: [{ id: 'nope', path: 'skills/nope/SKILL.md' }],
      }),
      'utf8',
    );
    const res = await run(['plugin', 'validate', broken]);
    expect(res.code).toBe(1);
    expect(res.err).toContain('FAILED: 1 problem(s)');
    expect(res.err).toContain("at 'skills.0.path'");
    expect(res.err).toContain('file not found');
    expect(res.out).not.toContain('OK: valid bundle');
  });
});

describe('plugin list — discovery', () => {
  it('finds bundles under examples/extensions and reports the fail-closed default', async () => {
    const emptyProject = await mkdtemp(path.join(tmpdir(), 'zelari-plugin-cli-empty-'));
    try {
      const res = await run(['plugin', 'list', '--cwd', emptyProject]);
      expect(res.code).toBe(0);
      expect(res.out).toContain('no bundles found');
    } finally {
      await rm(emptyProject, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('skips a directory without a manifest but still reports a BROKEN bundle', async () => {
    // Regression: descending into a bundle's own hooks/skills subdirectories
    // (or another kind of example, e.g. examples/extensions/echo-tool) must not
    // produce phantom INVALID rows.
    const root = path.join(project, 'examples', 'extensions');
    await mkdir(path.join(root, 'not-a-bundle', 'nested'), { recursive: true });
    await mkdir(path.join(root, EXAMPLE_NAME, 'hooks'), { recursive: true }); // already exists
    const brokenDir = path.join(root, 'broken');
    await mkdir(brokenDir, { recursive: true });
    await writeFile(path.join(brokenDir, BUNDLE_MANIFEST_FILE), '{"name":"Bad Name"}', 'utf8');

    const found = await discoverBundles(defaultBundleRoots(project, { enabled: {}, paths: [] }));
    const names = found.map((b) => b.name);
    expect(names).toContain(EXAMPLE_NAME);
    expect(names).toContain('broken');
    expect(names).not.toContain('not-a-bundle');
    expect(names).not.toContain('nested');
    expect(names).not.toContain('hooks');
    expect(found.find((b) => b.name === 'broken')?.ok).toBe(false);
  });
});

describe('plugin enable / disable — the full cycle on a tmp project', () => {
  it('list(disabled) → enable → list(enabled) → disable → list(disabled)', async () => {
    const before = await run(['plugin', 'list', '--cwd', project]);
    expect(before.code).toBe(0);
    expect(before.out).toContain(`disabled valid   ${EXAMPLE_NAME}`);

    const enabled = await run([
      'plugin',
      'enable',
      '--cwd',
      project,
      `examples/extensions/${EXAMPLE_NAME}`,
    ]);
    expect(enabled.code).toBe(0);
    expect(enabled.out).toContain(`enabled ${EXAMPLE_NAME}`);

    // Persisted where the contract says: <projectRoot>/.zelari/plugins.json
    const file = path.join(project, '.zelari', 'plugins.json');
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    expect(onDisk.enabled[EXAMPLE_NAME]).toBe(true);
    // The PARENT is registered as a scan root, never the bundle itself.
    expect(onDisk.paths).toEqual([path.join('examples', 'extensions')]);

    const after = await run(['plugin', 'list', '--cwd', project]);
    expect(after.out).toContain(`enabled  valid   ${EXAMPLE_NAME}`);
    const state = await readBundleState(project);
    expect(state.errors).toEqual([]);

    const disabled = await run([
      'plugin',
      'disable',
      '--cwd',
      project,
      `examples/extensions/${EXAMPLE_NAME}`,
    ]);
    expect(disabled.code).toBe(0);
    expect(disabled.out).toContain(`disabled ${EXAMPLE_NAME}`);
    expect(
      JSON.parse(await readFile(file, 'utf8')).enabled[EXAMPLE_NAME],
    ).toBe(false);

    const end = await run(['plugin', 'list', '--cwd', project]);
    expect(end.out).toContain(`disabled valid   ${EXAMPLE_NAME}`);
  });

  it('also accepts a bundle NAME discovered in the configured roots', async () => {
    const res = await run(['plugin', 'enable', '--cwd', project, EXAMPLE_NAME]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`enabled ${EXAMPLE_NAME}`);
  });

  it('REFUSES to enable a bundle whose files are broken, but still allows disable', async () => {
    const dir = path.join(project, 'examples', 'extensions', 'half-broken');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, BUNDLE_MANIFEST_FILE),
      JSON.stringify({
        name: 'half-broken',
        version: '1.0.0',
        skills: [{ id: 'gone', path: 'skills/gone/SKILL.md' }],
      }),
      'utf8',
    );
    const on = await run(['plugin', 'enable', '--cwd', project, dir]);
    expect(on.code).toBe(1);
    expect(on.err).toContain('refusing to enable');
    expect(on.err).toContain('file not found');

    // Nothing was written for it…
    const state = await readBundleState(project);
    expect(state.state.enabled['half-broken']).toBeUndefined();

    // …while switching it off is always possible (fail-safe direction).
    const off = await run(['plugin', 'disable', '--cwd', project, dir]);
    expect(off.code).toBe(0);
    expect((await readBundleState(project)).state.enabled['half-broken']).toBe(false);
  });

  it('unknown target and missing directory are reported, exit 1', async () => {
    const unknown = await run(['plugin', 'enable', '--cwd', project, 'ghost-bundle']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no bundle named 'ghost-bundle'");

    const missing = await run(['plugin', 'disable', '--cwd', project, 'no/such/dir']);
    expect(missing.code).toBe(1);
  });
});
