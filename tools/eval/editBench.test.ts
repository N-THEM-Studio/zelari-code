/**
 * tools/eval/editBench.test.ts — t79 pure-part tests: deterministic set,
 * balance/shape invariants, arm contracts, summary math, delta report.
 * No network, no CLI spawn (live A/B is runEditBench.ts, integration).
 */

import { describe, expect, it } from 'vitest';
import type { ArmRunRecord } from './arms/types.ts';
import {
  EDIT_BENCH_CASES,
  type ArmSummary,
  editBenchArms,
  etaMinutesFrom,
  generateEditBenchSet,
  modelPinEnv,
  passRateDeltaPp,
  renderDeltaReport,
  summariesToArmList,
  summarizeArm,
} from './editBench.ts';

function rec(armId: string, over: Partial<ArmRunRecord['metrics']>): ArmRunRecord {
  return {
    armId,
    caseId: 'c',
    metrics: {
      passed: true,
      durationMs: 1000,
      modelCalls: 1,
      toolCalls: 3,
      toolFailures: 0,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      tentacles: 0,
      retries: 0,
      verificationFailures: 0,
      guardWarnings: 0,
      compactions: 0,
      spillCount: 0,
      recoveryReads: 0,
      ...over,
    },
    ndjsonLines: 10,
  };
}

describe('generateEditBenchSet', () => {
  it('is deterministic: same seed → identical 200 cases', () => {
    const a = generateEditBenchSet();
    const b = generateEditBenchSet();
    expect(a).toHaveLength(EDIT_BENCH_CASES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seed → different set (seed actually drives content)', () => {
    const a = generateEditBenchSet(0x00ad33, 40);
    const b = generateEditBenchSet(0x00dead, 40);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('is balanced: 10 families × 20, 100 ts + 100 py, unique ids', () => {
    const set = generateEditBenchSet();
    const byFamily = new Map<string, number>();
    let ts = 0;
    let py = 0;
    for (const c of set) {
      byFamily.set(c.family, (byFamily.get(c.family) ?? 0) + 1);
      if (c.language === 'ts') ts++;
      else py++;
    }
    expect(byFamily.size).toBe(10);
    for (const n of byFamily.values()) expect(n).toBe(20);
    expect(ts).toBe(100);
    expect(py).toBe(100);
    expect(new Set(set.map((c) => c.id)).size).toBe(EDIT_BENCH_CASES);
  });

  it('every case: task + non-empty fixture + success command per language', () => {
    for (const c of generateEditBenchSet()) {
      expect(c.task.length).toBeGreaterThan(20);
      expect(c.files.length).toBe(2);
      for (const f of c.files) expect(f.content.length).toBeGreaterThan(10);
      expect(c.success).toHaveLength(1);
      expect(c.success[0].expectExit).toBe(0);
      if (c.language === 'ts') expect(c.success[0].command).toContain('--experimental-strip-types t.mts');
      else expect(c.success[0].command).toContain('python t.py');
    }
  });

  it('every template FAILS pre-patch (broken source contradicts the test)', () => {
    const set = generateEditBenchSet();
    const anchors: Record<string, RegExp> = {
      'ts-null-guard': /xs\[0\]\.value;/,
      'ts-off-by-one': /i <= xs\.length/,
      'ts-rename-export': /legacyCompute/,
      'ts-add-default-param': /'v' \+ name;/,
      'ts-extract-const': /qty \* \d+\.\d{2};/,
      'py-null-guard': /xs\[0\]\['value'\]/,
      'py-off-by-one': /range\(len\(xs\) \+ 1\)/,
      'py-rename-def': /legacy_compute/,
      'py-add-default-param': /'v' \+ name/,
      'py-extract-const': /qty \* \d+\.\d{2}/,
    };
    for (const c of set) {
      const mod = c.files.find((f) => !f.path.startsWith('t.'))?.content ?? '';
      expect(mod, c.id).toMatch(anchors[c.family]);
    }
  });
});

describe('arms + model pinning', () => {
  it('exposes baseline (legacy worktree) and candidate (current tree)', () => {
    const arms = editBenchArms();
    expect(arms.map((a) => a.armId)).toEqual(['legacy-relocating', 'anchored-edit']);
    expect(arms[0].cliEntry).toBeNull(); // runner fills it from the git worktree
    expect(arms[1].cliEntry).toBe('bin/zelari-code.js');
  });

  it('pins the SAME cheap model on every routing seam for both arms', () => {
    const env = modelPinEnv('test-cheap-1');
    expect(env.ZELARI_KRAKEN_EXPLORE_MODEL).toBe('test-cheap-1');
    expect(env.ZELARI_KRAKEN_GENERAL_MODEL).toBe('test-cheap-1');
    expect(env.ZELARI_KRAKEN_VERIFY_MODEL).toBe('test-cheap-1');
  });
});

describe('summarizeArm + renderDeltaReport', () => {
  it('computes first-shot pass rate and averages', () => {
    const runs = [
      rec('a', { inputTokens: 100, outputTokens: 40, toolCalls: 4, retries: 1 }),
      rec('a', { passed: false, inputTokens: 200, outputTokens: 60, toolCalls: 6, retries: 3 }),
      rec('a', { inputTokens: 300, outputTokens: 80, toolCalls: 8, retries: 2 }),
    ];
    const s: ArmSummary = summarizeArm('a', runs, 2);
    expect(s.runs).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.firstShotPassRate).toBeCloseTo(2 / 3);
    expect(s.avgInputTokens).toBe(200);
    expect(s.avgOutputTokens).toBe(60);
    expect(s.avgToolCalls).toBeCloseTo(6);
    expect(s.avgRetries).toBeCloseTo(2);
    expect(s.parseErrorFiles).toBe(2);
  });

  it('empty runs → zeros, never NaN', () => {
    const s = summarizeArm('a', [], 0);
    expect(s.runs).toBe(0);
    expect(s.firstShotPassRate).toBe(0);
    expect(s.avgInputTokens).toBe(0);
  });

  it('renders a publishable delta table with both arms', () => {
    const b = summarizeArm('legacy-relocating', [rec('legacy-relocating', { passed: false })], 5);
    const c = summarizeArm('anchored-edit', [rec('anchored-edit')], 0);
    const md = renderDeltaReport({ seed: 1, count: 200, reps: 3, model: 'm', baselineRef: 'v2.23.0', gitCommit: 'abc' }, b, c);
    expect(md).toContain('# ADR-0033 edit bench — delta report');
    expect(md).toContain('first-shot pass-rate | 0.0% | 100.0%');
    expect(md).toContain('residual parse-error files | 5 | 0');
    expect(md).toContain('v2.23.0');
    expect(md).toContain('l\'ADR si riapre');
  });
});

describe('etaMinutesFrom', () => {
  it('estimates linear remaining time', () => {
    // 50 done in 10 min → 0.2 min per case × 50 remaining = 10 min
    expect(etaMinutesFrom(50, 100, 10 * 60_000)).toBeCloseTo(10);
  });

  it('returns null when not estimable (no progress, complete, no elapsed, bad total)', () => {
    expect(etaMinutesFrom(0, 100, 60_000)).toBeNull();
    expect(etaMinutesFrom(100, 100, 60_000)).toBeNull();
    expect(etaMinutesFrom(50, 100, 0)).toBeNull();
    expect(etaMinutesFrom(50, 0, 60_000)).toBeNull();
  });
});

describe('passRateDeltaPp', () => {
  it('computes percentage-point delta candidate vs baseline', () => {
    const out = passRateDeltaPp([
      { armId: 'legacy-relocating', passRate: 0.62 },
      { armId: 'anchored-edit', passRate: 0.71 },
    ]);
    expect(out).not.toBeNull();
    expect(out?.baseline).toBe(0.62);
    expect(out?.candidate).toBe(0.71);
    expect(out?.deltaPp).toBeCloseTo(9);
  });

  it('returns null when either arm is missing', () => {
    expect(passRateDeltaPp([{ armId: 'anchored-edit', passRate: 1 }])).toBeNull();
    expect(passRateDeltaPp([{ armId: 'legacy-relocating', passRate: 1 }])).toBeNull();
    expect(passRateDeltaPp([])).toBeNull();
  });

  it('honors custom arm ids', () => {
    const out = passRateDeltaPp(
      [
        { armId: 'base', passRate: 0.5 },
        { armId: 'cand', passRate: 0.25 },
      ],
      'cand',
      'base',
    );
    expect(out?.deltaPp).toBeCloseTo(-25);
  });
});

describe('summariesToArmList', () => {
  it('accetta la shape reale del manifest ({ baseline, candidate })', () => {
    const out = summariesToArmList({
      baseline: { armId: 'legacy-relocating', passRate: 0.5 },
      candidate: { armId: 'anchored-edit', passRate: 0.59 },
    });
    expect(out).toHaveLength(2);
    expect(passRateDeltaPp(out)?.deltaPp).toBeCloseTo(9);
  });

  it('passa attraverso gli array validi e scarta le righe malformate', () => {
    const out = summariesToArmList([{ armId: 'a', passRate: 1 }, { armId: 'b' }, 'nope']);
    expect(out).toHaveLength(1);
    expect(out[0]?.armId).toBe('a');
  });

  it('restituisce lista vuota su input inutilizzabile', () => {
    expect(summariesToArmList(null)).toHaveLength(0);
    expect(summariesToArmList('nope')).toHaveLength(0);
    expect(summariesToArmList({})).toHaveLength(0);
  });
});
