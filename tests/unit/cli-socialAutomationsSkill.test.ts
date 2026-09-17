/**
 * cli-socialAutomationsSkill.test.ts — the builtin `social-automations` skill
 * is registered in the catalog, wired into the module list, and its fragment
 * pins the automations CLI contract (commands, guardrails, frequency mapping).
 *
 * Imports point at the SOURCE modules (not the dist subpath) so the test and
 * the registration share one module instance without a core rebuild.
 */
import { describe, expect, it } from 'vitest';
import '../../packages/core/src/agents/skills/builtin/socialAutomations.js';
import { getCodingSkillById } from '../../packages/core/src/agents/skills.js';
import { BUILTIN_SKILL_MODULES } from '../../src/cli/skillConfigIo.js';

describe('builtin skill: social-automations', () => {
  it('is registered in the shared catalog as an ops builtin', () => {
    const skill = getCodingSkillById('social-automations');
    expect(skill).toBeDefined();
    expect(skill?.builtin).toBe(true);
    expect(skill?.category).toBe('ops');
    expect(skill?.enabledByDefault).toBe(true);
  });

  it('pins the automations CLI contract in its fragment', () => {
    const body = getCodingSkillById('social-automations')?.systemPromptFragment ?? '';
    expect(body).toContain('automation upsert');
    expect(body).toContain('automation register');
    expect(body).toContain('set-enabled');
    expect(body).toContain('requireApproval');
    expect(body).toContain('0 9,18 * * *');
    expect(body).toContain('researchQuery');
    expect(body).toContain('relogin_required');
  });

  it('is wired into BUILTIN_SKILL_MODULES (the export list that loads builtins)', () => {
    expect(BUILTIN_SKILL_MODULES).toContain('@zelari/core/skills/builtin/social-automations');
  });
});
