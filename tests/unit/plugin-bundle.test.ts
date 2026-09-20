/**
 * plugin-bundle.test.ts — WS6 plugin BUNDLE: manifest schema, loader, state.
 *
 * Fixtures are real temp directories (permissionGate.test.ts style): the
 * loader's whole job is to look at files on disk, so mocking `node:fs` would
 * test the mock instead of the loader.
 *
 * The SHIPPED example bundle (`examples/extensions/zelari-plugin-example`) is
 * asserted here too: it is the artifact the docs and the CLI hand to users, so
 * a regression in it must fail the suite rather than only a manual run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OBSERVER_HOOK_EVENTS } from '@zelari/core/harness';
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_HOOK_EVENTS,
  BUNDLE_MANIFEST_FILE,
  parseBundleManifest,
} from '../../src/cli/plugins/bundleManifest.js';
import { loadBundle, projectBundleContributions, readBundle } from '../../src/cli/plugins/bundleLoad.js';
import {
  emptyBundleState,
  isBundleEnabled,
  readBundleState,
  setBundleEnabled,
} from '../../src/cli/plugins/bundleState.js';

const EXAMPLE = path.join(process.cwd(), 'examples', 'extensions', 'zelari-plugin-example');

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'zelari-plugin-bundle-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Write `files` (relative path → content) under a fresh bundle dir. */
async function makeBundle(
  name: string,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

const SKILL_MD = [
  '---',
  'name: demo-skill',
  'description: A demo skill for the bundle tests.',
  'category: review',
  '---',
  '',
  'Do the demo thing, and say what you verified.',
  '',
].join('\n');

const HOOK_JSON = JSON.stringify({
  name: 'demo-observer',
  match: { tools: ['*'], events: ['PermissionRequest'] },
  command: 'node observer.mjs',
  timeoutMs: 5000,
});

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'demo-bundle',
    version: '1.2.3',
    skills: [{ id: 'demo-skill', path: 'skills/demo-skill/SKILL.md' }],
    hooks: [{ event: 'PermissionRequest', path: 'hooks/observer.json' }],
    mcp: [{ name: 'demo-server', command: 'node', args: ['server.mjs'] }],
    ...overrides,
  });
}

/** The `dev`/`user` files every fixture bundle needs to load cleanly. */
const BASE_FILES = {
  [BUNDLE_MANIFEST_FILE]: manifestJson(),
  'skills/demo-skill/SKILL.md': SKILL_MD,
  'hooks/observer.json': HOOK_JSON,
};

describe('bundleManifest — schema', () => {
  it('accepts a full manifest and STRIPS $comment at every level', () => {
    const res = parseBundleManifest(
      JSON.stringify({
        $comment: 'documentation, not config',
        formatVersion: 1,
        name: 'demo-bundle',
        version: '1.0.0',
        description: 'demo',
        skills: [{ $comment: 'inner', id: 'demo-skill', path: 'a/SKILL.md' }],
      }),
      '/b/zelari-plugin.json',
    );
    expect(res.errors).toEqual([]);
    expect(res.manifest?.name).toBe('demo-bundle');
    expect(Object.keys(res.manifest ?? {})).not.toContain('$comment');
    expect(Object.keys(res.manifest?.skills[0] ?? {})).not.toContain('$comment');
  });

  it('defaults formatVersion to 1 but rejects any other value', () => {
    const ok = parseBundleManifest(manifestJson(), '/b/m.json');
    expect(ok.manifest?.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
    const bad = parseBundleManifest(manifestJson({ formatVersion: 2 }), '/b/m.json');
    expect(bad.manifest).toBeUndefined();
    expect(bad.errors[0]).toContain("/b/m.json: invalid bundle manifest at 'formatVersion'");
  });

  it('names the FILE and the FIELD for an unknown key (a typo must fail closed)', () => {
    const res = parseBundleManifest(manifestJson({ hooks2: [] }), '/b/m.json');
    expect(res.manifest).toBeUndefined();
    expect(res.errors.join('\n')).toContain('/b/m.json: invalid bundle manifest');
    expect(res.errors.join('\n')).toContain('hooks2');
  });

  it('rejects a non-slug name and reports every problem, not only the first', () => {
    const res = parseBundleManifest(
      JSON.stringify({ name: 'Bad Name', version: '' }),
      '/b/m.json',
    );
    expect(res.manifest).toBeUndefined();
    expect(res.errors.length).toBeGreaterThanOrEqual(2);
    expect(res.errors.some((e) => e.includes("at 'name'"))).toBe(true);
    expect(res.errors.some((e) => e.includes("at 'version'"))).toBe(true);
  });

  it('rejects absolute paths and any path escaping the bundle root', () => {
    for (const bad of ['/etc/passwd', 'C:\\secrets.txt', '../../outside.md', 'a/../../b.md']) {
      const res = parseBundleManifest(
        manifestJson({ skills: [{ id: 'demo-skill', path: bad }] }),
        '/b/m.json',
      );
      expect(res.manifest, bad).toBeUndefined();
      expect(res.errors[0]).toContain("at 'skills.0.path'");
    }
  });

  it('requires EXACTLY one of preset | command for an mcp entry', () => {
    const neither = parseBundleManifest(
      manifestJson({ mcp: [{ name: 'x' }] }),
      '/b/m.json',
    );
    expect(neither.errors.join('\n')).toContain("at 'mcp.0.preset'");
    const both = parseBundleManifest(
      manifestJson({ mcp: [{ name: 'x', preset: 'cua', command: 'node' }] }),
      '/b/m.json',
    );
    expect(both.manifest).toBeUndefined();
  });

  it('rejects an unknown hook event and lists the valid ones', () => {
    const res = parseBundleManifest(
      manifestJson({ hooks: [{ event: 'PreToolUsed', path: 'h.json' }] }),
      '/b/m.json',
    );
    expect(res.manifest).toBeUndefined();
    expect(res.errors[0]).toContain("at 'hooks.0.event'");
    expect(res.errors[0]).toContain('PermissionRequest');
  });

  it('keeps the bundle event vocabulary in sync with core observer events', () => {
    // Gate events have no runtime export in @zelari/core/harness, but the
    // observer half does: a new observer event must not be silently unusable
    // in a bundle.
    for (const event of OBSERVER_HOOK_EVENTS) {
      expect(BUNDLE_HOOK_EVENTS).toContain(event);
    }
  });

  it('rejects duplicate skill ids / mcp names instead of picking one', () => {
    const res = parseBundleManifest(
      manifestJson({
        skills: [
          { id: 'demo-skill', path: 'a/SKILL.md' },
          { id: 'demo-skill', path: 'b/SKILL.md' },
        ],
      }),
      '/b/m.json',
    );
    expect(res.manifest).toBeUndefined();
    expect(res.errors[0]).toContain("duplicate skill id 'demo-skill'");
  });

  it('reports invalid JSON with the file name', () => {
    const res = parseBundleManifest('{ not json', '/b/m.json');
    expect(res.manifest).toBeUndefined();
    expect(res.errors[0]).toContain('/b/m.json: invalid JSON');
  });
});

describe('bundleLoad — validation on disk', () => {
  it('loads the SHIPPED example bundle: 1 skill, 1 observer hook, 1 stdio mcp', async () => {
    const res = await readBundle(EXAMPLE);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    const bundle = res.bundle;
    expect(bundle?.name).toBe('zelari-plugin-example');
    expect(bundle?.version).toBe('1.0.0');
    expect(bundle?.skills.map((s) => s.id)).toEqual(['repo-hygiene']);
    // The skill is parsed by the REAL loader parser, not re-implemented here.
    expect(bundle?.skills[0]?.skill.category).toBe('review');
    expect(bundle?.skills[0]?.skill.body).toContain('# Repo hygiene');
    expect(bundle?.hooks).toHaveLength(1);
    expect(bundle?.hooks[0]?.event).toBe('PermissionRequest');
    expect(bundle?.hooks[0]?.observer).toBe(true);
    // hooks[].config OVERRIDES the hook file (5000 in the file, 2000 in the manifest).
    expect(bundle?.hooks[0]?.definition.timeoutMs).toBe(2000);
    expect(bundle?.mcp.map((m) => m.name)).toEqual(['echo-example']);
    expect(bundle?.mcp[0]?.source).toBe('command');
    expect(bundle?.mcp[0]?.config).toMatchObject({ command: 'node', type: 'stdio' });
    expect(bundle?.agents).toEqual([]);
  });

  it('loads a valid temp bundle and marks a GATE-event hook as non-observer', async () => {
    const dir = await makeBundle('ok', {
      ...BASE_FILES,
      'hooks/observer.json': JSON.stringify({
        name: 'gate',
        match: { tools: ['bash'], events: ['PreToolUse'] },
        command: 'node gate.mjs',
      }),
      [BUNDLE_MANIFEST_FILE]: manifestJson({
        hooks: [{ event: 'PreToolUse', path: 'hooks/observer.json' }],
      }),
    });
    const res = await readBundle(dir);
    expect(res.errors).toEqual([]);
    expect(res.bundle?.hooks[0]?.observer).toBe(false);
  });

  it('refuses a hook that does not subscribe to the event the manifest declares', async () => {
    const dir = await makeBundle('mismatch', BASE_FILES); // manifest says PermissionRequest
    await writeFile(
      path.join(dir, 'hooks', 'observer.json'),
      JSON.stringify({ name: 'x', match: { tools: ['*'], events: ['PreToolUse'] }, command: 'node x.mjs' }),
      'utf8',
    );
    const res = await readBundle(dir);
    expect(res.bundle).toBeUndefined();
    expect(res.errors[0]).toContain("at 'hooks.0.path'");
    expect(res.errors[0]).toContain("does not subscribe to 'PermissionRequest'");
  });

  it('refuses a hook without a transport and one with both', async () => {
    for (const match of [
      { name: 'x', match: { tools: ['*'], events: ['PermissionRequest'] } },
      { name: 'x', match: { tools: ['*'], events: ['PermissionRequest'] }, command: 'a', url: 'http://b' },
    ]) {
      const dir = await makeBundle('hook', { ...BASE_FILES });
      await writeFile(path.join(dir, 'hooks', 'observer.json'), JSON.stringify(match), 'utf8');
      const res = await readBundle(dir);
      expect(res.bundle).toBeUndefined();
      expect(res.errors.join('\n')).toContain('exactly one of "command" or "url" is required');
    }
  });

  it('names the field when a declared file is missing or is not a valid SKILL.md', async () => {
    const dir = await makeBundle('missing');
    await mkdir(path.join(dir, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(path.join(dir, BUNDLE_MANIFEST_FILE), manifestJson(), 'utf8');
    const missing = await readBundle(dir);
    expect(missing.errors[0]).toContain("at 'skills.0.path'");
    expect(missing.errors[0]).toContain('file not found');

    await writeFile(path.join(dir, 'skills', 'demo-skill', 'SKILL.md'), 'no frontmatter', 'utf8');
    await mkdir(path.join(dir, 'hooks'), { recursive: true });
    await writeFile(path.join(dir, 'hooks', 'observer.json'), HOOK_JSON, 'utf8');
    const invalid = await readBundle(dir);
    expect(invalid.bundle).toBeUndefined();
    expect(invalid.errors[0]).toContain('is not a valid SKILL.md');
  });

  it('refuses a SKILL.md whose frontmatter name does not match the declared id', async () => {
    const dir = await makeBundle('idmismatch', {
      ...BASE_FILES,
      'skills/demo-skill/SKILL.md': SKILL_MD.replace('name: demo-skill', 'name: other-skill'),
    });
    const res = await readBundle(dir);
    expect(res.bundle).toBeUndefined();
    expect(res.errors[0]).toContain("at 'skills.0.id'");
    expect(res.errors[0]).toContain("does not match the SKILL.md name 'other-skill'");
  });

  it('reports a missing manifest with the path it looked for, and a non-dir root', async () => {
    const empty = path.join(root, 'empty');
    await mkdir(empty, { recursive: true });
    const noManifest = await readBundle(empty);
    expect(noManifest.errors[0]).toContain(BUNDLE_MANIFEST_FILE);
    expect(noManifest.errors[0]).toContain('bundle manifest not found');

    const notDir = await readBundle(path.join(root, 'nope'));
    expect(notDir.errors[0]).toContain('not a bundle directory');
  });

  it('resolves a preset through the REAL preset registry and rejects unknown ids', async () => {
    const good = await makeBundle('preset', {
      ...BASE_FILES,
      [BUNDLE_MANIFEST_FILE]: manifestJson({ mcp: [{ name: 'my-unreal', preset: 'unreal-mcp' }] }),
    });
    const res = await readBundle(good);
    expect(res.errors).toEqual([]);
    expect(res.bundle?.mcp[0]).toMatchObject({ name: 'my-unreal', source: 'preset', presetId: 'unreal-mcp' });
    expect(res.bundle?.mcp[0]?.config.command).toBeUndefined();
    expect((res.bundle?.mcp[0]?.notes ?? []).length).toBeGreaterThan(0);

    const bad = await makeBundle('badpreset', {
      ...BASE_FILES,
      [BUNDLE_MANIFEST_FILE]: manifestJson({ mcp: [{ name: 'x', preset: 'nope' }] }),
    });
    const badRes = await readBundle(bad);
    expect(badRes.bundle).toBeUndefined();
    expect(badRes.errors[0]).toContain("at 'mcp.0.preset'");
    expect(badRes.errors[0]).toContain('unreal-mcp');
  });

  it('validates agents, surfaces them, and warns that they are not executed', async () => {
    const dir = await makeBundle('agents', {
      ...BASE_FILES,
      'agents/auditor.md': '# Auditor\n\nReads the diff.\n',
      [BUNDLE_MANIFEST_FILE]: manifestJson({
        agents: [{ id: 'auditor', path: 'agents/auditor.md', description: 'reads the diff' }],
      }),
    });
    const res = await readBundle(dir);
    expect(res.errors).toEqual([]);
    expect(res.bundle?.agents).toEqual([
      { id: 'auditor', path: path.join(dir, 'agents', 'auditor.md'), description: 'reads the diff' },
    ]);
    expect(res.warnings.join('\n')).toContain('NOT executed');

    await writeFile(path.join(dir, 'agents', 'auditor.md'), '   \n', 'utf8');
    const empty = await readBundle(dir);
    expect(empty.bundle).toBeUndefined();
    expect(empty.errors[0]).toContain("at 'agents.0.path'");
  });

  it('fails closed: a bundle with ANY error yields ok:false and no contributions', async () => {
    const dir = await makeBundle('broken', {
      ...BASE_FILES,
      [BUNDLE_MANIFEST_FILE]: manifestJson({ skills: [{ id: 'demo-skill', path: 'gone.md' }] }),
    });
    const loaded = await loadBundle(dir, { enabled: true });
    expect(loaded.ok).toBe(false);
    expect(loaded.contributions).toBeUndefined();
  });
});

describe('bundleLoad — the PURE projection (bundle + enable state → contributions)', () => {
  it('contributes NOTHING while disabled and everything while enabled', async () => {
    const read = await readBundle(EXAMPLE);
    const bundle = read.bundle!;
    const off = projectBundleContributions(bundle, { enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.skills).toEqual([]);
    expect(off.hooks).toEqual([]);
    expect(off.mcp).toEqual([]);
    expect(off.bundle).toBe('zelari-plugin-example');

    const on = projectBundleContributions(bundle, { enabled: true });
    expect(on.enabled).toBe(true);
    expect(on.skills).toBe(bundle.skills);
    expect(on.hooks[0]?.observer).toBe(true);
    expect(on.mcp[0]?.name).toBe('echo-example');
  });

  it('loadBundle projects the same bundle for both states', async () => {
    const off = await loadBundle(EXAMPLE, { enabled: false });
    const on = await loadBundle(EXAMPLE, { enabled: true });
    expect([off.ok, on.ok]).toEqual([true, true]);
    expect(off.contributions?.skills).toEqual([]);
    expect(on.contributions?.skills).toHaveLength(1);
  });
});

describe('bundleState — .zelari/plugins.json is fail-closed', () => {
  it('is DISABLED by default: no file, and a bundle that is not listed', async () => {
    const read = await readBundleState(root);
    expect(read.errors).toEqual([]);
    expect(read.state).toEqual(emptyBundleState());
    expect(isBundleEnabled(read.state, 'demo-bundle')).toBe(false);
    expect(isBundleEnabled({ enabled: { other: true }, paths: [] }, 'demo-bundle')).toBe(false);
    expect(isBundleEnabled({ enabled: { 'demo-bundle': false }, paths: [] }, 'demo-bundle')).toBe(false);
  });

  it('persists enable → read → disable, registering the PARENT as scan root', async () => {
    const dir = path.join(root, 'examples', 'extensions', 'demo-bundle');
    await mkdir(dir, { recursive: true });
    const enabled = await setBundleEnabled({ projectRoot: root, name: 'demo-bundle', enabled: true, dir });
    expect(enabled.ok, enabled.ok ? '' : enabled.error).toBe(true);
    const onDisk = JSON.parse(await readFile(path.join(root, '.zelari', 'plugins.json'), 'utf8'));
    expect(onDisk).toEqual({
      enabled: { 'demo-bundle': true },
      paths: [path.join('examples', 'extensions')],
    });
    expect(isBundleEnabled((await readBundleState(root)).state, 'demo-bundle')).toBe(true);

    const off = await setBundleEnabled({ projectRoot: root, name: 'demo-bundle', enabled: false, dir });
    expect(off.ok).toBe(true);
    expect(isBundleEnabled((await readBundleState(root)).state, 'demo-bundle')).toBe(false);
    // Disabling must not forget where the bundle was: it stays visible.
    expect((await readBundleState(root)).state.paths).toHaveLength(1);
  });

  it('enables NOTHING when the state file is malformed, and refuses to overwrite it', async () => {
    const file = path.join(root, '.zelari', 'plugins.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ "enabled": { "demo-bundle": "yes" } }', 'utf8');
    const read = await readBundleState(root);
    expect(read.errors[0]).toContain('.zelari');
    expect(read.errors[0]).toContain('stays DISABLED');
    expect(isBundleEnabled(read.state, 'demo-bundle')).toBe(false);

    const write = await setBundleEnabled({ projectRoot: root, name: 'demo-bundle', enabled: true });
    expect(write.ok).toBe(false);
    // …and the user's file is untouched.
    expect(await readFile(file, 'utf8')).toContain('"yes"');
  });
});
