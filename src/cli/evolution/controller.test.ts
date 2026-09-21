/**
 * evolution/controller.test.ts — Evolution Controller v0 (shadow only).
 *
 * Red-if-reopens:
 *   - a parsable proposal under ZELARI_EVOLUTION=shadow is `shadow` and its
 *     reason says report-only;
 *   - under mode '0' (the default) EVERYTHING is hold, reason naming the env
 *     flag — the controller must not report when the surface is off;
 *   - an unparsable proposal is hold WITHOUT a proposal attached (no partial
 *     object can leak into a report);
 *   - kind+decisiveSeq dedupes: the second copy is hold;
 *   - evidence below minEvidence is hold (a fusion claim needs calls AND the
 *     boundary);
 *   - maxVerdicts caps the batch;
 *   - the summary counts estSavedCalls for shadow verdicts only.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTROLLER_POLICY,
  evaluateProposal,
  evaluateProposals,
  summarizeVerdicts,
  type ControllerProposal,
} from './controller.js';

const proposal = (over: Partial<ControllerProposal> = {}): ControllerProposal => ({
  kind: 'fuse_edit_verify',
  callIds: ['call:w1', 'call:v1'],
  estSavedCalls: 1,
  evidence: [
    { kind: 'tool.call', ref: 'call:w1' },
    { kind: 'assistant.message', ref: 'seq:9' },
    { kind: 'tool.call', ref: 'call:v1' },
  ],
  decisiveSeq: 10,
  ...over,
});

const shadowPolicy = { ...DEFAULT_CONTROLLER_POLICY, evolutionMode: 'shadow' as const };
const offPolicy = { ...DEFAULT_CONTROLLER_POLICY, evolutionMode: '0' as const };

describe('evaluateProposal', () => {
  it('shadows a parsable, evidenced proposal when evolution is on', () => {
    const v = evaluateProposal(proposal(), shadowPolicy, new Set());
    expect(v.action).toBe('shadow');
    expect(v.reason).toContain('report-only');
    expect(v.proposal?.decisiveSeq).toBe(10);
  });

  it('holds everything when the evolution surface is off (default)', () => {
    const v = evaluateProposal(proposal(), offPolicy, new Set());
    expect(v.action).toBe('hold');
    expect(v.reason).toContain('ZELARI_EVOLUTION');
  });

  it('holds an unparsable proposal without attaching it', () => {
    const v = evaluateProposal({ kind: 'fuse_edit_verify' }, shadowPolicy, new Set());
    expect(v.action).toBe('hold');
    expect(v.reason).toContain('unparsable');
    expect(v.proposal).toBeUndefined();
  });

  it('dedupes kind+decisiveSeq', () => {
    const seen = new Set<string>();
    const first = evaluateProposal(proposal(), shadowPolicy, seen);
    const second = evaluateProposal(proposal(), shadowPolicy, seen);
    expect(first.action).toBe('shadow');
    expect(second.action).toBe('hold');
    expect(second.reason).toContain('duplicate');
  });

  it('holds under-evidenced proposals', () => {
    const v = evaluateProposal(
      proposal({ evidence: [{ kind: 'tool.call', ref: 'call:w1' }] }),
      { ...shadowPolicy, minEvidence: 3 },
      new Set(),
    );
    expect(v.action).toBe('hold');
    expect(v.reason).toContain('insufficient evidence (1 < 3)');
  });
});

describe('evaluateProposals', () => {
  it('caps the batch at maxVerdicts', () => {
    const batch = Array.from({ length: 10 }, (_, i) => proposal({ decisiveSeq: i + 1 }));
    const verdicts = evaluateProposals(batch, { ...shadowPolicy, maxVerdicts: 4 });
    expect(verdicts).toHaveLength(4);
  });
});

describe('summarizeVerdicts', () => {
  it('counts saved calls for shadow verdicts only', () => {
    const verdicts = evaluateProposals(
      [proposal({ decisiveSeq: 1 }), proposal({ decisiveSeq: 1 }), proposal({ decisiveSeq: 2, estSavedCalls: 2 })],
      shadowPolicy,
    );
    const summary = summarizeVerdicts(verdicts);
    expect(summary).toEqual({ total: 3, shadow: 2, hold: 1, estSavedCalls: 3 });
  });
});
