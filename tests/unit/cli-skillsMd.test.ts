/**
 * cli-skillsMd.test.ts — v0.7.5 SKILL.md loader coverage.
 *
 * The loader accepts the SKILL.md format shared by opencode, Hermes Agent,
 * and Claude Code: YAML frontmatter (name, description) + markdown body.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillMd, toCodingSkillDefinition, loadSkillMdSkills } from '../../src/cli/skillsMd.js';
import { getCodingSkillById, unregisterSkill } from '@zelari/core/skills';

const VALID = `---
name: deploy-checklist
description: Pre-deploy verification checklist for web apps.
category: ops
tools: [read_file, bash]
cost: low
---

# Deploy checklist

1. Run the test suite.
2. Check the changelog.
`;

describe('parseSkillMd', () => {
  it('parses frontmatter fields and body', () => {
    const parsed = parseSkillMd(VALID, 'x/SKILL.md')!;
    expect(parsed).not.toBeNull();
    expect(parsed.name).toBe('deploy-checklist');
    expect(parsed.description).toContain('Pre-deploy');
    expect(parsed.category).toBe('ops');
    expect(parsed.requiredTools).toEqual(['read_file', 'bash']);
    expect(parsed.estimatedCost).toBe('low');
    expect(parsed.body).toContain('# Deploy checklist');
  });

  it('returns null without frontmatter or without name/description', () => {
    expect(parseSkillMd('# just markdown', 'x')).toBeNull();
    expect(parseSkillMd('---\nname: only-name\n---\nbody', 'x')).toBeNull();
  });

  it('rejects names that violate the opencode constraint', () => {
    const bad = VALID.replace('deploy-checklist', 'Deploy Checklist!');
    expect(parseSkillMd(bad, 'x')).toBeNull();
  });

  it('defaults category to maint and cost to medium when absent/invalid', () => {
    const minimal = '---\nname: mini\ndescription: d\ncategory: nonsense\n---\nbody text';
    const parsed = parseSkillMd(minimal, 'x')!;
    expect(parsed.category).toBe('maint');
    expect(parsed.estimatedCost).toBe('medium');
  });
});

describe('toCodingSkillDefinition', () => {
  it('produces a valid strict definition with defaults filled', () => {
    const def = toCodingSkillDefinition(parseSkillMd(VALID, 'x/SKILL.md')!);
    expect(def.id).toBe('deploy-checklist');
    expect(def.systemPromptFragment).toContain('Deploy checklist');
    expect(def.builtin).toBe(false);
    expect(def.tags).toContain('skill-md');
    expect(def.requires).toEqual([]);
  });
});

describe('loadSkillMdSkills', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skillsmd-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    // Clean the global catalog of anything the test registered.
    for (const id of ['tmp-skill-a', 'tmp-skill-claude']) unregisterSkillSafe(id);
  });

  const writeSkill = (root: string, name: string): void => {
    const d = join(dir, root, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill ${name}\n---\nDo the ${name} thing.`);
  };

  it('loads from .zelari/skills and compat dirs, registering into the catalog', () => {
    writeSkill('.zelari/skills', 'tmp-skill-a');
    writeSkill('.claude/skills', 'tmp-skill-claude');
    const summary = loadSkillMdSkills(dir);
    expect(summary.loaded).toContain('tmp-skill-a');
    expect(summary.loaded).toContain('tmp-skill-claude');
    expect(getCodingSkillById('tmp-skill-a')?.systemPromptFragment).toContain('tmp-skill-a thing');
  });

  it('does not shadow already-registered ids and reports skips', () => {
    writeSkill('.zelari/skills', 'tmp-skill-a');
    writeSkill('.claude/skills', 'tmp-skill-a'); // same name, later dir
    const summary = loadSkillMdSkills(dir);
    expect(summary.loaded.filter((n) => n === 'tmp-skill-a')).toHaveLength(1);
    expect(summary.skipped.some((s) => s.reason.includes('already registered'))).toBe(true);
  });

  it('skips invalid SKILL.md files without throwing', () => {
    const d = join(dir, '.zelari', 'skills', 'broken');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), 'no frontmatter at all');
    const summary = loadSkillMdSkills(dir);
    expect(summary.loaded).toHaveLength(0);
    expect(summary.skipped).toHaveLength(1);
  });
});

function unregisterSkillSafe(id: string): void {
  try {
    unregisterSkill(id);
  } catch {
    // not registered — fine
  }
}
