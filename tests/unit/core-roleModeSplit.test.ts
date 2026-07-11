/**
 * Mode-split role prompts: design mandatories only in design-phase.
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_ROLES,
  getAgent,
  resolveRoleSystemPrompt,
} from '@zelari/core/council';

describe('resolveRoleSystemPrompt mode-split', () => {
  it('Nettuno design addendum includes createPlan only in design-phase', () => {
    const nettun = getAgent('nettun')!;
    const design = resolveRoleSystemPrompt(nettun, 'design-phase');
    const impl = resolveRoleSystemPrompt(nettun, 'implementation');
    expect(design).toMatch(/createPlan/);
    expect(design).toMatch(/Design-phase/);
    expect(impl).not.toMatch(/createPlan/);
    expect(impl.length).toBeLessThan(design.length);
  });

  it('Gerione design docs only in design-phase', () => {
    const g = getAgent('geryon')!;
    expect(resolveRoleSystemPrompt(g, 'design-phase')).toMatch(
      /customer-journey-map/,
    );
    expect(resolveRoleSystemPrompt(g, 'implementation')).not.toMatch(
      /customer-journey-map/,
    );
  });

  it('Lucifero implementation addendum only in implementation', () => {
    const L = getAgent('lucifer')!;
    expect(resolveRoleSystemPrompt(L, 'implementation')).toMatch(
      /sole implementer/i,
    );
    expect(resolveRoleSystemPrompt(L, 'design-phase')).toMatch(/synthesis/);
    expect(resolveRoleSystemPrompt(L, 'design-phase')).not.toMatch(
      /sole implementer/i,
    );
  });

  it('every role has a base systemPrompt shorter than the old mega-prompts', () => {
    for (const r of AGENT_ROLES) {
      // Base prompts should stay lean; design bloat is addendum-only.
      expect(r.systemPrompt.length).toBeLessThan(3500);
    }
    const nettun = getAgent('nettun')!;
    // Full design prompt still has createPlan but base alone should not.
    expect(nettun.systemPrompt).not.toMatch(/createPlan\(/);
    expect(nettun.designPhaseAddendum).toMatch(/createPlan/);
  });
});
