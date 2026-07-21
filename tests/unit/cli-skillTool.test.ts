import { describe, it, expect } from 'vitest';
import {
  createSkillTool,
  formatAvailableSkillsCatalog,
} from '../../src/cli/tools/skillTool.js';
import { registerCodingSkill } from '@zelari/core/skills';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

const ctx: ToolContext = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  audit: () => {},
  sessionId: 'test',
};

describe('skill tool', () => {
  it('formatAvailableSkillsCatalog is non-empty after builtins', () => {
    // Builtins register at import; catalog may already have entries.
    registerCodingSkill({
      id: 'test-lazy-skill',
      name: 'Test Lazy Skill',
      description: 'A skill for unit tests only',
      version: '1.0.0',
      category: 'docs',
      requires: [],
      examples: [{ input: 'x', output: 'y' }],
      triggers: ['test'],
      antiPatterns: [],
      requiredRoles: [],
      estimatedCost: 'low',
      outputSchema: 'string',
      relatedSkills: [],
      tags: ['test'],
      systemPromptFragment: '## Do the test skill thing carefully.',
      requiredTools: [],
      enabledByDefault: false,
      builtin: false,
    });
    const cat = formatAvailableSkillsCatalog();
    expect(cat).toMatch(/test-lazy-skill/);
  });

  it('loads skill body by name', async () => {
    const tool = createSkillTool();
    const res = await tool.execute({ name: 'test-lazy-skill' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.name).toBe('test-lazy-skill');
      expect(res.value.content).toMatch(/Do the test skill thing/);
    }
  });

  it('errors on unknown skill', async () => {
    const tool = createSkillTool();
    const res = await tool.execute({ name: 'no-such-skill-xyz' }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Unknown skill/);
  });
});
