/**
 * cli-createSkillTool.test.ts — `create_skill` built-in tool.
 *
 * The contract under test:
 *  - it writes <root>/<name>/SKILL.md in the EXACT format skillsMd.ts parses;
 *  - the new skill is IMMEDIATELY usable: the existing `skill` tool returns its
 *    body in the same process, with no restart and no second store;
 *  - scope=user lands in the global skills root (ZELARI_HOME-injected);
 *  - overwrite=false refuses, overwrite=true replaces;
 *  - an invalid slug never reaches the disk (zod gate + execute guard).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCodingSkillById, unregisterSkill } from '@zelari/core/skills';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { createCreateSkillTool } from '../../src/cli/tools/createSkillTool.js';
import { createSkillTool } from '../../src/cli/tools/skillTool.js';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';
import { parseSkillMd } from '../../src/cli/skillsMd.js';

const ctx: ToolContext = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  audit: () => {},
  sessionId: 'test',
};

let root: string;
let home: string;
let previousHome: string | undefined;
/** Skill names registered in the shared core catalog by this suite. */
const registered: string[] = [];

/** Give every test its own project root AND its own ZELARI_HOME (no real ~). */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'create-skill-root-'));
  home = mkdtempSync(join(tmpdir(), 'create-skill-home-'));
  previousHome = process.env.ZELARI_HOME;
  process.env.ZELARI_HOME = home;
});

afterEach(() => {
  for (const id of registered.splice(0)) {
    try {
      unregisterSkill(id);
    } catch {
      /* ignore */
    }
  }
  if (previousHome === undefined) delete process.env.ZELARI_HOME;
  else process.env.ZELARI_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.ZELARI_HOME;
});

/** Unique, valid slug per test (2-40 chars, lowercase alnum + hyphens). */
function slug(tag: string): string {
  const name = `tmp-${tag}-${Math.random().toString(36).slice(2, 8)}`;
  registered.push(name);
  return name;
}

describe('create_skill tool — project scope', () => {
  it('writes <root>/<name>/SKILL.md in the format parseSkillMd accepts', async () => {
    const name = slug('proj');
    const tool = createCreateSkillTool({ cwd: root });
    const res = await tool.execute(
      {
        name,
        description: 'Release checklist',
        instructions: '## Goal\n\nShip it.\n\n1. Run the tests\n2. Tag the release\n',
      },
      ctx,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const expected = join(root, '.zelari', 'skills', name, 'SKILL.md');
    expect(res.value.path).toBe(expected);
    expect(res.value.scope).toBe('project');
    expect(res.value.overwritten).toBe(false);
    expect(res.value.loadable).toBe(true);

    expect(existsSync(expected)).toBe(true);
    const content = readFileSync(expected, 'utf8');
    const parsed = parseSkillMd(content, expected);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe(name);
    expect(parsed?.description).toBe('Release checklist');
    expect(parsed?.body).toContain('1. Run the tests');
    // Frontmatter is the flat `key: value` subset the loader supports.
    expect(content.startsWith('---\nname: ')).toBe(true);
  });

  it('reports how to invoke the skill and where it was saved', async () => {
    const name = slug('msg');
    const tool = createCreateSkillTool({ cwd: root });
    const res = await tool.execute(
      { name, description: 'Procedura di rilascio', instructions: 'Fai la release.' },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.message).toContain(`"${name}"`);
    expect(res.value.message).toContain(`/skill ${name}`);
    expect(res.value.message).toContain(res.value.path);
    expect(res.value.message).toContain('project scope');
  });

  it('is IMMEDIATELY usable: the existing skill tool returns the new body', async () => {
    const name = slug('live');
    const body = '## Do the tmp live thing\n\nStep one.\nStep two.';
    const create = await createCreateSkillTool({ cwd: root }).execute(
      { name, description: 'Live usability check', instructions: body },
      ctx,
    );
    expect(create.ok).toBe(true);

    // Same process, no restart: the skill tool re-scans the roots on demand.
    const load = await createSkillTool({ cwd: root }).execute({ name }, ctx);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.value.name).toBe(name);
    expect(load.value.content).toContain('Step one.');
    expect(load.value.content).toContain('Step two.');
    expect(getCodingSkillById(name)?.systemPromptFragment).toContain('Do the tmp live thing');
  });
});

describe('create_skill tool — user scope', () => {
  it('writes to $ZELARI_HOME/skills/<name>/SKILL.md and is loadable', async () => {
    const name = slug('user');
    const tool = createCreateSkillTool({ cwd: root });
    const res = await tool.execute(
      {
        name,
        description: 'Global skill',
        instructions: 'Always do the global thing.',
        scope: 'user',
      },
      ctx,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const expected = join(home, 'skills', name, 'SKILL.md');
    expect(res.value.scope).toBe('user');
    expect(res.value.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    // Nothing leaked into the project root.
    expect(existsSync(join(root, '.zelari', 'skills', name))).toBe(false);

    const load = await createSkillTool({ cwd: root }).execute({ name }, ctx);
    expect(load.ok).toBe(true);
    if (load.ok) expect(load.value.content).toContain('Always do the global thing.');
  });
});

describe('create_skill tool — overwrite semantics', () => {
  it('refuses an existing name with overwrite=false, then replaces it with true', async () => {
    const name = slug('ow');
    const tool = createCreateSkillTool({ cwd: root });
    const first = await tool.execute(
      { name, description: 'v1', instructions: 'Body v1' },
      ctx,
    );
    expect(first.ok).toBe(true);

    const second = await tool.execute(
      { name, description: 'v2', instructions: 'Body v2' },
      ctx,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already exists/i);
    // The refusal must not touch the existing file.
    if (second.ok === false) {
      const path = join(root, '.zelari', 'skills', name, 'SKILL.md');
      expect(readFileSync(path, 'utf8')).toContain('Body v1');
    }

    const third = await tool.execute(
      { name, description: 'v2', instructions: 'Body v2', overwrite: true },
      ctx,
    );
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.overwritten).toBe(true);
    const content = readFileSync(third.value.path, 'utf8');
    expect(content).toContain('Body v2');
    expect(content).not.toContain('Body v1');
  });
});

describe('create_skill tool — input validation', () => {
  it('rejects invalid slugs at the zod gate', () => {
    const schema = createCreateSkillTool({ cwd: root }).inputSchema;
    const base = { description: 'd', instructions: 'i' };
    for (const bad of ['', 'a', 'UPPER-CASE', 'with space', '../escape', 'a/b', 'trailing.', '-leading', 'under_score', 'x'.repeat(41)]) {
      expect(schema.safeParse({ ...base, name: bad }).success).toBe(false);
    }
    expect(schema.safeParse({ ...base, name: 'release-checklist' }).success).toBe(true);
    // Description/instructions are required non-empty strings.
    expect(schema.safeParse({ name: 'ok-name', description: '', instructions: 'i' }).success).toBe(false);
    expect(schema.safeParse({ name: 'ok-name', description: 'd', instructions: '' }).success).toBe(false);
    // scope is a closed enum.
    expect(schema.safeParse({ ...base, name: 'ok-name', scope: 'global' }).success).toBe(false);
  });

  it('never writes on a bad name, even when execute() is called directly', async () => {
    const tool = createCreateSkillTool({ cwd: root });
    const res = await tool.execute(
      { name: '../escape', description: 'd', instructions: 'i' },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Invalid skill name/);
    expect(existsSync(join(root, '.zelari', 'skills', '..', 'escape'))).toBe(false);
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  it('requires description and instructions', async () => {
    const tool = createCreateSkillTool({ cwd: root });
    const noDesc = await tool.execute({ name: slug('nodesc'), description: '', instructions: 'x' }, ctx);
    expect(noDesc.ok).toBe(false);
    if (!noDesc.ok) expect(noDesc.error).toMatch(/description is required/);
    const noBody = await tool.execute({ name: slug('nobody'), description: 'd', instructions: '  ' }, ctx);
    expect(noBody.ok).toBe(false);
    if (!noBody.ok) expect(noBody.error).toMatch(/instructions is required/);
  });
});

describe('create_skill — registry wiring', () => {
  it('is registered in the full registry and invocable end-to-end', async () => {
    const { registry } = createBuiltinToolRegistry({
      root,
      lspProvider: null,
      diagnostics: false,
      permissionPolicy: {
        read: 'allow',
        write: 'allow',
        execute: 'allow',
        network: 'allow',
        ui: 'allow',
        auto: true,
      },
    });
    expect(registry.get('create_skill')).toBeDefined();

    const name = slug('reg');
    const res = await registry.invoke<{ path: string; loadable: boolean }>('create_skill', {
      name,
      description: 'Registered skill',
      instructions: 'Body via the registry.',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.loadable).toBe(true);
    expect(existsSync(join(root, '.zelari', 'skills', name, 'SKILL.md'))).toBe(true);

    // Same gating as the `skill` tool: no write surface in a read-only registry.
    const ro = createBuiltinToolRegistry({ root, readOnly: true, lspProvider: null });
    expect(ro.registry.get('create_skill')).toBeUndefined();
    expect(ro.registry.get('skill')).toBeUndefined();
  });

  it('the tool definition advertises the slug contract to the model', () => {
    const tool = createCreateSkillTool({ cwd: root });
    expect(tool.name).toBe('create_skill');
    expect(tool.description.length).toBeGreaterThan(50);
    expect(tool.description).toMatch(/skill/i);
    expect(tool.permissions).toContain('write');
    expect(tool.timeoutMs).toBeGreaterThan(0);
  });
});
