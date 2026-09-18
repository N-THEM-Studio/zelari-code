/**
 * K1.2 / F2 — graph `unresolved` findings must join the strict-done gate.
 *
 * A writer FAIL after rework budget becomes `unresolved[]` on the graph
 * runtime, but evaluateStrictBuildGate historically composed only
 * selection+pack+contract. A green selection could therefore strict-PASS
 * over unfinished nodes. Unresolved = unsatisfied criterion (like failed);
 * the gate blocks and the summary names the node ids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UnresolvedFinding } from '@zelari/core';
import {
  evaluateStrictBuildGate,
  strictGateExitCode,
} from './verificationBridge.js';
import {
  resetKrakenCandidates,
  setKrakenCheckResults,
  setKrakenSelection,
} from './candidateRegistry.js';

const CHECK = 'session survives concurrent refresh';

function emitSeq(): (input: unknown) => Promise<{ seq: number }> {
  let n = 1;
  return async () => ({ seq: n++ });
}

function selectPassingWithTrace(): void {
  resetKrakenCandidates();
  setKrakenSelection({
    status: 'selected',
    winnerIndex: 0,
    rationale: 'test',
    requiredChecks: [CHECK],
    degraded: false,
    verifier: null,
    judgedBy: 'llm',
  });
  setKrakenCheckResults([{ check: CHECK, status: 'pass', note: 'vitest 58/58' }], [
    {
      tool: 'bash',
      callId: 'c-vitest',
      ok: true,
      command: 'vitest',
      output: '58/58 passed',
      durationMs: 1,
      endedAt: Date.now(),
    },
  ]);
}

const UNRESOLVED: UnresolvedFinding[] = [
  {
    nodeId: 'writer-7',
    label: 'fix auth refresh',
    reason: 'fail',
    findings: 'rework budget spent — tests still red',
  },
];

let packPrev: string | undefined;
let strictPrev: string | undefined;

beforeEach(() => {
  packPrev = process.env.ZELARI_VERIFY_PACK;
  strictPrev = process.env.ZELARI_STRICT_DONE;
  process.env.ZELARI_VERIFY_PACK = '0';
  process.env.ZELARI_STRICT_DONE = '1';
  resetKrakenCandidates();
});

afterEach(() => {
  if (packPrev === undefined) delete process.env.ZELARI_VERIFY_PACK;
  else process.env.ZELARI_VERIFY_PACK = packPrev;
  if (strictPrev === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = strictPrev;
  resetKrakenCandidates();
});

describe('K1.2 — unresolved graph nodes join the strict-done gate', () => {
  it('selection PASS + unresolved writer → blocked, node ids in the message', async () => {
    selectPassingWithTrace();
    const clean = await evaluateStrictBuildGate('build', {
      env: { ZELARI_VERIFY_PACK: '0', ZELARI_STRICT_DONE: '1' },
      emit: emitSeq(),
    });
    expect(clean.blocked).toBe(false);
    expect(clean.evaluation?.verdict).toBe('PASS');

    const dirty = await evaluateStrictBuildGate('build', {
      env: { ZELARI_VERIFY_PACK: '0', ZELARI_STRICT_DONE: '1' },
      emit: emitSeq(),
      unresolvedFindings: UNRESOLVED,
    });
    expect(dirty.blocked).toBe(true);
    expect(dirty.evaluation?.verdict).not.toBe('PASS');
    expect(dirty.summary).toContain('writer-7');
    expect(strictGateExitCode(dirty)).toBe(4);
  });

  it('unresolved reason=unknown is unsatisfied (unknown ≠ pass), still names the node', async () => {
    selectPassingWithTrace();
    const dirty = await evaluateStrictBuildGate('build', {
      env: { ZELARI_VERIFY_PACK: '0', ZELARI_STRICT_DONE: '1' },
      emit: emitSeq(),
      unresolvedFindings: [
        {
          nodeId: 'n-unknown',
          label: 'verify trailer missing',
          reason: 'unknown',
          findings: 'no parseable VERDICT',
        },
      ],
    });
    expect(dirty.blocked).toBe(true);
    expect(dirty.summary).toContain('n-unknown');
    const unsat = dirty.evaluation?.unsatisfied ?? [];
    expect(unsat.some((u) => u.id.includes('n-unknown') || u.id.includes('unresolved'))).toBe(true);
  });
});
