/**
 * qualityEscalation.test.ts — K4.5 (F27): escalate on quality, default OFF.
 *
 * Locks:
 *   1. DEFAULT OFF: without `ZELARI_KRAKEN_QUALITY_ESCALATION` the wrapper is
 *      pass-through — one run, NO re-run, NO scoring (scoreText spy), NO events.
 *   2. Flag ON + weak-but-ok output ⇒ EXACTLY one re-run carrying
 *      `escalation.to = 'parent-model'`; the re-run output REPLACES the weak one.
 *   3. Anti-loop: cap = 1 — a call that already carries the hint is never
 *      re-escalated (and the wrapper never recurses, so 2 calls is the ceiling
 *      even when the re-run is weak too).
 *   4. Failed re-run (ok:false OR throw) ⇒ original output KEPT and the outcome
 *      is traced on the existing host.log channel with the guard code.
 *   5. Wiring: `ScriptRunner.callTentacle` routes through the wrapper (the
 *      sub-agent dispatch seam this package owns).
 */
import { describe, expect, it } from 'vitest';
import {
  QUALITY_ESCALATION_CAP,
  QUALITY_ESCALATION_ENV,
  QUALITY_ESCALATION_GUARD,
  QUALITY_WEAKNESS_THRESHOLD,
  buildQualityEscalationLine,
  evaluateQualityEscalation,
  outputWeaknessScore,
  qualityEscalationEnabled,
  runTentacleWithQualityEscalation,
} from './qualityEscalation.js';
import { ScriptRunner } from './runtime/index.js';
import type {
  HostTentacleResult,
  PlanHostBridge,
  QualityEscalationHint,
  TentacleOptions,
} from './runtime/index.js';
import { WeaknessMeterResponseSchema } from './weakness.js';

/** Maximally weak claim: zero specificity markers, zero clauses ⇒ weakness 1. */
const WEAK_TEXT = 'All done.';
/** Marker-heavy claim ⇒ weakness ≈ 0.2 (well below the 0.85 threshold). */
const STRONG_TEXT = 'Must parse version 1.2.3 at line 42.';

const NODE: TentacleOptions = { kind: 'general', label: 'unit-42', prompt: 'do the thing' };

function okResult(result: string): HostTentacleResult {
  return { ok: true, result, durationMs: 1, worktree: null };
}

/** Fake dispatch capturing every call (with its hint) in order. */
function makeRun(
  results: readonly HostTentacleResult[],
  opts: { throwOn?: number } = {},
) {
  const calls: { node: TentacleOptions; escalation?: QualityEscalationHint }[] = [];
  const run: PlanHostBridge['runTentacle'] = async (args) => {
    calls.push({
      node: args.node,
      ...(args.escalation ? { escalation: args.escalation } : {}),
    });
    if (opts.throwOn === calls.length) throw new Error('host exploded');
    return results[calls.length - 1] ?? results[results.length - 1]!;
  };
  return { run, calls };
}

describe('qualityEscalationEnabled (K4.5/F27 opt-in)', () => {
  it('pins the documented env name', () => {
    expect(QUALITY_ESCALATION_ENV).toBe('ZELARI_KRAKEN_QUALITY_ESCALATION');
    expect(QUALITY_ESCALATION_CAP).toBe(1);
  });

  it('is DEFAULT OFF (empty env, garbage, explicit 0)', () => {
    expect(qualityEscalationEnabled({})).toBe(false);
    expect(qualityEscalationEnabled({ [QUALITY_ESCALATION_ENV]: '0' })).toBe(false);
    expect(qualityEscalationEnabled({ [QUALITY_ESCALATION_ENV]: 'off' })).toBe(false);
    expect(qualityEscalationEnabled({ [QUALITY_ESCALATION_ENV]: '2' })).toBe(false);
  });

  it('turns on only for explicit opt-in values', () => {
    expect(qualityEscalationEnabled({ [QUALITY_ESCALATION_ENV]: '1' })).toBe(true);
    expect(qualityEscalationEnabled({ [QUALITY_ESCALATION_ENV]: 'true' })).toBe(true);
    expect(qualityEscalationEnabled({ [QUALITY_ESCALATION_ENV]: 'yes' })).toBe(true);
  });
});

describe('evaluateQualityEscalation (pure policy)', () => {
  it('escalates only on enabled + ok + first-run + weak output', () => {
    expect(
      evaluateQualityEscalation({
        enabled: true,
        ok: true,
        alreadyRerun: false,
        weaknessScore: 0.95,
      }),
    ).toEqual({ escalate: true, reason: 'weak-output', threshold: QUALITY_WEAKNESS_THRESHOLD });
  });

  it('encodes the guards in order: disabled, already-rerun, run-failed', () => {
    const base = { ok: true, alreadyRerun: false, weaknessScore: 1 };
    expect(evaluateQualityEscalation({ ...base, enabled: false }).reason).toBe('disabled');
    expect(
      evaluateQualityEscalation({ ...base, enabled: true, alreadyRerun: true }).reason,
    ).toBe('already-rerun'); // anti-loop wins even at weakness 1
    expect(evaluateQualityEscalation({ enabled: true, ok: false, alreadyRerun: false, weaknessScore: 1 }).reason).toBe(
      'run-failed',
    );
  });

  it('keeps a strong-enough output and honours a custom threshold', () => {
    const strong = evaluateQualityEscalation({
      enabled: true,
      ok: true,
      alreadyRerun: false,
      weaknessScore: 0.2,
    });
    expect(strong).toEqual({ escalate: false, reason: 'strong-enough', threshold: QUALITY_WEAKNESS_THRESHOLD });
    expect(
      evaluateQualityEscalation({
        enabled: true,
        ok: true,
        alreadyRerun: false,
        weaknessScore: 0.3,
        threshold: 0.25,
      }).escalate,
    ).toBe(true);
  });
});

describe('outputWeaknessScore (weaknessMeter + heuristic signals)', () => {
  it('scores weak text near 1 and marker-heavy text near 0', () => {
    expect(outputWeaknessScore({ text: WEAK_TEXT })).toBeGreaterThan(0.85);
    expect(outputWeaknessScore({ text: STRONG_TEXT })).toBeLessThan(0.5);
    expect(outputWeaknessScore({ text: '' })).toBe(1);
  });

  it('a weaknessMeter response wins over the text heuristic', () => {
    const meter = WeaknessMeterResponseSchema.parse({ specificity: 0.1, assumptions: ['x'] });
    expect(outputWeaknessScore({ text: STRONG_TEXT, meter })).toBeCloseTo(0.9, 5);
  });
});

describe('runTentacleWithQualityEscalation — DEFAULT OFF', () => {
  it('is a pass-through: one run, no re-run, no scoring, no events', async () => {
    const { run, calls } = makeRun([okResult(WEAK_TEXT)]);
    let scored = 0;
    const lines: string[] = [];
    const out = await runTentacleWithQualityEscalation({
      run,
      node: NODE,
      parentCwd: '/repo',
      sessionId: 's1',
      env: {}, // flag absent
      scoreText: (text) => {
        scored += 1;
        return 1;
      },
      log: (line) => lines.push(line),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.escalation).toBeUndefined();
    expect(scored).toBe(0); // zero overhead: the weak output is never even scored
    expect(lines).toEqual([]);
    expect(out).toEqual({ result: okResult(WEAK_TEXT), outcome: 'none', reason: 'disabled', threshold: QUALITY_WEAKNESS_THRESHOLD });
    expect(out.result.result).toBe(WEAK_TEXT);
  });
});

describe('runTentacleWithQualityEscalation — flag ON', () => {
  const ON = { [QUALITY_ESCALATION_ENV]: '1' };

  it('weak output ⇒ EXACTLY one re-run on the parent model, output replaced', async () => {
    const { run, calls } = makeRun([okResult(WEAK_TEXT), okResult(STRONG_TEXT)]);
    const lines: string[] = [];
    const out = await runTentacleWithQualityEscalation({
      run,
      node: NODE,
      parentCwd: '/repo',
      sessionId: 's1',
      env: ON,
      log: (line) => lines.push(line),
    });
    expect(calls).toHaveLength(2); // original + exactly one re-run
    expect(calls[0]!.escalation).toBeUndefined();
    expect(calls[1]!.escalation).toEqual({
      to: 'parent-model',
      reason: 'weak-output',
      weaknessScore: out.weaknessScore,
      threshold: QUALITY_WEAKNESS_THRESHOLD,
    });
    expect(out.outcome).toBe('replaced');
    expect(out.reason).toBe('weak-output');
    expect(out.result.result).toBe(STRONG_TEXT); // the re-run supersedes the weak output
    expect(lines.some((l) => l.includes(`${QUALITY_ESCALATION_GUARD}] rerun on parent model`))).toBe(true);
    expect(lines.some((l) => l.includes(`${QUALITY_ESCALATION_GUARD}] replaced weak output`))).toBe(true);
  });

  it('strong output ⇒ no re-run at all', async () => {
    const { run, calls } = makeRun([okResult(STRONG_TEXT)]);
    const out = await runTentacleWithQualityEscalation({
      run,
      node: NODE,
      parentCwd: '/repo',
      sessionId: 's1',
      env: ON,
    });
    expect(calls).toHaveLength(1);
    expect(out.outcome).toBe('none');
    expect(out.reason).toBe('strong-enough');
    expect(out.result.result).toBe(STRONG_TEXT);
  });

  it('ANTI-LOOP: a call carrying the hint is never escalated again (cap = 1)', async () => {
    const { run, calls } = makeRun([okResult(WEAK_TEXT)]);
    const hint: QualityEscalationHint = {
      to: 'parent-model',
      reason: 'weak-output',
      weaknessScore: 0.9,
      threshold: QUALITY_WEAKNESS_THRESHOLD,
    };
    const out = await runTentacleWithQualityEscalation({
      run,
      node: NODE,
      parentCwd: '/repo',
      sessionId: 's1',
      env: ON,
      escalation: hint,
    });
    expect(calls).toHaveLength(1); // weak output, but this IS the re-run
    expect(calls[0]!.escalation).toEqual(hint); // hint passes through untouched
    expect(out.outcome).toBe('none');
    expect(out.reason).toBe('already-rerun');
  });

  it('ANTI-LOOP: a still-weak re-run stops at 2 calls total (never recurses)', async () => {
    const { run, calls } = makeRun([okResult(WEAK_TEXT), okResult(WEAK_TEXT)]);
    const out = await runTentacleWithQualityEscalation({
      run,
      node: NODE,
      parentCwd: '/repo',
      sessionId: 's1',
      env: ON,
    });
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => c.escalation)).toHaveLength(1);
    expect(out.outcome).toBe('replaced'); // weak, but the only re-run's output wins
  });

  it('failed re-run (ok:false) keeps the ORIGINAL output and traces the event', async () => {
    const { run, calls } = makeRun([okResult(WEAK_TEXT), { ok: false, error: 're-run died' }]);
    const lines: string[] = [];
    const out = await runTentacleWithQualityEscalation({
      run,
      node: NODE,
      parentCwd: '/repo',
      sessionId: 's1',
      env: ON,
      log: (line) => lines.push(line),
    });
    expect(calls).toHaveLength(2);
    expect(out.outcome).toBe('kept-original');
    expect(out.result.result).toBe(WEAK_TEXT); // weak-but-usable work is never destroyed
    expect(out.result.ok).toBe(true);
    expect(lines.some((l) => l.includes(`${QUALITY_ESCALATION_GUARD}] kept original output`))).toBe(true);
    expect(lines.some((l) => l.includes('re-run died'))).toBe(true);
  });

  it('throwing re-run keeps the ORIGINAL output and traces the event', async () => {
    const { run, calls } = makeRun([okResult(WEAK_TEXT)], { throwOn: 2 });
    const lines: string[] = [];
    const out = await runTentacleWithQualityEscalation({
      run,
      node: NODE,
      parentCwd: '/repo',
      sessionId: 's1',
      env: ON,
      log: (line) => lines.push(line),
    });
    expect(calls).toHaveLength(2);
    expect(out.outcome).toBe('kept-original');
    expect(out.result.result).toBe(WEAK_TEXT);
    expect(lines.some((l) => l.includes('host exploded'))).toBe(true);
  });

  it('an ERRORED run is never escalated (error failover owns that path)', async () => {
    const { run, calls } = makeRun([{ ok: false, error: 'boom' }]);
    const out = await runTentacleWithQualityEscalation({
      run,
      node: NODE,
      parentCwd: '/repo',
      sessionId: 's1',
      env: ON,
    });
    expect(calls).toHaveLength(1);
    expect(out.outcome).toBe('none');
    expect(out.reason).toBe('run-failed');
  });
});

describe('ScriptRunner wiring (sub-agent dispatch seam)', () => {
  function makeHost(results: readonly HostTentacleResult[]) {
    const calls: { escalation?: QualityEscalationHint }[] = [];
    const lines: string[] = [];
    const host: PlanHostBridge = {
      runTentacle: async (args) => {
        calls.push(args.escalation ? { escalation: args.escalation } : {});
        return results[calls.length - 1] ?? results[results.length - 1]!;
      },
      mergeWorktrees: async () => ({ merged: [], conflicts: [], ok: true }),
      log: (line) => lines.push(line),
      saveSnapshot: async () => '/tmp/snap.json',
      signal: () => undefined,
    };
    return { host, calls, lines };
  }

  function freshRunner(host: PlanHostBridge) {
    const runner = new ScriptRunner({
      host,
      goal: 'g',
      graphId: 'g-1',
      parentCwd: '/repo',
      sessionId: 's1',
    });
    return runner.buildSdk();
  }

  it('DEFAULT OFF: a weak tentacle output flows through untouched (1 host call)', async () => {
    const previous = process.env[QUALITY_ESCALATION_ENV];
    delete process.env[QUALITY_ESCALATION_ENV];
    try {
      const { host, calls, lines } = makeHost([okResult(WEAK_TEXT)]);
      const sdk = freshRunner(host);
      const ref = await sdk.tentacle(NODE);
      expect(calls).toHaveLength(1);
      expect(ref.findings).toBe(WEAK_TEXT);
      expect(lines).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[QUALITY_ESCALATION_ENV];
      else process.env[QUALITY_ESCALATION_ENV] = previous;
    }
  });

  it('flag ON: a weak tentacle is re-run once on the parent model and the ref is replaced', async () => {
    const previous = process.env[QUALITY_ESCALATION_ENV];
    process.env[QUALITY_ESCALATION_ENV] = '1';
    try {
      const { host, calls, lines } = makeHost([okResult(WEAK_TEXT), okResult(STRONG_TEXT)]);
      const sdk = freshRunner(host);
      const ref = await sdk.tentacle(NODE);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.escalation?.to).toBe('parent-model');
      expect(ref.findings).toBe(STRONG_TEXT); // TentacleRef carries the re-run's output
      expect(lines.some((l) => l.includes(QUALITY_ESCALATION_GUARD))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env[QUALITY_ESCALATION_ENV];
      else process.env[QUALITY_ESCALATION_ENV] = previous;
    }
  });
});

describe('buildQualityEscalationLine', () => {
  it('prefixes the stable guard code on every event shape', () => {
    const base = { label: 'unit-42', weaknessScore: 1, threshold: 0.85 };
    expect(buildQualityEscalationLine({ outcome: 'rerun', ...base })).toMatch(
      new RegExp(`^\\[${QUALITY_ESCALATION_GUARD}\\] rerun on parent model`),
    );
    expect(buildQualityEscalationLine({ outcome: 'replaced', ...base })).toContain('replaced weak output');
    expect(
      buildQualityEscalationLine({ outcome: 'kept-original', ...base, error: 'x' }),
    ).toContain('kept original output');
  });
});
