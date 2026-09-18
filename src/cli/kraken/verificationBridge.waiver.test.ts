/**
 * K1.4 / F6 — every strict-done waiver must append a spine event.
 *
 * `--allow-unverified` / `ZELARI_STRICT_DONE=0` historically waived in
 * memory only. A later audit cannot tell a verified PASS from an opted-out
 * turn. Fail-closed: if the waiver cannot be recorded, it does not take
 * effect.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEventInput } from '@zelari/core/session';
import {
  evaluateStrictBuildGate,
  strictGateExitCode,
} from './verificationBridge.js';
import { resetKrakenCandidates } from './candidateRegistry.js';

let packPrev: string | undefined;
let strictPrev: string | undefined;
let allowPrev: string | undefined;

beforeEach(() => {
  packPrev = process.env.ZELARI_VERIFY_PACK;
  strictPrev = process.env.ZELARI_STRICT_DONE;
  allowPrev = process.env.ZELARI_ALLOW_UNVERIFIED;
  process.env.ZELARI_VERIFY_PACK = '0';
  delete process.env.ZELARI_ALLOW_UNVERIFIED;
  resetKrakenCandidates();
});

afterEach(() => {
  if (packPrev === undefined) delete process.env.ZELARI_VERIFY_PACK;
  else process.env.ZELARI_VERIFY_PACK = packPrev;
  if (strictPrev === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = strictPrev;
  if (allowPrev === undefined) delete process.env.ZELARI_ALLOW_UNVERIFIED;
  else process.env.ZELARI_ALLOW_UNVERIFIED = allowPrev;
  resetKrakenCandidates();
});

describe('K1.4 — waiver emits an append-only spine event', () => {
  it('ALLOW_UNVERIFIED on an unverified turn appends strict.waived (reason, flag, ts)', async () => {
    const emitted: SessionEventInput[] = [];
    let n = 1;
    const evaluation = await evaluateStrictBuildGate('build', {
      env: {
        ZELARI_VERIFY_PACK: '0',
        ZELARI_STRICT_DONE: '1',
        ZELARI_ALLOW_UNVERIFIED: '1',
      },
      emit: async (input) => {
        emitted.push(input);
        return { seq: n++ };
      },
    });
    expect(evaluation.unverified).toBe(true);
    const waiver = emitted.find((e) => e.kind === 'strict.waived');
    expect(waiver).toBeDefined();
    expect(waiver!.actor).toMatchObject({ type: 'system' });
    expect(waiver!.data).toMatchObject({
      reason: 'allow-unverified',
      flag: 'ZELARI_ALLOW_UNVERIFIED',
    });
    expect(typeof waiver!.data?.ts).toBe('number');
    expect(strictGateExitCode(evaluation, { ZELARI_ALLOW_UNVERIFIED: '1' })).toBe(0);
  });

  it('waiver emit failure → fail-closed (exit 4, hatch does not apply)', async () => {
    const evaluation = await evaluateStrictBuildGate('build', {
      env: {
        ZELARI_VERIFY_PACK: '0',
        ZELARI_STRICT_DONE: '1',
        ZELARI_ALLOW_UNVERIFIED: '1',
      },
      emit: async () => {
        throw new Error('spine unavailable');
      },
    });
    expect(evaluation.unverified).toBe(true);
    expect(strictGateExitCode(evaluation, { ZELARI_ALLOW_UNVERIFIED: '1' })).toBe(4);
  });

  it('ZELARI_STRICT_DONE=0 with emit appends strict.waived (strict-done-opt-out)', async () => {
    const emitted: SessionEventInput[] = [];
    await evaluateStrictBuildGate('build', {
      env: { ZELARI_VERIFY_PACK: '0', ZELARI_STRICT_DONE: '0' },
      emit: async (input) => {
        emitted.push(input);
        return { seq: 1 };
      },
    });
    const waiver = emitted.find((e) => e.kind === 'strict.waived');
    expect(waiver).toBeDefined();
    expect(waiver!.data).toMatchObject({
      reason: 'strict-done-opt-out',
      flag: 'ZELARI_STRICT_DONE',
    });
  });
});
