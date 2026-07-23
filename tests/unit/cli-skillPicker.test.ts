import { describe, expect, it } from 'vitest';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';
import type { CodingSkillDefinition } from '@zelari/core/skills';

const fakeSkill = (id: string): CodingSkillDefinition =>
  ({
    id,
    name: id,
    description: `desc ${id}`,
    version: '1.0.0',
    category: 'maint',
    systemPromptFragment: `Body for ${id}`,
    requiredTools: [],
    enabledByDefault: true,
    builtin: true,
    requires: [],
    examples: [],
    triggers: [],
    antiPatterns: [],
    requiredRoles: [],
    estimatedCost: 'low',
    outputSchema: 'string',
    relatedSkills: [],
    tags: [],
  }) as CodingSkillDefinition;

describe('skill picker slash commands', () => {
  const skills = [fakeSkill('code-review'), fakeSkill('debug-issue')];

  it('/skill with no args opens skill_picker', () => {
    const r = handleSlashCommand('/skill', skills);
    expect(r.handled).toBe(true);
    expect(r.kind).toBe('skill_picker');
  });

  it('/skills opens skill_picker', () => {
    const r = handleSlashCommand('/skills', skills);
    expect(r.handled).toBe(true);
    expect(r.kind).toBe('skill_picker');
  });

  it('/skill <id> expands skill', () => {
    const r = handleSlashCommand('/skill code-review fix tests', skills);
    expect(r.kind).toBe('skill');
    expect(r.expandedSkill?.skillId).toBe('code-review');
    expect(r.expandedSkill?.prompt).toContain('Body for code-review');
    expect(r.expandedSkill?.prompt).toContain('fix tests');
  });
});
