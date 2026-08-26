/**
 * ADR-0025 lock tests — strict done defaults per surface.
 *
 * Kraken (default surface): strict gate ON by default (P0.1); ZELARI_STRICT_DONE=0|false opts out.
 * Mission: strict evidence gate ON by default; ZELARI_MISSION_STRICT=0|false
 * is the only opt-out. These defaults are product decisions, not accidents —
 * a regression here changes what "done" means for autonomous missions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateStrictBuildGate,
  strictDoneEnabled,
  type StrictDoneSurface,
} from './verificationBridge.js';
import {
  resetKrakenCandidates,
  setKrakenCheckResults,
  setKrakenSelection,
} from './candidateRegistry.js';

const CHECKS = ['mission slice keeps the spine replayable', 'export round-trips'];

function emitSeq(): (input: unknown) => Promise<{ seq: number }> {
  let n = 1;
  return async () => ({ seq: n++ });
}

function selectWithChecks(checks: string[]): void {
  resetKrakenCandidates();
  setKrakenSelection({
    status: 'selected',
    winnerIndex: 0,
    rationale: 'test',
    requiredChecks: checks,
    degraded: false,
    verifier: null,
    judgedBy: 'llm',
  });
}

let prevKraken: string | undefined;
let prevMission: string | undefined;
let prevPack: string | undefined;

/** Swap both strict envs for the duration of fn; restore in finally. */
async function withEnv<T>(
  kraken: string | undefined,
  mission: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const k = process.env.ZELARI_STRICT_DONE;
  const m = process.env.ZELARI_MISSION_STRICT;
  if (kraken === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = kraken;
  if (mission === undefined) delete process.env.ZELARI_MISSION_STRICT;
  else process.env.ZELARI_MISSION_STRICT = mission;
  try {
    return await fn();
  } finally {
    if (k === undefined) delete process.env.ZELARI_STRICT_DONE;
    else process.env.ZELARI_STRICT_DONE = k;
    if (m === undefined) delete process.env.ZELARI_MISSION_STRICT;
    else process.env.ZELARI_MISSION_STRICT = m;
  }
}

beforeEach(() => {
  prevKraken = process.env.ZELARI_STRICT_DONE;
  prevMission = process.env.ZELARI_MISSION_STRICT;
  prevPack = process.env.ZELARI_VERIFY_PACK;
  delete process.env.ZELARI_VERIFY_PACK;
  resetKrakenCandidates();
});

afterEach(() => {
  if (prevKraken === undefined) delete process.env.ZELARI_STRICT_DONE;
  else process.env.ZELARI_STRICT_DONE = prevKraken;
  if (prevMission === undefined) delete process.env.ZELARI_MISSION_STRICT;
  else process.env.ZELARI_MISSION_STRICT = prevMission;
  if (prevPack === undefined) delete process.env.ZELARI_VERIFY_PACK;
  else process.env.ZELARI_VERIFY_PACK = prevPack;
  resetKrakenCandidates();
});

describe('strictDoneEnabled defaults (ADR-0025)', () => {
  it('kraken: default ON (P0.1), opt-out via ZELARI_STRICT_DONE=0|false', async () => {
    await withEnv(undefined, undefined, () => {
      expect(strictDoneEnabled()).toBe(true);
      expect(strictDoneEnabled('kraken')).toBe(true);
    });
    await withEnv('1', undefined, () => expect(strictDoneEnabled()).toBe(true));
    await withEnv('true', undefined, () => expect(strictDoneEnabled()).toBe(true));
    await withEnv('0', undefined, () => expect(strictDoneEnabled()).toBe(false));
    await withEnv('false', undefined, () => expect(strictDoneEnabled()).toBe(false));
  });

  it('mission: default ON regardless of ZELARI_STRICT_DONE', async () => {
    await withEnv(undefined, undefined, () => expect(strictDoneEnabled('mission')).toBe(true));
    await withEnv('0', undefined, () => expect(strictDoneEnabled('mission')).toBe(true));
    await withEnv('false', undefined, () => expect(strictDoneEnabled('mission')).toBe(true));
  });

  it('mission: ZELARI_MISSION_STRICT=0|false is the only opt-out', async () => {
    await withEnv(undefined, '0', () => expect(strictDoneEnabled('mission')).toBe(false));
    await withEnv(undefined, 'false', () => expect(strictDoneEnabled('mission')).toBe(false));
    await withEnv(undefined, '1', () => expect(strictDoneEnabled('mission')).toBe(true));
    await withEnv('1', '0', () => expect(strictDoneEnabled('mission')).toBe(false));
  });
});

describe('evaluateStrictBuildGate surface wiring (ADR-0025)', () => {
  it('mission surface enforces the evidence contract by default (unknown → blocked)', async () => {
    await withEnv(undefined, undefined, async () => {
      selectWithChecks(CHECKS);
      // No check results reported → every required criterion is unknown.
      const gate = await evaluateStrictBuildGate('build', { surface: 'mission', env: { ZELARI_VERIFY_PACK: '0' } });
      expect(gate.strict).toBe(true);
      expect(gate.blocked).toBe(true);
    });
  });

  it('mission opt-out restores the legacy-only outcome', async () => {
    await withEnv(undefined, '0', async () => {
      selectWithChecks(CHECKS);
      setKrakenCheckResults(CHECKS.map((c) => ({ check: c, status: 'pass' as const, note: 'ok (stub)' })));
      const gate = await evaluateStrictBuildGate('build', { surface: 'mission', env: { ZELARI_VERIFY_PACK: '0' } });
      expect(gate.strict).toBe(false);
      expect(gate.blocked).toBe(false); // legacy gate green + no strict overlay
    });
  });

  it('kraken surface (default) enforces the evidence contract even with checks registered', async () => {
    await withEnv(undefined, undefined, async () => {
      selectWithChecks(CHECKS);
      setKrakenCheckResults(CHECKS.map((c) => ({ check: c, status: 'pass' as const, note: 'ok (stub)' })));
      // No emit → unanchored evidence → the strict default BLOCKS (false-done guard)
      const gate = await evaluateStrictBuildGate('build', { env: { ZELARI_VERIFY_PACK: '0' } });
      expect(gate.strict).toBe(true);
      expect(gate.blocked).toBe(true);
    });
  });

  it('pack default (P0.2) runs but auto-unbinds on repos without npm scripts', async () => {
    await withEnv(undefined, undefined, async () => {
      selectWithChecks([CHECKS[0]]);
      setKrakenCheckResults([
        { check: CHECKS[0], status: 'pass', note: 'spine replay ok (stub)' },
      ]);
      const gate = await evaluateStrictBuildGate('build', {
        surface: 'mission',
        emit: emitSeq(),
        cwd: 'Z:/__no_such_repo__', // no package.json → pack binds nothing
      });
      expect(gate.strict).toBe(true);
      expect(gate.native).toBeNull();
      expect(gate.blocked).toBe(false); // pass with event-backed note → PASS
    });
  });
});

// Type-level lock: the surface union is exactly the two ADR-0025 surfaces.
const _surfaceUnionLock: StrictDoneSurface[] = ['kraken', 'mission'];
void _surfaceUnionLock;
