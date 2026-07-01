/**
 * promoteMember — cross-schema API tests.
 * Validates AgentRole → CodingSkillDefinition mapping + markdown rendering.
 */

import { describe, it, expect } from 'vitest';
import {
  promoteMember,
  buildSkillDefinition,
  renderSkillMarkdown,
  slugify,
  stripClarificationProtocol,
} from '@zelari/core/council';
import { UnknownMemberError, AGENT_ROLES } from '@zelari/core/council';

describe('promoteMember', () => {
  it('valid member produces a complete skill definition', () => {
    const { skill, markdown } = promoteMember('geryon');
    expect(skill.id).toBe('geryon');
    expect(skill.name).toBe('Gerione');
    expect(skill.version).toBe('1.0.0');
    expect(skill.estimatedCost).toBe('medium');
    expect(skill.enabledByDefault).toBe(true);
    expect(skill.builtin).toBe(false);
    expect(markdown).toContain('---');
    expect(markdown).toContain('id: geryon');
  });

  it('slugifies the id when underscore or uppercase present', () => {
    expect(slugify('Sisyphus_X')).toBe('sisyphus-x');
    expect(slugify('Some Agent')).toBe('some-agent');
    expect(slugify('  Trim Me  ')).toBe('trim-me');
  });

  it('strips the CLARIFICATION_PROTOCOL block from systemPrompt', () => {
    const stripped = stripClarificationProtocol('Methodology line.\n\nWHEN TO ASK THE USER\nRules.');
    expect(stripped).not.toContain('WHEN TO ASK THE USER');
    expect(stripped).toBe('Methodology line.');
    // When the protocol is absent, the input is returned unchanged
    const noop = stripClarificationProtocol('No protocol here.');
    expect(noop).toBe('No protocol here.');
  });

  it('systemPromptFragment excludes the CLARIFICATION_PROTOCOL', () => {
    const { skill } = promoteMember('charont');
    expect(skill.systemPromptFragment).not.toContain('WHEN TO ASK THE USER');
    expect(skill.systemPromptFragment.length).toBeGreaterThan(50);
  });

  it('tags include codename, role, category slug, promoted marker', () => {
    const { skill } = promoteMember('minos');
    expect(skill.tags).toContain('codename:critic');
    expect(skill.tags).toContain('role:minos');
    expect(skill.tags).toContain('promoted');
    expect(skill.tags).toContain('council-member');
    expect(skill.tags.some((t) => t.startsWith('category:'))).toBe(true);
  });

  it('requiredRoles is the promoted member id (circular)', () => {
    const { skill } = promoteMember('pluton');
    expect(skill.requiredRoles).toEqual(['pluton']);
  });

  it('requiredTools mirrors AgentRole.tools exactly', () => {
    const { skill } = promoteMember('lucifer');
    expect(skill.requiredTools).toEqual([
      'createTask',
      'addIdea',
      'createPhase',
      'buildMindMap',
      'addNode',
      'linkNodes',
      'createDocument',
    ]);
  });

  it('relatedSkills mirrors AgentRole.skills (handles undefined)', () => {
    const { skill } = promoteMember('nettun');
    expect(skill.relatedSkills).toEqual(['project-planner', 'vault-manager']);
    // minos has skills defined; geryon has skills defined; all 6 members
    // have skills in roles.ts today, but the code path covers undefined too
  });

  it('builtin: false distinguishes promoted skills from built-ins', () => {
    const { skill } = promoteMember('charont');
    expect(skill.builtin).toBe(false);
  });

  it('unknown member throws UnknownMemberError with diagnostic list', () => {
    expect(() => promoteMember('zaphod')).toThrowError(UnknownMemberError);
    try {
      promoteMember('zaphod');
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownMemberError);
      const err = e as UnknownMemberError;
      expect(err.unknownId).toBe('zaphod');
      expect(err.availableIds).toContain('charont');
      expect(err.availableIds.length).toBe(6);
    }
  });

  it('renderSkillMarkdown produces valid YAML frontmatter + structured body', () => {
    const { skill } = promoteMember('geryon');
    const md = renderSkillMarkdown(
      AGENT_ROLES.find((r) => r.id === 'geryon')!,
      skill,
    );
    expect(md).toMatch(/^---\n/);
    expect(md).toMatch(/\n---\n/);
    expect(md).toContain('id: geryon');
    expect(md).toContain('version: 1.0.0');
    expect(md).toContain('# Gerione');
    expect(md).toContain('## Methodology');
    expect(md).toContain('## Triggers');
    expect(md).toContain('## Anti-patterns');
    expect(md).toContain('## Example');
    expect(md).toContain('## Output');
  });
});

describe('promoteMember options', () => {
  it('accepts overrides for version, cost, enabledByDefault, description, triggers, antiPatterns', () => {
    const { skill } = promoteMember('minos', {
      version: '2.5.1',
      estimatedCost: 'high',
      enabledByDefault: false,
      description: 'Custom critic description',
      triggers: ['Custom trigger'],
      antiPatterns: ['Custom anti-pattern'],
    });
    expect(skill.version).toBe('2.5.1');
    expect(skill.estimatedCost).toBe('high');
    expect(skill.enabledByDefault).toBe(false);
    expect(skill.description).toBe('Custom critic description');
    expect(skill.triggers).toEqual(['Custom trigger']);
    expect(skill.antiPatterns).toEqual(['Custom anti-pattern']);
  });

  it('uses CodingCategory union type (defaults to planning)', () => {
    const { skill } = promoteMember('charont'); // role: "Council Director"
    expect(['planning', 'review', 'refactor', 'debug', 'test', 'docs', 'ops', 'git', 'db', 'maint'])
      .toContain(skill.category);
    const { skill: criticSkill } = promoteMember('minos'); // role: "Quality Critic"
    expect(criticSkill.category).toBe('review');
  });
});

describe('buildSkillDefinition + renderSkillMarkdown (exported for testability)', () => {
  it('buildSkillDefinition can be called directly with a known agent', () => {
    const agent = AGENT_ROLES.find((r) => r.id === 'pluton')!;
    const skill = buildSkillDefinition(agent, {});
    expect(skill.id).toBe('pluton');
    expect(skill.requiredRoles).toEqual(['pluton']);
  });

  it('renderSkillMarkdown contains a valid JSON example block', () => {
    const agent = AGENT_ROLES.find((r) => r.id === 'nettun')!;
    const skill = buildSkillDefinition(agent, {});
    const md = renderSkillMarkdown(agent, skill);
    expect(md).toContain('```json');
    expect(md).toContain('"framing"');
    expect(md).toContain('"delegation"');
  });
});