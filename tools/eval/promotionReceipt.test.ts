/**
 * tools/eval/promotionReceipt.test.ts — WS7 slice 1 — the ONE unified receipt.
 *
 * Covers: mapping totality + inverse coherence (status↔decision, gate↔decision),
 * the fail-closed promote gate (non-empty ref + one evidence entry per declared
 * ask, otherwise DEGRADE to hold — never throw, never round up), the schema
 * refusing a proof-less promote, canary as an opt-in non-fallback, retro-compat
 * with rows written BEFORE this slice (no `promotion`, no new fields), the two
 * round-trips (summary↔receipt, decision↔receipt), anti-laundering (a stored
 * receipt is authoritative; a new decision drops an inherited one) and
 * unknown ≠ 0/false for cacheHitDelta / prefixStable.
 *
 * The derivations are imported from the CLIENT modules (regressionGate.ts /
 * evolveDecide.ts) on purpose: the re-export IS part of the contract (wiring is
 * additive there), and the row types used are the real `EvalSummaryRecord` /
 * `DecisionRecord`.
 */

import { describe, expect, it } from 'vitest';
import { evaluateRegressionGate, receiptFromSummary, type GateComparison } from './regressionGate.ts';
import { RETENTION_PRESETS } from './retentionPolicy.ts';
import { zeroCost } from './cost.ts';
import type { AnchorRunRecord } from './types.ts';
import type { EvalSummaryRecord } from './resultStore.ts';
import { decide, receiptFromDecision, type DecisionRecord } from './evolveDecide.ts';
import { buildProposals, type StoredProposal } from './evolvePropose.ts';
import { PROMOTION_DECISIONS, PromotionReceiptSchema, decisionToGates, decisionToStatuses, gateToDecisions, parsePromotionReceipt, resolvePromotionDecision, statusToDecisions } from './promotionReceipt.ts';

const FIXED_AT = '2026-01-02T03:04:05.000Z';
const ASK_1 = 'npm run typecheck → exit 0';
const ASK_2 = 'npm run test:eval → exit 0';

function rec(anchorId: string, result: AnchorRunRecord['result']): AnchorRunRecord {
  return {
    runId: 'r',
    anchorId,
    anchorVersion: 1,
    harnessManifestHash: 'h',
    resourcePolicyHash: 'p',
    result,
    verified: result === 'pass',
    cost: { ...zeroCost(), modelCostUsd: 0.1, toolCalls: 5, wallMs: 1_000 },
    exitCode: result === 'pass' ? 0 : 1,
    recordedAt: FIXED_AT,
  };
}

/** A real retention-gate outcome: same candidate, passing vs regressing. */
function gateComparison(decision: 'COMMIT' | 'REJECT'): GateComparison {
  return evaluateRegressionGate({
    manifestHash: 'cand-1',
    baseline: [rec('a1', 'pass')],
    candidate: [rec('a1', decision === 'COMMIT' ? 'pass' : 'fail')],
    currentSuite: { passed: 1, total: 1 },
    policy: RETENTION_PRESETS.stable,
  });
}

/** The summary row CI persists for that outcome — exactly the shape written BEFORE this slice. */
function summaryRow(comparison: GateComparison): EvalSummaryRecord {
  return {
    manifestHash: comparison.result.manifestHash,
    recordedAt: FIXED_AT,
    gateDecision: comparison.decision,
    gateReasons: comparison.reasons,
    result: comparison.result,
  };
}

/** tool: surface → requiredValidation = [typecheck, test:eval] (2 asks). */
function proposal(id = 'p-0001'): StoredProposal {
  const finding = { id: 'tool-misuse:read_file', kind: 'tool-misuse', severity: 'warn' as const, count: 4, sessions: ['s1'], detail: '', hint: '' };
  const { proposals } = buildProposals([finding], []);
  return { ...proposals[0]!, id, createdAt: FIXED_AT };
}

function appliedRecord(id = 'p-0001'): DecisionRecord {
  const { record } = decide(
    [proposal(id)],
    { id, status: 'applied', ref: 'wt/fix-read-file', evidence: [ASK_1, ASK_2], note: 'verified in worktree' },
    FIXED_AT,
  );
  return record!;
}

const PROOF = { ref: 'wt/fix-read-file', evidence: [{ kind: 'validation', ref: ASK_1 }, { kind: 'validation', ref: ASK_2 }] };

describe('mapping tables — total, deterministic, inverse-coherent', () => {
  it('status → decisions is total: known statuses map, unknown/empty map to []', () => {
    expect(statusToDecisions('applied')).toEqual(['promote', 'canary']);
    expect(statusToDecisions('rejected')).toEqual(['reject']);
    expect(statusToDecisions('withdrawn')).toEqual(['hold']);
    expect(statusToDecisions('mystery-status')).toEqual([]);
    expect(statusToDecisions('')).toEqual([]);
  });

  it('decision → statuses is total and every edge is coherent in BOTH directions', () => {
    for (const decision of PROMOTION_DECISIONS) {
      const statuses = decisionToStatuses(decision);
      expect(statuses.length).toBeGreaterThanOrEqual(1);
      for (const status of statuses) expect(statusToDecisions(status)).toContain(decision);
    }
    expect(decisionToStatuses('promote')).toEqual(['applied']);
    expect(decisionToStatuses('canary')).toEqual(['applied']);
    expect(decisionToStatuses('hold')).toEqual(['withdrawn']);
    expect(decisionToStatuses('reject')).toEqual(['rejected']);
  });

  it('gate → decisions is total; the gate has no abstention state (hold → [])', () => {
    expect(gateToDecisions('COMMIT')).toEqual(['promote', 'canary']);
    expect(gateToDecisions('REJECT')).toEqual(['reject']);
    expect(gateToDecisions('n/a')).toEqual([]);
    expect(decisionToGates('promote')).toEqual(['COMMIT']);
    expect(decisionToGates('canary')).toEqual(['COMMIT']);
    expect(decisionToGates('reject')).toEqual(['REJECT']);
    expect(decisionToGates('hold')).toEqual([]);
  });

  it('the helpers are pure: mutating a result never corrupts the table', () => {
    statusToDecisions('applied').push('reject');
    expect(statusToDecisions('applied')).toEqual(['promote', 'canary']);
  });
});

describe('fail-closed — promote refuses insufficient proof and degrades to hold', () => {
  it('a legacy COMMIT row with no proof → hold, with the reasons that say why', () => {
    const receipt = receiptFromSummary(summaryRow(gateComparison('COMMIT')));
    expect(receipt.decision).toBe('hold');
    expect(receipt.status).toBe('COMMIT');
    expect(receipt.source).toBe('gate');
    expect(receipt.subject).toBe('cand-1');
    expect(receipt.at).toBe(FIXED_AT);
    expect(receipt.reasons.join(' ')).toMatch(/promote refused: ref is empty/);
    expect(receipt.reasons.join(' ')).toMatch(/1 evidence entry required/);
  });

  it('a ref alone is not enough: >= 1 evidence entry is required', () => {
    expect(receiptFromSummary(summaryRow(gateComparison('COMMIT')), { ref: 'wt/x' }).decision).toBe('hold');
  });

  it('evidence must answer EVERY declared ask (2 asks, 1 entry → hold)', () => {
    const receipt = receiptFromSummary(summaryRow(gateComparison('COMMIT')), {
      ref: 'wt/x',
      evidence: [{ kind: 'validation', ref: ASK_1 }],
      requiredValidation: ['npm run typecheck', 'npm run test:eval'],
    });
    expect(receipt.decision).toBe('hold');
    expect(receipt.reasons.join(' ')).toMatch(/2 validation ask\(s\).*got 1/);
  });

  it('blank refs and blank evidence refs are dropped, never counted as proof', () => {
    const receipt = receiptFromSummary(summaryRow(gateComparison('COMMIT')), { ref: '   ', evidence: [{ kind: 'validation', ref: '  ' }] });
    expect(receipt.decision).toBe('hold');
    expect(receipt.ref).toBeUndefined();
    expect(receipt.evidence).toEqual([]);
  });

  it('ref + one entry per ask → promote with no reasons', () => {
    const receipt = receiptFromSummary(summaryRow(gateComparison('COMMIT')), { ...PROOF, requiredValidation: ['npm run typecheck', 'npm run test:eval'] });
    expect(receipt.decision).toBe('promote');
    expect(receipt.reasons).toEqual([]);
    expect(receipt.ref).toBe('wt/fix-read-file');
    expect(receipt.evidence).toHaveLength(2);
  });

  it('reject / withdrawn / canary are NOT gated (refusing is cheap, promoting is not)', () => {
    expect(receiptFromSummary(summaryRow(gateComparison('REJECT'))).decision).toBe('reject');
    expect(resolvePromotionDecision('canary', {}).decision).toBe('canary');
    expect(resolvePromotionDecision('hold', {}).reasons).toEqual([]);
  });

  it('the schema refuses a proof-less promote: a bogus row cannot even parse', () => {
    const bogus = { ...receiptFromSummary(summaryRow(gateComparison('COMMIT'))), decision: 'promote' as const };
    expect(PromotionReceiptSchema.safeParse(bogus).success).toBe(false);
    expect(parsePromotionReceipt(bogus).error).toMatch(/non-empty ref/);
  });
});

describe('canary is opt-in and is never an automatic fallback', () => {
  it('a compatible request is honoured (COMMIT + request canary → canary)', () => {
    const receipt = receiptFromSummary(summaryRow(gateComparison('COMMIT')), { request: 'canary' });
    expect(receipt.decision).toBe('canary');
    expect(receipt.reasons).toEqual([]);
  });

  it('a refused promote degrades to hold, NEVER to canary', () => {
    expect(receiptFromSummary(summaryRow(gateComparison('COMMIT')), { request: 'promote' }).decision).toBe('hold');
  });

  it('an incompatible request is ignored with a reason — never a silent upgrade', () => {
    const receipt = receiptFromSummary(summaryRow(gateComparison('REJECT')), { request: 'canary' });
    expect(receipt.decision).toBe('reject');
    expect(receipt.reasons.join(' ')).toMatch(/not compatible with status "REJECT"/);
  });
});

describe('derived from the decision store (evolveDecide)', () => {
  it('an applied decision with ref + one evidence per ask → promote; operator/surface/note carried over', () => {
    const record = appliedRecord();
    const receipt = receiptFromDecision(record);
    expect(receipt.decision).toBe('promote');
    expect(receipt.source).toBe('decision');
    expect(receipt.subject).toBe('p-0001');
    expect(receipt.status).toBe('applied');
    expect(receipt.at).toBe(FIXED_AT);
    expect(receipt.operator).toBe(record.operator);
    expect(receipt.surface).toBe(record.surface);
    expect(receipt.ref).toBe('wt/fix-read-file');
    expect(receipt.requiredValidation).toEqual(record.requiredValidation);
    expect(receipt.evidence).toEqual((record.evidence ?? []).map((ref) => ({ kind: 'validation', ref })));
    expect(receipt.reasons).toEqual(['verified in worktree']);
  });

  it('rejected → reject and withdrawn → hold (abstention is not a refusal)', () => {
    const rejected = decide([proposal()], { id: 'p-0001', status: 'rejected', evidence: [] }, FIXED_AT).record!;
    const withdrawn = decide([proposal()], { id: 'p-0001', status: 'withdrawn', evidence: [] }, FIXED_AT).record!;
    expect(receiptFromDecision(rejected).decision).toBe('reject');
    expect(receiptFromDecision(withdrawn).decision).toBe('hold');
  });

  it('a hand-written applied row with too little evidence degrades to hold', () => {
    const row = { id: 'p-0099', decidedAt: FIXED_AT, status: 'applied', ref: 'wt/x', evidence: [ASK_1], requiredValidation: ['a', 'b'] };
    const receipt = receiptFromDecision(row);
    expect(receipt.decision).toBe('hold');
    expect(receipt.reasons.join(' ')).toMatch(/2 validation ask\(s\).*got 1/);
  });

  it('an unknown status holds and never promotes, even with full proof', () => {
    const receipt = receiptFromDecision({ ...appliedRecord(), status: 'mystery-status' }, PROOF);
    expect(receipt.decision).toBe('hold');
    expect(receipt.status).toBe('mystery-status');
    expect(receipt.reasons.join(' ')).toMatch(/no decision derivable from status "mystery-status"/);
  });
});

describe('round-trip — the receipt IS the row', () => {
  it('summary ↔ receipt: a persisted receipt is returned verbatim and survives JSON', () => {
    const promoted = receiptFromSummary(summaryRow(gateComparison('COMMIT')), PROOF);
    expect(promoted.decision).toBe('promote');
    const row: EvalSummaryRecord = { ...summaryRow(gateComparison('COMMIT')), promotion: promoted };
    const roundTripped = JSON.parse(JSON.stringify(row)) as EvalSummaryRecord;
    expect(receiptFromSummary(roundTripped)).toEqual(promoted);
    expect(receiptFromSummary(roundTripped)).toEqual(receiptFromSummary(roundTripped));
  });

  it('decision ↔ receipt: a persisted receipt is returned verbatim and survives JSON', () => {
    const promoted = receiptFromDecision(appliedRecord());
    const row: DecisionRecord = { ...appliedRecord(), promotion: promoted };
    const roundTripped = JSON.parse(JSON.stringify(row)) as DecisionRecord;
    expect(receiptFromDecision(roundTripped)).toEqual(promoted);
    expect(PromotionReceiptSchema.safeParse(roundTripped.promotion).success).toBe(true);
  });

  it('a stored receipt is authoritative — later proof does NOT launder a hold into a promote', () => {
    const held = receiptFromSummary(summaryRow(gateComparison('COMMIT')));
    expect(held.decision).toBe('hold');
    const row: EvalSummaryRecord = { ...summaryRow(gateComparison('COMMIT')), promotion: held };
    expect(receiptFromSummary(row, PROOF).decision).toBe('hold');
  });

  it('a malformed stored receipt fails closed instead of being silently re-derived', () => {
    const row = { ...summaryRow(gateComparison('COMMIT')), promotion: { v: 1, decision: 'promote' } };
    const receipt = receiptFromSummary(row, PROOF);
    expect(receipt.decision).toBe('hold');
    expect(receipt.reasons.join(' ')).toMatch(/stored receipt unreadable/);
    expect(parsePromotionReceipt(row.promotion).error).toBeTruthy();
  });
});

describe('retro-compatibility — rows written before this slice', () => {
  it('a summary.json line without `promotion` (and without any new field) still derives', () => {
    const legacy = '{"manifestHash":"cand-1","recordedAt":"2026-01-02T03:04:05.000Z","gateDecision":"COMMIT","gateReasons":["validity PASS, 0 regressions"],"result":{"manifestHash":"cand-1"}}';
    const receipt = receiptFromSummary(JSON.parse(legacy) as EvalSummaryRecord, PROOF);
    expect(receipt.decision).toBe('promote');
    expect(receipt.reasons).toEqual(['validity PASS, 0 regressions']);
  });

  it('a proposals.jsonl decision line without `promotion` still derives a promote', () => {
    const legacy = JSON.stringify({
      id: 'p-0007',
      createdAt: FIXED_AT,
      status: 'applied',
      operator: 'revise_tool_description',
      surface: 'tool:read_file',
      fingerprint: 'revise_tool_description|tool:read_file|read_file',
      evidence: [ASK_1, ASK_2],
      rationale: 'r',
      patchHint: 'h',
      requiredValidation: ['npm run typecheck', 'npm run test:eval'],
      decidedAt: FIXED_AT,
      ref: 'wt/fix-read-file',
      decision: true,
    });
    const receipt = receiptFromDecision(JSON.parse(legacy) as DecisionRecord);
    expect(receipt.decision).toBe('promote');
    expect(receipt.subject).toBe('p-0007');
  });

  it('a row with no gate decision at all holds instead of guessing', () => {
    const receipt = receiptFromSummary({ manifestHash: 'm-unknown' }, PROOF);
    expect(receipt.decision).toBe('hold');
    expect(receipt.status).toBe('');
    expect(receipt.reasons.join(' ')).toMatch(/no decision derivable from status ""/);
  });

  it('decide()/buildDecisionRecord stamps a supplied receipt and DROPS an inherited one', () => {
    const stamped = appliedRecord();
    const receipt = receiptFromDecision(stamped);
    // A DecisionRecord re-enters the store through the same door the CLI's reader
    // uses (its `evidence: string[]` differs from a proposal's evidence object).
    const published = { ...stamped, promotion: receipt } as unknown as StoredProposal;
    const store: StoredProposal[] = [proposal(), published];
    const withdrawn = decide(store, { id: 'p-0001', status: 'withdrawn', evidence: [], promotion: receipt }, FIXED_AT).record!;
    expect(withdrawn.promotion).toEqual(receipt);
    const dropped = decide(store, { id: 'p-0001', status: 'withdrawn', evidence: [] }, FIXED_AT).record!;
    expect('promotion' in dropped).toBe(false);
  });
});

describe('cacheHitDelta / prefixStable — absent means unknown, never 0 / false', () => {
  it('are omitted when not supplied', () => {
    const receipt = receiptFromSummary(summaryRow(gateComparison('COMMIT')));
    expect('cacheHitDelta' in receipt).toBe(false);
    expect('prefixStable' in receipt).toBe(false);
  });

  it('are copied verbatim when supplied — including a measured false and a negative delta', () => {
    const receipt = receiptFromDecision(appliedRecord(), { cacheHitDelta: -1_200, prefixStable: false });
    expect(receipt.cacheHitDelta).toBe(-1_200);
    expect(receipt.prefixStable).toBe(false);
  });

  it('a non-finite cacheHitDelta is refused at parse, not silently coerced', () => {
    // zod 4 numbers are finite by construction: NaN and ±Infinity fail the schema.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => receiptFromSummary(summaryRow(gateComparison('COMMIT')), { cacheHitDelta: bad })).toThrow(/cacheHitDelta/);
    }
  });
});
