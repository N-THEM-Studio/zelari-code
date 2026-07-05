import { describe, it, expect } from 'vitest';
import { classifyMission, buildMissionBrief } from '@zelari/core/council';

describe('classifyMission', () => {
  it('classifies Italian greenfield prompts', () => {
    expect(classifyMission({ userMessage: 'costruisci un gestionale per BnB' })).toBe(
      'greenfield',
    );
    expect(classifyMission({ userMessage: 'crea una vetrina e-commerce da zero' })).toBe(
      'greenfield',
    );
  });

  it('classifies fix prompts', () => {
    expect(classifyMission({ userMessage: 'correggi il bug nel login' })).toBe('fix');
    expect(classifyMission({ userMessage: 'fix the failing tests' })).toBe('fix');
  });

  it('classifies redesign prompts', () => {
    expect(classifyMission({ userMessage: 'ridisegna la UI della dashboard' })).toBe(
      'redesign',
    );
  });

  it('classifies extend when a plan exists and prompt continues it', () => {
    expect(
      classifyMission({ userMessage: 'estendi il piano con una fase di sicurezza', hasPlan: true }),
    ).toBe('extend');
  });

  it('defaults to greenfield with no plan, extend with a plan', () => {
    expect(classifyMission({ userMessage: 'qualcosa di generico' })).toBe('greenfield');
    expect(classifyMission({ userMessage: 'qualcosa di generico', hasPlan: true })).toBe(
      'extend',
    );
  });
});

describe('buildMissionBrief', () => {
  it('produces a greenfield brief that chains design → implementation', () => {
    const brief = buildMissionBrief({
      userMessage: 'costruisci un gestionale BnB in React con Stripe',
    });
    expect(brief.intent).toBe('greenfield');
    expect(brief.runModeHint).toBe('design-phase');
    expect(brief.phases.map((p) => p.mode)).toEqual(['design-phase', 'implementation']);
    expect(brief.stackInferred).toEqual(expect.arrayContaining(['react', 'stripe']));
    expect(brief.assumptions.some((a) => /payment/i.test(a))).toBe(true);
  });

  it('caps the MVP slice at the requested task budget', () => {
    const brief = buildMissionBrief({ userMessage: 'crea una landing', maxSliceTasks: 5 });
    expect(brief.sliceMvp.id).toBe('slice-mvp');
    expect(brief.sliceMvp.maxTasks).toBe(5);
    expect(brief.slices).toHaveLength(1);
  });

  it('a fix on an existing plan stays single-phase implementation', () => {
    const brief = buildMissionBrief({
      userMessage: 'correggi il bug di sessione',
      hasPlan: true,
    });
    expect(brief.intent).toBe('fix');
    expect(brief.phases).toEqual([{ name: 'implementation', mode: 'implementation' }]);
  });

  it('preserves the original prompt', () => {
    const msg = 'sviluppa un nuovo progetto';
    expect(buildMissionBrief({ userMessage: msg }).userPromptOriginal).toBe(msg);
  });
});
