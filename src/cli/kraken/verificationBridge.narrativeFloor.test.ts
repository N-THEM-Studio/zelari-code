/**
 * K1.5 — auto-verify trailer `VERDICT: PASS` is advisory, never the dossier.
 *
 * A narrative PASS without an instrumental artifact (tool-output /
 * command-output / fs-observation) must not stay `pass`. Same floor as
 * K1.3 in taskTool.ts: PASS requires ≥1 admissible instrumental artifact;
 * narrative-only → unknown.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateStrictBuildGate } from './verificationBridge.js';
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

function selectWith(check: string): void {
  resetKrakenCandidates();
  setKrakenSelection({
    status: 'selected',
    winnerIndex: 0,
    rationale: 'test',
    requiredChecks: [check],
    degraded: false,
    verifier: null,
    judgedBy: 'llm',
  });
}

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

describe('K1.5 — narrative VERDICT: PASS without artifacts is not pass', () => {
  it('VERDICT: PASS note and no tool trace → result status unknown, overall non-pass', async () => {
    selectWith(CHECK);
    setKrakenCheckResults([
      { check: CHECK, status: 'pass', note: 'Looks good.\nVERDICT: PASS' },
    ]);
    const gate = await evaluateStrictBuildGate('build', {
      env: { ZELARI_VERIFY_PACK: '0', ZELARI_STRICT_DONE: '1' },
      emit: emitSeq(),
    });
    expect(gate.blocked).toBe(true);
    expect(gate.evaluation?.verdict).not.toBe('PASS');
    const result = (gate.results ?? []).find((r) => r.source === 'verify-agent');
    expect(result).toBeDefined();
    expect(result!.status).toBe('unknown');
  });

  it('PASS with a captured tool execution stays pass (trailer is advisory)', async () => {
    selectWith(CHECK);
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
    const gate = await evaluateStrictBuildGate('build', {
      env: { ZELARI_VERIFY_PACK: '0', ZELARI_STRICT_DONE: '1' },
      emit: emitSeq(),
    });
    expect(gate.blocked).toBe(false);
    expect(gate.evaluation?.verdict).toBe('PASS');
    const result = (gate.results ?? []).find((r) => r.source === 'verify-agent');
    expect(result?.status).toBe('pass');
  });
});
