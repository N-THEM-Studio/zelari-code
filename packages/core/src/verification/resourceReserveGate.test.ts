/**
 * Combined 2.6 core tests: resource reserve gate (§26.4), budget continuation
 * (§26.5), task contract (§26.8), resource.snapshot surface projection (§26.3).
 */

import { describe, expect, it } from 'vitest';
import { computeBudget, budgetPressure } from '../runtime/resourceBudget.js';
import { defaultResourcePolicy } from '../runtime/resourcePolicy.js';
import { evaluateResourceReserveGate } from './resourceReserveGate.js';
import { evaluateCompletion, STRICT_ALL_POLICY } from './completionPolicy.js';
import { evaluateBudgetContinuation } from '../mission/budgetContinuation.js';
import { applyTaskContractUpdate, deriveInitialContract, TaskContractConflictError, type TaskContract } from '../session/taskContract.js';
import { deriveMessages, LATEST_ONLY_SURFACE_KINDS, MODEL_SURFACE_KINDS } from '../session/modelSurface.js';
import { SESSION_EVENT_KINDS, type SessionEventEnvelope } from '../session/types.js';
import { validateResourceAndContractEvents } from '../session/invariants.js';

const POLICY = defaultResourcePolicy('kraken/v1');

function evalWith(status: 'pass' | 'fail' | 'unknown') {
  const criteria = [{ id: 'c1', description: 'd', required: true }];
  const results = [
    {
      criterionId: 'c1',
      status,
      evidence: status === 'pass' ? [{ tier: 'tool-output' as const, description: 'ok' }] : [],
    },
  ];
  return evaluateCompletion(criteria, results, STRICT_ALL_POLICY);
}

describe('resource reserve gate (§11.5)', () => {
  it('deterministic PASS stays PASS even with residual budget', () => {
    const gate = evaluateResourceReserveGate({
      evaluation: evalWith('pass'),
      budget: computeBudget(POLICY, { toolCallsUsed: 5 }),
    });
    expect(gate.verdict).toBe('PASS');
  });

  it('non-PASS with budget left keeps the deterministic verdict', () => {
    const gate = evaluateResourceReserveGate({
      evaluation: evalWith('fail'),
      budget: computeBudget(POLICY, { toolCallsUsed: 20 }),
    });
    expect(gate.verdict).toBe('REPAIR_REQUIRED');
    expect(gate.resourceExhausted).toBe(false);
  });

  it('exhausted budget → BLOCKED resource-exhausted, never a false done', () => {
    const gate = evaluateResourceReserveGate({
      evaluation: evalWith('unknown'),
      budget: computeBudget(POLICY, { toolCallsUsed: 40 }),
    });
    expect(gate.verdict).toBe('BLOCKED');
    expect(gate.resourceExhausted).toBe(true);
    expect(gate.deterministicVerdict).toBe('BLOCKED');
    expect(gate.summary).toContain('resource-exhausted');
  });
});

describe('budget continuation (§13.3)', () => {
  const ample = computeBudget(POLICY, { toolCallsUsed: 10 }, 'implement');
  const critical = computeBudget(POLICY, { toolCallsUsed: 38 }, 'verify');

  it('PASS → complete; never spends residual budget', () => {
    expect(evaluateBudgetContinuation({ verdict: 'PASS', budget: ample, pressure: 'ample', repairHistory: [] }).decision).toBe('complete');
  });

  it('GAP + ample → repair', () => {
    const advice = evaluateBudgetContinuation({ verdict: 'REPAIR_REQUIRED', budget: ample, pressure: 'ample', latestGapKey: 'g1', repairHistory: [] });
    expect(advice.decision).toBe('repair');
  });

  it('same gap repeated 3× → pivot while headroom exists', () => {
    const history = [
      { gapKey: 'g1', outcome: 'unchanged' as const },
      { gapKey: 'g1', outcome: 'unchanged' as const },
      { gapKey: 'g1', outcome: 'unchanged' as const },
    ];
    const advice = evaluateBudgetContinuation({ verdict: 'REPAIR_REQUIRED', budget: ample, pressure: 'normal', latestGapKey: 'g1', repairHistory: history });
    expect(advice.decision).toBe('pivot');
  });

  it('structural GAP + critical → hold', () => {
    const advice = evaluateBudgetContinuation({ verdict: 'REPAIR_REQUIRED', budget: critical, pressure: 'critical', latestGapKey: 'g1', repairHistory: [] });
    expect(advice.decision).toBe('hold');
  });

  it('never converts non-PASS into complete (locked contract)', () => {
    const advice = evaluateBudgetContinuation({ verdict: 'BLOCKED', budget: ample, pressure: 'normal', repairHistory: [] });
    expect(advice.passByBudget).toBe(false);
    expect(advice.decision).not.toBe('complete');
  });
});

describe('task contract (§14)', () => {
  const base: TaskContract = {
    version: 1,
    goal: 'fix auth refresh',
    constraints: [{ id: 'uc-1', text: 'do not touch password validation', source: 'user', required: true }],
    acceptanceCriteria: [{ id: 'ac-1', text: 'npm test -- auth passes', source: 'user', required: true }],
    source: { userSeq: 2 },
  };

  it('derives an initial contract from user prose', () => {
    const c = deriveInitialContract(2, 'Fix the login bug\n- do not change the API\n- verify: npm test');
    expect(c.goal).toBe('Fix the login bug');
    expect(c.constraints).toHaveLength(1);
    expect(c.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
    expect(c.version).toBe(1);
  });

  it('2.6.1 parser fix: unmarked prose NEVER becomes criteria (plan §3)', () => {
    const c = deriveInitialContract(
      1,
      'Fix login.\nDo not change password semantics.\nKeep Node 24 compatibility.',
    );
    expect(c.goal).toBe('Fix login.');
    expect(c.constraints.map((x) => x.text)).toEqual([
      'Do not change password semantics.',
      'Keep Node 24 compatibility.',
    ]);
    expect(c.acceptanceCriteria).toEqual([]);
  });

  it('explicit markers produce criteria (checkbox + keyword lead-ins)', () => {
    const c = deriveInitialContract(
      1,
      'Ship the fix\n- [ ] tests pass\n- [x] docs updated\nAcceptance: login works\nCriterion: no regression\nVerify: npm test\nTest: vitest run\nSuccess: user can log in',
    );
    expect(c.acceptanceCriteria.map((x) => x.text)).toEqual([
      'tests pass',
      'docs updated',
      'login works',
      'no regression',
      'npm test',
      'vitest run',
      'user can log in',
    ]);
    const verify = c.acceptanceCriteria.find((x) => x.text === 'npm test')!;
    expect(verify.verificationHint).toEqual({ kind: 'command', value: 'npm test' });
    // Criteria lines are not double-counted as constraints or goal.
    expect(c.constraints).toEqual([]);
    expect(c.goal).toBe('Ship the fix');
  });

  it('keyword without separator stays prose (no false criteria)', () => {
    const c = deriveInitialContract(1, 'Test the login flow manually');
    expect(c.acceptanceCriteria).toEqual([]);
    expect(c.goal).toBe('Test the login flow manually');
  });

  it('user wins: required user items survive agent updates', () => {
    expect(() =>
      applyTaskContractUpdate(base, { removeConstraintIds: ['uc-1'] }),
    ).toThrow(TaskContractConflictError);
    expect(() => applyTaskContractUpdate(base, { removeCriterionIds: ['ac-1'] })).toThrow(TaskContractConflictError);
  });

  it('agent cannot rewrite the goal; user steer can', () => {
    expect(() => applyTaskContractUpdate(base, { goal: 'new goal' })).toThrow(TaskContractConflictError);
    const updated = applyTaskContractUpdate(base, { goal: 'new goal', nextUserSeq: 9 });
    expect(updated.goal).toBe('new goal');
    expect(updated.version).toBe(2);
    expect(updated.source.userSeq).toBe(9);
  });

  it('logs derived additions and keeps versions monotone', () => {
    const updated = applyTaskContractUpdate(base, {
      addCriteria: [{ id: 'ac-2', text: 'typecheck passes', source: 'agent-derived', required: false }],
    });
    expect(updated.acceptanceCriteria.map((c) => c.id)).toEqual(['ac-1', 'ac-2']);
    expect(updated.version).toBe(2);
  });
});

describe('resource.snapshot surface (§10)', () => {
  function snapEvent(seq: number, used: number, remaining = 40 - used): SessionEventEnvelope {
    return {
      schemaVersion: 1,
      sessionId: 's',
      seq,
      ts: seq,
      kind: 'resource.snapshot',
      actor: { type: 'system' },
      data: {
        toolCallsLimit: 40,
        toolCallsUsed: used,
        toolCallsRemaining: remaining,
        verificationReserve: 6,
        repairReserve: 4,
        stage: 'implement',
        pressure: 'normal',
      },
    };
  }

  it('is model-surface but LATEST-ONLY: only the last snapshot projects', () => {
    expect(MODEL_SURFACE_KINDS.has('resource.snapshot')).toBe(true);
    expect([...LATEST_ONLY_SURFACE_KINDS]).toEqual(['resource.snapshot']);
    const events = [
      { kind: 'user.message', seq: 1, ts: 1, schemaVersion: 1, sessionId: 's', actor: { type: 'user' }, data: { text: 'hi' } },
      snapEvent(2, 10),
      snapEvent(3, 27),
    ] as SessionEventEnvelope[];
    const messages = deriveMessages(events);
    const snapshots = messages.filter((m) => m.content.startsWith('RESOURCE STATUS'));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.seq).toBe(3);
    expect(snapshots[0]!.content).toContain('Tool calls: 27 / 40');
    expect(snapshots[0]!.content).toContain('Verification reserve: 6');
  });

  it('invariants: monotone usage, coherent remaining, non-negative reserves', () => {
    expect(SESSION_EVENT_KINDS).toContain('resource.snapshot');
    const good = [snapEvent(2, 10), snapEvent(3, 27)];
    expect(validateResourceAndContractEvents(good)).toEqual([]);
    const bad = [snapEvent(2, 27), snapEvent(3, 20, 10)]; // used went backwards + 20+10 != 40
    const codes = validateResourceAndContractEvents(bad).map((v) => v.code);
    expect(codes).toContain('RESOURCE_USED_MONOTONIC');
    expect(codes).toContain('RESOURCE_REMAINING_COHERENT');
  });

  it('pressure bands derive from the same policy the budget used', () => {
    expect(budgetPressure(computeBudget(POLICY, { toolCallsUsed: 10 }), POLICY)).toBe('ample');
    expect(budgetPressure(computeBudget(POLICY, { toolCallsUsed: 37 }), POLICY)).toBe('critical');
  });
});
