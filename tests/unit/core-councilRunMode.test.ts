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

  // --- Italian language support (v1.0) ---

  it('detects Italian greenfield keywords → design-phase', () => {
    expect(
      resolveCouncilRunMode({ userMessage: 'costruisci un gestionale per BnB' }),
    ).toBe('design-phase');
    expect(
      resolveCouncilRunMode({ userMessage: 'crea una vetrina e-commerce da zero' }),
    ).toBe('design-phase');
    expect(
      resolveCouncilRunMode({ userMessage: 'sviluppa un nuovo progetto React' }),
    ).toBe('design-phase');
  });

  it('does NOT misclassify "sistema" (the noun) as implementation', () => {
    // "costruisci ... sistema gestionale" must stay design-phase — the bare
    // Italian noun "sistema" is intentionally not an implementation keyword.
    expect(
      resolveCouncilRunMode({ userMessage: 'costruisci un sistema gestionale' }),
    ).toBe('design-phase');
  });

  it('detects Italian fix verbs → implementation', () => {
    expect(
      resolveCouncilRunMode({ userMessage: 'correggi il bug nel login' }),
    ).toBe('implementation');
    expect(
      resolveCouncilRunMode({ userMessage: 'rifattorizza il modulo auth' }),
    ).toBe('implementation');
  });

  it('Italian implementation keywords win over design keywords', () => {
    expect(
      resolveCouncilRunMode({ userMessage: 'crea e implementa il modulo pagamenti' }),
    ).toBe('implementation');
  });

  it('continuing an Italian plan → design-phase', () => {
    expect(
      resolveCouncilRunMode({
        userMessage: 'estendi il piano con una fase di sicurezza',
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
