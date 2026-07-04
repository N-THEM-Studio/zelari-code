import { describe, it, expect } from 'vitest';
import {
  resolveCouncilRunMode,
  councilTierFromSize,
} from '@zelari/core/council';

describe('resolveCouncilRunMode', () => {
  it('defaults to implementation for generic coding tasks', () => {
    expect(
      resolveCouncilRunMode({ userMessage: 'refactor the auth module' }),
    ).toBe('implementation');
  });

  it('detects design-phase from keywords', () => {
    expect(
      resolveCouncilRunMode({
        userMessage: 'Design the architecture for a luxury e-commerce app',
      }),
    ).toBe('design-phase');
  });

  it('implementation keywords win over design keywords', () => {
    expect(
      resolveCouncilRunMode({
        userMessage: 'Design and implement the payment module',
      }),
    ).toBe('implementation');
  });

  it('ZELARI_COUNCIL_MODE env overrides heuristics', () => {
    expect(
      resolveCouncilRunMode({
        userMessage: 'refactor auth',
        env: { ZELARI_COUNCIL_MODE: 'design' },
      }),
    ).toBe('design-phase');
    expect(
      resolveCouncilRunMode({
        userMessage: 'design my app',
        env: { ZELARI_COUNCIL_MODE: 'implementation' },
      }),
    ).toBe('implementation');
  });

  it('continuing an existing plan → design-phase', () => {
    expect(
      resolveCouncilRunMode({
        userMessage: 'extend the plan with a security phase',
        hasExistingPlan: true,
      }),
    ).toBe('design-phase');
  });
});

describe('councilTierFromSize', () => {
  it('maps size >= 6 to full', () => {
    expect(councilTierFromSize(6)).toBe('full');
    expect(councilTierFromSize(3)).toBe('lite');
  });
});
