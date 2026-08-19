/**
 * verifierAdvisoryLock — Exit-2.3 lock tests (ADR-0023 × strict BUILD gate).
 *
 * Locks the composition rule the 2.0 verification contract depends on:
 * when the optional LLM verifier is ACTIVE, the deterministic CompletionPolicy
 * stays the FINAL authority of the Kraken BUILD gate.
 *
 *   Caso 1 — deterministic criterion UNKNOWN/FAIL + verifier CONFIRMED
 *            → no clean success (BLOCKED / REPAIR_REQUIRED, strict exit ≠ 0).
 *   Caso 2 — deterministic criteria PASS + verifier REJECTED
 *            → the deterministic verdict is NOT rewritten; the review is
 *              recorded in the spine as advisory only (exit stays 0).
 *
 * The verifier may add information, never authority. Breaking either test
 * below is a contract regression, not a refactor.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VERIFIER_CONFIG,
  VerifierService,
  type VerifierModelResponse,
} from '@zelari/core/verification';
import {
  evaluateStrictBuildGate,
  krakenResultsToContract,
  strictGateEventPayload,
  strictGateExitCode,
} from './verificationBridge.js';
import {
  getKrakenCheckResults,
  krakenRequiredChecks,
  resetKrakenCandidates,
  setKrakenCheckResults,
  setKrakenSelection,
} from './candidateRegistry.js';

const CHECKS = ['typecheck passes', 'suite verde'];

function selectWithChecks(): void {
  resetKrakenCandidates();
  setKrakenSelection({
    status: 'selected',
    winnerIndex: 1,
    rationale: 'stronger evidence',
    requiredChecks: CHECKS,
    degraded: false,
    verifier: null,
    judgedBy: 'llm',
  });
}

/** Enabled verifier with a fixed test model; `reply` is the raw LLM answer. */
function activeVerifier(reply: string, emitted: unknown[]): VerifierService {
  return new VerifierService({
    callModel: async (): Promise<VerifierModelResponse> => ({
      text: reply,
      provider: 'test',
      model: 'verifier-1',
    }),
    config: {
      ...DEFAULT_VERIFIER_CONFIG,
      enabled: true,
      model: { mode: 'fixed', provider: 'test', model: 'verifier-1' },
    },
    emit: async (input) => {
      emitted.push(input);
    },
  });
}

const CONFIRMED = '{"verdict":"confirmed","score":0.97,"rationale":"looks done to me"}';
const REJECTED = '{"verdict":"rejected","score":0.05,"rationale":"not convinced"}';

/** Contract the runtime hands to BOTH the strict gate and the verifier. */
function currentContract(): ReturnType<typeof krakenResultsToContract> {
  return krakenResultsToContract(krakenRequiredChecks(), getKrakenCheckResults());
}

let envPrev: string | undefined;

beforeEach(() => {
  envPrev = process.env.ZELARI_STRICT_DONE;
  process.env.ZELARI_STRICT_DONE = '1';
  resetKrakenCandidates();
});

afterEach(() => {
  if (envPrev === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = envPrev;
  resetKrakenCandidates();
});

describe('Exit-2.3 lock: verifier LLM active cannot change the completion authority', () => {
  it('Caso 1a — unknown criterion + verifier CONFIRMED → BLOCKED, strict exit 4 (advisory recorded, never applied)', async () => {
    selectWithChecks();
    setKrakenCheckResults([]); // verify tentacle never reported → unknown ≠ pass

    const emitted: unknown[] = [];
    const verifier = activeVerifier(CONFIRMED, emitted);
    const review = await verifier.reviewCompletion({
      summary: 'done: all green',
      results: currentContract().results,
    });
    const gate = await evaluateStrictBuildGate('build');

    // The review itself may say "confirmed" — it is advisory information only.
    expect(review.verdict).toBe('confirmed');
    expect(review.effectiveModel).toEqual({
      mode: 'fixed',
      provider: 'test',
      model: 'verifier-1',
    });

    // The deterministic policy stays the final authority: unknown → BLOCKED.
    expect(gate.strict).toBe(true);
    expect(gate.evaluation!.verdict).toBe('BLOCKED');
    expect(gate.blocked).toBe(true);
    expect(strictGateExitCode(gate)).toBe(4);
    expect(strictGateEventPayload(gate).verdict).toBe('BLOCKED');

    // The spine keeps the verifier review as a separate advisory record.
    expect(emitted).toHaveLength(1);
    const data = (emitted[0] as { data: Record<string, unknown> }).data;
    expect(data.source).toBe('verifier-model');
    expect(data.verdict).toBe('confirmed');
    expect(data.model).toBe('verifier-1');
    expect(data.selectionMode).toBe('fixed');
  });

  it('Caso 1b — FAIL criterion + verifier CONFIRMED → REPAIR_REQUIRED (fail wins), review downgraded to unknown', async () => {
    selectWithChecks();
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'pass', note: 'tsc clean' },
      { check: CHECKS[1], status: 'fail', note: 'vitest 1/2' },
    ]);

    const emitted: unknown[] = [];
    const verifier = activeVerifier(CONFIRMED, emitted);
    const review = await verifier.reviewCompletion({
      summary: 'done: mostly green',
      results: currentContract().results,
    });
    const gate = await evaluateStrictBuildGate('build');

    // The service itself refuses to confirm over a failed deterministic check.
    expect(review.verdict).toBe('unknown');
    expect(review.fallback).toBe('discrete');
    expect(review.rationale).toContain('cannot confirm');

    // And even if it had not: the policy converts fail into repair, not done.
    expect(gate.evaluation!.verdict).toBe('REPAIR_REQUIRED');
    expect(gate.blocked).toBe(true);
    expect(strictGateExitCode(gate)).toBe(4);
  });

  it('Caso 2 — deterministic PASS + verifier REJECTED → PASS untouched, exit 0, rejection recorded as advisory', async () => {
    selectWithChecks();
    setKrakenCheckResults([
      { check: CHECKS[0], status: 'pass', note: 'tsc clean' },
      { check: CHECKS[1], status: 'pass', note: 'vitest 41/41' },
    ]);

    const emitted: unknown[] = [];
    const verifier = activeVerifier(REJECTED, emitted);
    const review = await verifier.reviewCompletion({
      summary: 'done: all green',
      results: currentContract().results,
    });
    const gate = await evaluateStrictBuildGate('build');

    // The rejection is real, recorded, and advisory — it cannot dirty a
    // deterministic strict PASS (no false-block from narration either).
    expect(review.verdict).toBe('rejected');
    expect(gate.evaluation!.verdict).toBe('PASS');
    expect(gate.blocked).toBe(false);
    expect(strictGateExitCode(gate)).toBe(0);
    expect(strictGateEventPayload(gate).verdict).toBe('PASS');

    const data = (emitted[0] as { data: Record<string, unknown> }).data;
    expect(data.verdict).toBe('rejected');
    expect(data.source).toBe('verifier-model');
  });
});
