import { describe, expect, it } from 'vitest';
import {
  evaluateMissionContinuation,
  type MissionProgress,
} from './continuationPolicy.js';

function progress(partial: Partial<MissionProgress>): MissionProgress {
  return {
    criteriaTotal: 2,
    criteriaPassed: 1,
    ratio: 0.5,
    evidenceComplete: false,
    ...partial,
  };
}

describe('evaluateMissionContinuation — advisory contract (doc §6)', () => {
  it('required criteria incomplete → continue, no matter the verifier trend', () => {
    const advice = evaluateMissionContinuation({
      progress: progress({}),
      verifier: { tier: 'blended', value: 0.99, verdict: 'confirmed' },
    });
    expect(advice.recommendation).toBe('continue');
    expect(advice.blockers).toHaveLength(1);
    expect(advice.doneByScore).toBe(false);
    expect(advice.goalRewrite).toBe(false);
    expect(advice.rationale).toContain('never authority');
  });

  it('no criteria recorded yet → continue (never wind-down on ignorance)', () => {
    const advice = evaluateMissionContinuation({
      progress: progress({ criteriaTotal: 0, criteriaPassed: 0, ratio: null }),
    });
    expect(advice.recommendation).toBe('continue');
    expect(advice.blockers[0]).toContain('no verification criteria');
  });

  it('all pass but evidence incomplete → continue with evidence blocker', () => {
    const advice = evaluateMissionContinuation({
      progress: progress({ criteriaPassed: 2, ratio: 1, evidenceComplete: false }),
    });
    expect(advice.recommendation).toBe('continue');
    expect(advice.blockers.join(' ')).toContain('evidence is incomplete');
  });

  it('fully-evidenced PASS → wind-down (candidate done, final say elsewhere)', () => {
    const advice = evaluateMissionContinuation({
      progress: progress({ criteriaPassed: 2, ratio: 1, evidenceComplete: true }),
    });
    expect(advice.recommendation).toBe('wind-down');
    expect(advice.blockers).toHaveLength(0);
    expect(advice.rationale).toContain('final say: driver + CompletionPolicy');
    expect(advice.doneByScore).toBe(false);
  });

  it('verifier rejected on a PASSing mission → hold-for-user, verdict NOT rewritten', () => {
    const advice = evaluateMissionContinuation({
      progress: progress({ criteriaPassed: 2, ratio: 1, evidenceComplete: true }),
      verifier: { tier: 'deterministic', value: 1, verdict: 'rejected' },
    });
    expect(advice.recommendation).toBe('hold-for-user');
    expect(advice.rationale).toContain('deterministic verdict stands untouched');
  });

  it('user steer is sovereign — stop wins even mid-flight', () => {
    const advice = evaluateMissionContinuation({
      progress: progress({}),
      userSteer: 'stop',
    });
    expect(advice.recommendation).toBe('wind-down');
    expect(advice.rationale).toContain('user steer');
  });

  it('user steer continue overrides a rejected verifier signal', () => {
    const advice = evaluateMissionContinuation({
      progress: progress({ criteriaPassed: 2, ratio: 1, evidenceComplete: true }),
      verifier: { tier: 'deterministic', value: 1, verdict: 'rejected' },
      userSteer: 'continue',
    });
    expect(advice.recommendation).toBe('continue');
  });

  it('budget exhausted → hold-for-user (operator decides, never claims done)', () => {
    const advice = evaluateMissionContinuation({
      progress: progress({}),
      budget: { iterationsUsed: 6, iterationsMax: 6 },
    });
    expect(advice.recommendation).toBe('hold-for-user');
    expect(advice.rationale).toContain('budget exhausted');
    expect(advice.doneByScore).toBe(false);
  });

  it('blended trend below reject band on a complete mission → hold-for-user', () => {
    const advice = evaluateMissionContinuation({
      progress: progress({ criteriaPassed: 2, ratio: 1, evidenceComplete: true }),
      verifier: { tier: 'blended', value: 0.2 },
    });
    expect(advice.recommendation).toBe('hold-for-user');
  });

  it('trend recorded as context, never missing from the advice shape', () => {
    const withTrend = evaluateMissionContinuation({
      progress: progress({}),
      verifier: { tier: 'deterministic', value: 0.5 },
    });
    expect(withTrend.trend).toEqual({ tier: 'deterministic', value: 0.5 });
    const withoutTrend = evaluateMissionContinuation({ progress: progress({}) });
    expect(withoutTrend.trend).toBeUndefined();
  });
});
