/*
 * tools/eval/runModelSwap.test.ts — K4.6/F28 model swap test (pure pieces +
 * CLI smoke). The live executor (executeSwap) is integration-only (real CLI +
 * provider) and is NOT exercised here — read mode and the report contract are.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareGuardCodes,
  guardCodesFromNdjson,
  loadSwapCapture,
  parseSwapArgs,
  renderSwapReport,
  summarizeSwapSide,
  type SwapCapture,
  type SwapRunCase,
} from './runModelSwap.ts';
import {
  GUARD_AB_REPORT_GUARD_CODES,
  GUARD_AB_REPORT_METRICS,
  leadModelSwapArms,
} from './arms/experiments.ts';
import { EvalArmSchema } from './arms/types.ts';

const RUNNER = path.resolve(import.meta.dirname, 'runModelSwap.ts');

function caseOf(id: string, passed: boolean, ndjson: string[]): SwapRunCase {
  return { id, passed, ndjson };
}

function captureOf(model: string, cases: SwapRunCase[]): SwapCapture {
  return {
    version: 1,
    kind: 'model-swap-capture',
    model,
    armId: 'lead-baseline',
    createdAt: '2026-01-01T00:00:00.000Z',
    cases,
  };
}

function ev(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

describe('leadModelSwapArms (K4.6/F28)', () => {
  it('swaps the lead model per arm via env diff (same pattern as the other presets)', () => {
    const arms = leadModelSwapArms({ baseline: 'model-a', candidate: 'model-b' });
    expect(arms.map((a) => a.id)).toEqual(['lead-baseline', 'lead-candidate']);
    for (const arm of arms) expect(EvalArmSchema.safeParse(arm).success).toBe(true);
    // The model rides the env diff: `--model` is per-experiment (F28).
    expect(arms[0]?.env.OPENAI_MODEL).toBe('model-a');
    expect(arms[1]?.env.OPENAI_MODEL).toBe('model-b');
    // `model` stays manifest metadata, like the schema documents.
    expect(arms[0]?.model).toBe('model-a');
    expect(arms[1]?.model).toBe('model-b');
  });
});

describe('GUARD_AB_REPORT_METRICS carries the F28 guard codes', () => {
  it('includes every degradation guard code of the typed family', () => {
    for (const code of GUARD_AB_REPORT_GUARD_CODES) {
      expect(GUARD_AB_REPORT_METRICS).toContain(code);
    }
    expect(GUARD_AB_REPORT_METRICS).toContain('tool_call_truncated');
    expect(GUARD_AB_REPORT_METRICS).toContain('guardWarnings');
  });
});

describe('guardCodesFromNdjson (F28)', () => {
  it('counts error/runtime_warning codes per code and tolerates garbage', () => {
    const codes = guardCodesFromNdjson([
      ev({ type: 'error', code: 'tool_call_truncated' }),
      ev({ type: 'error', code: 'tool_call_truncated' }),
      ev({ type: 'runtime_warning', code: 'assistant_text_loop' }),
      ev({ type: 'error', message: 'no code' }),
      ev({ type: 'error', code: '' }),
      ev({ type: 'tool_execution_start', code: 'not-a-guard' }),
      '}{',
      '',
    ]);
    expect(codes).toEqual({ tool_call_truncated: 2, assistant_text_loop: 1 });
  });

  it('returns an empty map on empty input without throwing', () => {
    expect(guardCodesFromNdjson([])).toEqual({});
  });
});

describe('summarizeSwapSide — pass-rate, guard codes, cost (RunCost)', () => {
  const capture = captureOf('model-a', [
    caseOf('case-1', true, [
      ev({ type: 'agent_start', ts: 1000 }),
      ev({ type: 'agent_end', ts: 3000, usage: { input: 500, output: 50, cached: 20 } }),
      ev({ type: 'tool_execution_start', ts: 1500 }),
      ev({ type: 'tool_execution_end', ts: 1600, status: 'ok', exitCode: 0 }),
    ]),
    caseOf('case-2', false, [
      ev({ type: 'agent_start', ts: 1000 }),
      ev({ type: 'agent_end', ts: 2000, usage: { input: 100, output: 10 } }),
      ev({ type: 'error', code: 'assistant_text_loop' }),
    ]),
  ]);

  it('aggregates pass-rate, per-code guards and RunCost token totals', () => {
    const s = summarizeSwapSide('baseline', 'model-a', capture);
    expect(s.runs).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.passRate).toBe(0.5);
    expect(s.guardCodes).toEqual({ assistant_text_loop: 1 });
    expect(s.cost.inputTokens).toBe(600);
    expect(s.cost.outputTokens).toBe(60);
    expect(s.cost.cacheHitTokens).toBe(20);
    expect(s.cost.toolCalls).toBe(1);
    expect(s.cost.wallMs).toBe(3000); // (3000-1000) + (2000-1000)
  });

  it('is honest at zero runs (pass-rate 0, empty cost)', () => {
    const s = summarizeSwapSide('candidate', 'model-b', captureOf('model-b', []));
    expect(s.passRate).toBe(0);
    expect(s.cost).toMatchObject({ inputTokens: 0, outputTokens: 0, toolCalls: 0 });
  });
});

describe('compareGuardCodes + renderSwapReport', () => {
  it('deltas fired codes and always shows the F28 family rows', () => {
    const rows = compareGuardCodes({ tool_call_truncated: 2 }, { assistant_text_loop: 1 });
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.get('tool_call_truncated')).toEqual({ code: 'tool_call_truncated', baseline: 2, candidate: 0, delta: -2 });
    expect(byCode.get('assistant_text_loop')).toEqual({ code: 'assistant_text_loop', baseline: 0, candidate: 1, delta: 1 });
    for (const code of GUARD_AB_REPORT_GUARD_CODES) expect(byCode.has(code)).toBe(true);
  });

  it('renders a report with pass-rate, guard-code delta and cost', () => {
    const baseline = summarizeSwapSide(
      'baseline',
      'model-a',
      captureOf('model-a', [caseOf('case-1', false, [ev({ type: 'error', code: 'tool_call_truncated' })])]),
    );
    const candidate = summarizeSwapSide(
      'candidate',
      'model-b',
      captureOf('model-b', [
        caseOf('case-1', true, [
          ev({ type: 'agent_start', ts: 1000 }),
          ev({ type: 'agent_end', ts: 2500, usage: { input: 300, output: 30 } }),
        ]),
      ]),
    );
    const report = renderSwapReport({ baseline, candidate });
    expect(report).toContain('pass-rate');
    expect(report).toContain('guard-code delta');
    expect(report).toContain('cost');
    expect(report).toContain('model-a');
    expect(report).toContain('model-b');
    expect(report).toContain('+100.0pp');
    expect(report).toContain('`tool_call_truncated`');
    expect(report).toContain('-1');
    expect(report).toContain('input tokens');
  });
});

describe('parseSwapArgs + loadSwapCapture', () => {
  it('parses both modes and the model flags', () => {
    const args = parseSwapArgs([
      '--baseline-model', 'm1', '--candidate-model', 'm2',
      '--fixture', 'fx', '--task', 'do it', '--timeout-ms', '5000',
    ]);
    expect(args.baselineModel).toBe('m1');
    expect(args.candidateModel).toBe('m2');
    expect(args.timeoutMs).toBe(5000);
    const read = parseSwapArgs(['--baseline-run', 'a.json', '--candidate-run', 'b.json']);
    expect(read.baselineRun).toBe('a.json');
    expect(read.candidateRun).toBe('b.json');
  });

  it('round-trips a capture file and rejects non-captures loudly', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'model-swap-'));
    const file = path.join(dir, 'baseline-capture.json');
    const capture = captureOf('model-a', [caseOf('case-1', true, [])]);
    writeFileSync(file, JSON.stringify(capture), 'utf8');
    expect(loadSwapCapture(file)).toEqual(capture);
    const bogus = path.join(dir, 'bogus.json');
    writeFileSync(bogus, JSON.stringify({ hello: 'world' }), 'utf8');
    expect(() => loadSwapCapture(bogus)).toThrow(/model-swap-capture/);
  });
});

describe('CLI smoke (acceptance)', () => {
  it('--help does not crash and shows how to pass baseline/candidate models', () => {
    const res = spawnSync(process.execPath, ['--experimental-strip-types', RUNNER, '--help'], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--baseline-model');
    expect(res.stdout).toContain('--candidate-model');
  });

  it('read mode prints a report with pass-rate, guard-code delta and cost', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'model-swap-e2e-'));
    const bFile = path.join(dir, 'baseline-capture.json');
    const cFile = path.join(dir, 'candidate-capture.json');
    writeFileSync(
      bFile,
      JSON.stringify(captureOf('model-a', [caseOf('case-1', false, [ev({ type: 'error', code: 'tool_call_truncated' })])])),
      'utf8',
    );
    writeFileSync(
      cFile,
      JSON.stringify(captureOf('model-b', [caseOf('case-1', true, [ev({ type: 'agent_start', ts: 1 })])])),
      'utf8',
    );
    const res = spawnSync(
      process.execPath,
      ['--experimental-strip-types', RUNNER, '--baseline-run', bFile, '--candidate-run', cFile],
      { encoding: 'utf8' },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('pass-rate');
    expect(res.stdout).toContain('guard-code delta');
    expect(res.stdout).toContain('cost');
  });
});
