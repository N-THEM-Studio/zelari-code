/**
 * tools/eval/evolveDecide.test.ts — Fase 2.1 — decision engine tests.
 * Covers: fail-closed evidence gates for 'applied' (ref, >= 1 evidence,
 * evidence per requiredValidation ask, non-empty entries), evidence-free
 * rejected/withdrawn, unknown id / invalid status / empty id errors,
 * idempotent noop on equal effective status, "exit 0" warnings
 * (non-fatal), buildDecisionRecord copy semantics, effectiveStatusById
 * fold (last wins), parseProposalStore round-trip with decision:true,
 * the append layer (dry-run vs real), and the event-sourced dedupe
 * integration: withdrawn re-allows, applied/rejected keep blocking.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProposals, effectiveStatusById, parseProposalStore, type StoredProposal } from './evolvePropose.ts';
import { type EvidenceFinding } from './spineEvidence.ts';
import {
  appendDecision,
  buildDecisionRecord,
  decide,
  type DecisionInput,
} from './evolveDecide.ts';

const FIXED_AT = '2025-07-01T09:30:00.000Z';

function finding(partial: Partial<EvidenceFinding> & { id: string; kind: string }): EvidenceFinding {
  return { severity: 'warn', count: 1, sessions: [], detail: '', hint: '', ...partial };
}

/** A realistic proposed record straight out of the proposal engine (fingerprint guaranteed to match). */
function proposedRecord(id: string, findingId: string): StoredProposal {
  const { proposals } = buildProposals([finding({ id: findingId, kind: findingId.split(':')[0]!, count: 4, sessions: ['s1'] })], []);
  return { ...proposals[0]!, id, createdAt: FIXED_AT };
}

/** tool: surface → requiredValidation ['npm run typecheck', 'npm run test:eval'] (2 asks). */
function toolProposal(id = 'p-0001'): StoredProposal {
  return proposedRecord(id, 'tool-misuse:read_file');
}

function appliedInput(partial: Partial<DecisionInput> & { id?: string }): DecisionInput {
  return { id: 'p-0001', status: 'applied', ref: 'wt/fix-read-file', evidence: ['npm run typecheck → exit 0', 'npm run test:eval → exit 0'], ...partial };
}

describe('decide — fail-closed validation for applied', () => {
  it('applied without ref → throws (actionable)', () => {
    const rec = toolProposal();
    expect(() => decide([rec], appliedInput({ ref: undefined }), FIXED_AT)).toThrow(/--ref/);
    expect(() => decide([rec], appliedInput({ ref: '   ' }), FIXED_AT)).toThrow(/--ref/);
  });

  it('applied with zero evidence → throws', () => {
    expect(() => decide([toolProposal()], appliedInput({ evidence: [] }), FIXED_AT)).toThrow(/at least 1 evidence/);
  });

  it('applied with fewer evidence entries than requiredValidation asks (tool: → 2) → throws', () => {
    expect(() => decide([toolProposal()], appliedInput({ evidence: ['npm run typecheck → exit 0'] }), FIXED_AT))
      .toThrow(/2 required.*got 1/);
  });

  it('applied on a requiredValidation [] surface still needs >= 1 evidence entry', () => {
    const rec = proposedRecord('p-0002', 'verification-unknown');
    expect(rec.requiredValidation).toEqual([]);
    expect(() => decide([rec], { id: 'p-0002', status: 'applied', ref: 'wt/x', evidence: [] }, FIXED_AT))
      .toThrow(/at least 1 evidence/);
  });

  it('applied with an empty / whitespace evidence entry → throws', () => {
    expect(() => decide([toolProposal()], appliedInput({ evidence: ['npm run typecheck → exit 0', ''] }), FIXED_AT))
      .toThrow(/non-empty/);
    expect(() => decide([toolProposal()], appliedInput({ evidence: ['npm run typecheck → exit 0', '   '] }), FIXED_AT))
      .toThrow(/non-empty/);
  });

  it('applied happy path: ref + one evidence per ask → appended, no warnings', () => {
    const { outcome, record, warnings } = decide([toolProposal()], appliedInput(), FIXED_AT);
    expect(outcome).toBe('appended');
    expect(warnings).toEqual([]);
    expect(record!.status).toBe('applied');
  });
});

describe('decide — rejected/withdrawn are evidence-free', () => {
  it('rejected needs no ref and no evidence → appended', () => {
    const { outcome, record, warnings } = decide([toolProposal()], { id: 'p-0001', status: 'rejected', evidence: [] }, FIXED_AT);
    expect(outcome).toBe('appended');
    expect(warnings).toEqual([]);
    expect(record!.status).toBe('rejected');
    expect(record!.decision).toBe(true);
  });

  it('withdrawn needs no ref and no evidence → appended', () => {
    const { outcome, record } = decide([toolProposal()], { id: 'p-0001', status: 'withdrawn', evidence: [] }, FIXED_AT);
    expect(outcome).toBe('appended');
    expect(record!.status).toBe('withdrawn');
  });
});

describe('decide — input/store errors and idempotency', () => {
  it('empty id → throws; unknown id → throws (actionable, mentions --list)', () => {
    expect(() => decide([toolProposal()], appliedInput({ id: '' }), FIXED_AT)).toThrow(/non-empty proposal id/);
    expect(() => decide([toolProposal()], appliedInput({ id: 'p-9999' }), FIXED_AT)).toThrow(/unknown proposal id 'p-9999'/);
    expect(() => decide([], appliedInput(), FIXED_AT)).toThrow(/unknown proposal id/);
  });

  it('invalid status (not one of the three) → throws', () => {
    expect(() => decide([toolProposal()], appliedInput({ status: 'frozen' as DecisionInput['status'] }), FIXED_AT))
      .toThrow(/invalid decision status/);
  });

  it('idempotent noop when the EFFECTIVE status already equals the requested status', () => {
    const proposed = toolProposal();
    const applied = decide([proposed], appliedInput(), FIXED_AT).record!;
    const store = [proposed, applied];
    const result = decide(store, appliedInput(), '2025-07-02T00:00:00.000Z');
    expect(result.outcome).toBe('noop');
    expect(result.record).toBeUndefined();
    expect(result.warnings).toEqual([]);
    // withdrawn decided twice → second is a noop too
    const withdrawn = decide([proposed], { id: 'p-0001', status: 'withdrawn', evidence: [] }, FIXED_AT).record!;
    expect(decide([proposed, withdrawn], { id: 'p-0001', status: 'withdrawn', evidence: [] }, FIXED_AT).outcome).toBe('noop');
  });

  it('warnings (non-fatal): evidence without "exit 0" still appends, warning returned', () => {
    const { outcome, warnings } = decide(
      [toolProposal()],
      appliedInput({ evidence: ['npm run typecheck → exit 0', 'manually reviewed by operator'] }),
      FIXED_AT,
    );
    expect(outcome).toBe('appended');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('does not state "exit 0"');
  });
});

describe('buildDecisionRecord — copies the latest record, overrides decision fields', () => {
  it('keeps id/fingerprint/operator/surface/requiredValidation/createdAt; sets status/decidedAt/decision/ref/evidence', () => {
    const latest = toolProposal('p-0007');
    const input = appliedInput({ id: 'p-0007', note: 'verified in worktree' });
    const record = buildDecisionRecord(latest, input, FIXED_AT);
    expect(record).toMatchObject({
      id: 'p-0007',
      createdAt: FIXED_AT,
      fingerprint: latest.fingerprint,
      operator: 'revise_tool_description',
      surface: 'tool:read_file',
      requiredValidation: latest.requiredValidation,
      status: 'applied',
      decidedAt: FIXED_AT,
      decision: true,
      ref: 'wt/fix-read-file',
      evidence: ['npm run typecheck → exit 0', 'npm run test:eval → exit 0'],
      note: 'verified in worktree',
    });
  });
});

describe('effectiveStatusById — event-sourced fold (last wins)', () => {
  it('single record folds to identity; later records override status; empty → empty map', () => {
    const proposed = toolProposal();
    const single = effectiveStatusById([proposed]);
    expect(single.size).toBe(1);
    expect(single.get('p-0001')).toEqual({ status: 'proposed', record: proposed });

    const applied = decide([proposed], appliedInput(), FIXED_AT).record!;
    const withdrawn = decide([proposed, applied], { id: 'p-0001', status: 'withdrawn', evidence: [] }, FIXED_AT).record!;
    const folded = effectiveStatusById([proposed, applied, withdrawn]);
    expect(folded.get('p-0001')!.status).toBe('withdrawn');
    expect(folded.get('p-0001')!.record).toBe(withdrawn);
    expect(effectiveStatusById([]).size).toBe(0);
  });

  it('folds per id: two ids keep independent effective statuses', () => {
    const a = toolProposal('p-0001');
    const b = proposedRecord('p-0002', 'skill-low-success:write-readme');
    const aApplied = decide([a], appliedInput({ id: 'p-0001' }), FIXED_AT).record!;
    const folded = effectiveStatusById([a, b, aApplied]);
    expect(folded.get('p-0001')!.status).toBe('applied');
    expect(folded.get('p-0002')!.status).toBe('proposed');
  });
});

describe('parseProposalStore round-trip — decision records', () => {
  it('a decision record parses back with decision:true, ref, evidence[], decidedAt intact', () => {
    const proposed = toolProposal();
    const record = decide([proposed], appliedInput({ note: 'ok' }), FIXED_AT).record!;
    const { records, malformed } = parseProposalStore([JSON.stringify(proposed), JSON.stringify(record)]);
    expect(malformed).toBe(0);
    expect(records).toHaveLength(2);
    const parsed = records[1]!;
    expect(parsed.id).toBe('p-0001');
    expect(parsed.status).toBe('applied');
    expect((parsed as { decision?: boolean }).decision).toBe(true);
    expect((parsed as { decidedAt?: string }).decidedAt).toBe(FIXED_AT);
    expect((parsed as { ref?: string }).ref).toBe('wt/fix-read-file');
    expect((parsed as { evidence?: string[] }).evidence).toEqual(['npm run typecheck → exit 0', 'npm run test:eval → exit 0']);
  });
});

describe('decide × buildProposals — event-sourced dedupe (THE fix)', () => {
  const toolFinding = (): EvidenceFinding => finding({ id: 'tool-misuse:read_file', kind: 'tool-misuse', count: 4, sessions: ['s1'] });

  it('(a) proposed + appended withdrawn decision → buildProposals PROPOSES again (was blocked)', () => {
    const proposed = toolProposal();
    expect(buildProposals([toolFinding()], [proposed]).deduped).toBe(1); // blocked before the decision
    const withdrawn = decide([proposed], { id: 'p-0001', status: 'withdrawn', evidence: [] }, FIXED_AT).record!;
    const { proposals, deduped } = buildProposals([toolFinding()], [proposed, withdrawn]);
    expect(deduped).toBe(0);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.fingerprint).toBe(proposed.fingerprint);
  });

  it('(b) proposed + applied decision → still deduped/blocked', () => {
    const proposed = toolProposal();
    const applied = decide([proposed], appliedInput(), FIXED_AT).record!;
    const { proposals, deduped } = buildProposals([toolFinding()], [proposed, applied]);
    expect(deduped).toBe(1);
    expect(proposals).toHaveLength(0);
  });

  it('(c) proposed + rejected decision → still blocked', () => {
    const proposed = toolProposal();
    const rejected = decide([proposed], { id: 'p-0001', status: 'rejected', evidence: [] }, FIXED_AT).record!;
    const { proposals, deduped } = buildProposals([toolFinding()], [proposed, rejected]);
    expect(deduped).toBe(1);
    expect(proposals).toHaveLength(0);
  });

  it('unknown EFFECTIVE status still blocks (fail-closed preserved through the fold)', () => {
    const proposed = toolProposal();
    const mystery = { ...proposed, id: 'p-0001', status: 'mystery-status', decision: true, decidedAt: FIXED_AT };
    const { proposals, deduped } = buildProposals([toolFinding()], [proposed, mystery as unknown as StoredProposal]);
    expect(deduped).toBe(1);
    expect(proposals).toHaveLength(0);
  });
});

describe('appendDecision', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmpStore(name: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'evolve-decide-test-'));
    dirs.push(dir);
    return path.join(dir, name);
  }

  it('non-dry → appends ONE parseable line (decision:true); dry-run → nothing written', () => {
    const proposed = toolProposal();
    const record = decide([proposed], appliedInput(), FIXED_AT).record!;
    const store = tmpStore(path.join('nested', 'proposals.jsonl'));
    expect(appendDecision(store, record)).toEqual({ written: 1, path: store });
    const { records, malformed } = parseProposalStore(readFileSync(store, 'utf-8').split(/\r?\n/));
    expect(malformed).toBe(0);
    expect((records[0] as { decision?: boolean }).decision).toBe(true);

    const dryStore = tmpStore(path.join('nested', 'dry.jsonl'));
    expect(appendDecision(dryStore, record, { dryRun: true })).toEqual({ written: 0, path: dryStore });
    expect(existsSync(dryStore)).toBe(false);
    expect(existsSync(path.dirname(dryStore))).toBe(false);
  });
});
