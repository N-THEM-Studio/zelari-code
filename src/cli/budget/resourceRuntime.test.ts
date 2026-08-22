/**
 * src/cli/budget/resourceRuntime.test.ts — 2.6 Track B CLI-side tests:
 * ledger rebuild from session events (no double-count), snapshot emission
 * triggers, task-contract seeding on the spine.
 */

import { describe, expect, it } from 'vitest';
import type { SessionEventEnvelope } from '@zelari/core';
import { defaultResourcePolicy } from '@zelari/core';
import { ResourceLedger, rebuildLedgerFromEvents } from './resourceLedger.js';
import { buildResourceSnapshot, shouldEmitSnapshot } from './resourceSnapshot.js';
import { deriveInitialContract } from '@zelari/core';

const POLICY = defaultResourcePolicy('kraken/v1');

function toolCall(seq: number, tool = 'bash'): SessionEventEnvelope {
  return {
    schemaVersion: 1,
    sessionId: 's',
    seq,
    ts: seq,
    kind: 'tool.call',
    actor: { type: 'agent' },
    data: { tool, callId: `c${seq}`, args: {} },
  };
}

describe('ResourceLedger / rebuildLedgerFromEvents', () => {
  it('counts exactly the tool.call events — never tool.interrupted', () => {
    const events = [
      toolCall(1),
      toolCall(2),
      { ...toolCall(3), kind: 'tool.interrupted' as const },
      toolCall(4),
    ];
    const ledger = rebuildLedgerFromEvents(events);
    expect(ledger.usage().toolCallsUsed).toBe(3);
  });

  it('budget() projection honours the policy limit and stage', () => {
    const ledger = ResourceLedger.fromEntries(
      Array.from({ length: 27 }, (_, i) => ({ seq: i + 1, reason: 'tool-call' as const, delta: { toolCalls: 1 } })),
    );
    const budget = ledger.budget(POLICY, 'verify');
    expect(budget.toolCalls.remaining).toBe(13);
    expect(budget.stage).toBe('verify');
    expect(ledger.pressure(POLICY)).toBe('constrained');
  });

  it('record() appends host-side and stays idempotent on replay', () => {
    const ledger = new ResourceLedger();
    ledger.record('tool-call');
    ledger.record('tool-call');
    expect(ledger.usage().toolCallsUsed).toBe(2);
    expect(ledger.snapshot()).toHaveLength(2);
  });
});

describe('resource snapshot emission (§10.4)', () => {
  it('emits on first snapshot, stage change, pressure change, usage delta', () => {
    const emptyLedger = new ResourceLedger();
    const first = buildResourceSnapshot({ ...emptyLedger.budget(POLICY), stage: 'explore' }, POLICY);
    expect(shouldEmitSnapshot(undefined, first)).toBe(true);

    const five = ResourceLedger.fromEntries(
      Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, reason: 'tool-call' as const, delta: { toolCalls: 1 } })),
    );
    const afterBatch = buildResourceSnapshot(five.budget(POLICY), POLICY);
    expect(shouldEmitSnapshot(first, afterBatch)).toBe(true);
    expect(shouldEmitSnapshot(afterBatch, afterBatch)).toBe(false);

    const stageChange = buildResourceSnapshot(five.budget(POLICY, 'verify'), POLICY);
    expect(shouldEmitSnapshot(afterBatch, stageChange)).toBe(true);
  });

  it('marks the protected zone when remaining <= verificationReserve', () => {
    const ledger = ResourceLedger.fromEntries(
      Array.from({ length: 35 }, (_, i) => ({ seq: i + 1, reason: 'tool-call' as const, delta: { toolCalls: 1 } })),
    );
    const inside = buildResourceSnapshot(ledger.budget(POLICY), POLICY);
    expect(inside.reserveProtected).toBe(true);
    expect(inside.pressure).toBe('critical');
    expect(inside.toolCallsUsed + inside.toolCallsRemaining).toBe(inside.toolCallsLimit);
  });
});

describe('kraken taskContract seeding', () => {
  it('derives a contract from the first user message', () => {
    const contract = deriveInitialContract(3, 'Fix the parser bug\n- do not add dependencies\n- verify: npm test');
    expect(contract.source.userSeq).toBe(3);
    expect(contract.constraints[0]!.text).toContain('do not add dependencies');
    expect(contract.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
  });
});
