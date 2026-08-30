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
  strictEnvOverlay,
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
      // H10-fix1: the gate's env snapshot is authoritative (nativePackEnabled
      // semantics) — an explicit opt-out overlay must CARRY the mission key
      // (exactly what strictEnvOverlay({ strictDone: false }) mirrors).
      const gate = await evaluateStrictBuildGate('build', { surface: 'mission', env: { ZELARI_VERIFY_PACK: '0', ZELARI_MISSION_STRICT: '0' } });
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

describe('H10-fix1: strict knobs as a per-invocation env OVERLAY', () => {
  it('strictDoneEnabled consults an explicit env snapshot before process.env (nativePackEnabled pattern)', async () => {
    await withEnv(undefined, undefined, () => {
      // Overlay wins over the ambient process env.
      expect(strictDoneEnabled('kraken', { ZELARI_STRICT_DONE: '0' })).toBe(false);
      expect(strictDoneEnabled('mission', { ZELARI_MISSION_STRICT: '0' })).toBe(false);
      // Snapshot without the key falls through to the default-ON surface.
      expect(strictDoneEnabled('kraken', {})).toBe(true);
      expect(strictDoneEnabled('mission', {})).toBe(true);
      // Mission never reads the kraken key and vice versa.
      expect(strictDoneEnabled('mission', { ZELARI_STRICT_DONE: '0' })).toBe(true);
      expect(strictDoneEnabled('kraken', { ZELARI_MISSION_STRICT: '0' })).toBe(true);
    });
    await withEnv('0', undefined, () => {
      // Explicit '1' in the snapshot re-enables even when process.env says off…
      expect(strictDoneEnabled('kraken', { ZELARI_STRICT_DONE: '1' })).toBe(true);
      // …and an explicit snapshot is AUTHORITATIVE (nativePackEnabled(env)
      // semantics): an omitted key means the surface default (ON), not a
      // per-key fallback to the ambient '0'. Callers inherit process.env by
      // SPREADING it into the snapshot — that is exactly what
      // strictEnvOverlay(knobs) produces.
      expect(strictDoneEnabled('kraken', {})).toBe(true);
    });
  });

  it('kraken surface: ZELARI_STRICT_DONE=0 in the gate env opts THIS turn out (no process.env write)', async () => {
    await withEnv(undefined, undefined, async () => {
      selectWithChecks(CHECKS);
      setKrakenCheckResults(CHECKS.map((c) => ({ check: c, status: 'pass' as const, note: 'ok (stub)' })));
      const gate = await evaluateStrictBuildGate('build', {
        env: { ZELARI_VERIFY_PACK: '0', ZELARI_STRICT_DONE: '0' },
      });
      expect(gate.strict).toBe(false);
      expect(gate.evaluation).toBeNull();
      expect(gate.blocked).toBe(false);
    });
  });

  it('mission surface: ZELARI_MISSION_STRICT=0 in the gate env opts THIS turn out', async () => {
    await withEnv(undefined, undefined, async () => {
      selectWithChecks(CHECKS);
      setKrakenCheckResults(CHECKS.map((c) => ({ check: c, status: 'pass' as const, note: 'ok (stub)' })));
      const gate = await evaluateStrictBuildGate('build', {
        surface: 'mission',
        env: { ZELARI_VERIFY_PACK: '0', ZELARI_MISSION_STRICT: '0' },
      });
      expect(gate.strict).toBe(false);
      expect(gate.evaluation).toBeNull();
      expect(gate.blocked).toBe(false);
    });
  });

  it('strictEnvOverlay maps the tri-state knobs and NEVER mutates process.env', () => {
    const krakenBefore = process.env.ZELARI_STRICT_DONE;
    const missionBefore = process.env.ZELARI_MISSION_STRICT;

    // Omit ⇒ inherit (fresh copy of the ambient env).
    const inherit = strictEnvOverlay({});
    expect(inherit.ZELARI_STRICT_DONE).toBe(krakenBefore);
    expect(inherit.ZELARI_MISSION_STRICT).toBe(missionBefore);

    // false ⇒ '0' on BOTH keys — the repaired --no-strict-done semantic (it
    // used to write ZELARI_MISSION_STRICT=0 into process.env at parse time).
    const off = strictEnvOverlay({ strictDone: false });
    expect(off.ZELARI_STRICT_DONE).toBe('0');
    expect(off.ZELARI_MISSION_STRICT).toBe('0');

    // true ⇒ '1' on both keys.
    const on = strictEnvOverlay({ strictDone: true });
    expect(on.ZELARI_STRICT_DONE).toBe('1');
    expect(on.ZELARI_MISSION_STRICT).toBe('1');

    // missionStrict drives only the mission key.
    const missionOff = strictEnvOverlay({ missionStrict: false });
    expect(missionOff.ZELARI_MISSION_STRICT).toBe('0');
    expect(missionOff.ZELARI_STRICT_DONE).toBe(krakenBefore);

    // Explicit missionStrict wins over the strictDone mirror on the mission key.
    const both = strictEnvOverlay({ strictDone: true, missionStrict: false });
    expect(both.ZELARI_STRICT_DONE).toBe('1');
    expect(both.ZELARI_MISSION_STRICT).toBe('0');

    // The ambient env is untouched by every mapping above.
    expect(process.env.ZELARI_STRICT_DONE).toBe(krakenBefore);
    expect(process.env.ZELARI_MISSION_STRICT).toBe(missionBefore);
  });
});

// Type-level lock: the surface union is exactly the two ADR-0025 surfaces.
const _surfaceUnionLock: StrictDoneSurface[] = ['kraken', 'mission'];
void _surfaceUnionLock;
