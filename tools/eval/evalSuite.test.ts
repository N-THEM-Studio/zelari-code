/**
 * tools/eval/evalSuite.test.ts — 2.6 Track A/B eval-harness tests
 * (doc §26.6 anchor runner, §26.7 regression gate, §15.4 pareto,
 * §16 change classification + targeted anchors).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAnchor, type AgentRunner } from './anchorRunner.ts';
import { loadAnchors, anchorsOfTier } from './anchorLoader.ts';
import { evaluateRegressionGate, summarizeCost } from './regressionGate.ts';
import { RETENTION_PRESETS } from './retentionPolicy.ts';
import { formatGateReport, formatParetoReport } from './report.ts';
import { addCost, zeroCost } from './cost.ts';
import type { AnchorRunRecord } from './types.ts';
import { AnchorManifestSchema } from './types.ts';

const ANCHORS_DIR = path.resolve(import.meta.dirname, '../../eval/anchors');

function rec(anchorId: string, result: AnchorRunRecord['result'], costUsd = 0.1): AnchorRunRecord {
  return {
    runId: 'r',
    anchorId,
    anchorVersion: 1,
    harnessManifestHash: 'h',
    resourcePolicyHash: 'p',
    result,
    verified: result === 'pass',
    cost: { ...zeroCost(), modelCostUsd: costUsd, toolCalls: 5, wallMs: 60_000 },
    exitCode: result === 'pass' ? 0 : 1,
    recordedAt: '2026-01-01T00:00:00Z',
  };
}

const okRunner: AgentRunner = () => ({ ok: true, toolCalls: 2, wallMs: 100 });

/** Simulates an agent that actually fixes the workspace (writes the fix). */
const fixingRunner: AgentRunner = (anchor, workspaceDir) => {
  const target = anchor.fixture.files[0];
  if (target?.path === 'sum.js') {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(
      require('node:path').join(workspaceDir, 'sum.js'),
      target.content.replace('a - b', 'a + b'),
      'utf8',
    );
  }
  return { ok: true, toolCalls: 2, wallMs: 100 };
};

describe('anchor runner (§26.6)', () => {
  it('loads the bootstrap anchor set (JSON+zod) with tiers', () => {
    const anchors = loadAnchors(ANCHORS_DIR);
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    expect(anchorsOfTier(anchors, 0).length).toBeGreaterThanOrEqual(1);
    expect(anchorsOfTier(anchors, 1).length).toBeGreaterThanOrEqual(2);
  });

  it('pass: fixture + ok agent + green checks → verified record', async () => {
    const anchor = AnchorManifestSchema.parse(loadAnchors(ANCHORS_DIR)[0]);
    const record = await runAnchor(anchor, {
      runner: fixingRunner,
      workspaceRoot: mkdtempSync(path.join(tmpdir(), 'anchor-')),
    });
    expect(record.result).toBe('pass');
    expect(record.verified).toBe(true);
    expect(record.reason).toBeUndefined();
  });

  it('blocked: agent over tool budget → budget-exceeded, not fail', async () => {
    const anchor = AnchorManifestSchema.parse(loadAnchors(ANCHORS_DIR)[0]);
    const record = await runAnchor(anchor, {
      runner: () => ({ ok: true, toolCalls: 999, wallMs: 50 }),
      workspaceRoot: mkdtempSync(path.join(tmpdir(), 'anchor-')),
    });
    expect(record.result).toBe('blocked');
    expect(record.reason).toBe('budget-exceeded-tool-calls');
    expect(record.verified).toBe(false);
  });

  it('fail: checks red → checks-failed with detail', async () => {
    const anchor = AnchorManifestSchema.parse({ ...loadAnchors(ANCHORS_DIR)[0], success: [{ command: 'node definitely-missing.mjs' }] });
    const record = await runAnchor(anchor, {
      runner: okRunner,
      workspaceRoot: mkdtempSync(path.join(tmpdir(), 'anchor-')),
    });
    expect(record.result).toBe('fail');
    expect(record.reason).toBe('checks-failed');
  });
});

describe('regression gate (§26.7)', () => {
  const base = [rec('a1', 'pass'), rec('a2', 'pass'), rec('a3', 'fail')];

  it('stable preset: zero regressions → COMMIT', () => {
    const cmp = evaluateRegressionGate({
      manifestHash: 'cand',
      baseline: base,
      candidate: [rec('a1', 'pass'), rec('a2', 'pass'), rec('a3', 'pass')],
      currentSuite: { passed: 10, total: 10 },
      policy: RETENTION_PRESETS.stable,
    });
    expect(cmp.decision).toBe('COMMIT');
    expect(cmp.result.anchors.improvements.map((i) => i.anchorId)).toEqual(['a3']);
  });

  it('stable preset: one regression → REJECT', () => {
    const cmp = evaluateRegressionGate({
      manifestHash: 'cand',
      baseline: base,
      candidate: [rec('a1', 'fail'), rec('a2', 'pass'), rec('a3', 'fail')],
      currentSuite: { passed: 10, total: 10 },
      policy: RETENTION_PRESETS.stable,
    });
    expect(cmp.decision).toBe('REJECT');
    expect(cmp.result.anchors.regressions.map((r) => r.anchorId)).toEqual(['a1']);
  });

  it('experimental preset tolerates exactly one regression', () => {
    const cmp = evaluateRegressionGate({
      manifestHash: 'cand',
      baseline: base,
      candidate: [rec('a1', 'fail'), rec('a2', 'pass'), rec('a3', 'pass')],
      currentSuite: { passed: 10, total: 10 },
      policy: RETENTION_PRESETS.experimental,
    });
    expect(cmp.decision).toBe('COMMIT');
  });

  it('validity failure ALWAYS rejects, whatever the preset', () => {
    for (const policy of Object.values(RETENTION_PRESETS)) {
      const cmp = evaluateRegressionGate({
        manifestHash: 'cand',
        baseline: base,
        candidate: base,
        currentSuite: { passed: 10, total: 10 },
        validityViolations: ['SEQ_NOT_MONOTONIC at 7'],
        policy,
      });
      expect(cmp.decision).toBe('REJECT');
    }
  });

  it('cost policy violation is reported (cost/solve +72% style)', () => {
    const cmp = evaluateRegressionGate({
      manifestHash: 'cand',
      baseline: [rec('a1', 'pass', 0.18)],
      candidate: [rec('a1', 'pass', 0.31)],
      currentSuite: { passed: 10, total: 10 },
      policy: { ...RETENTION_PRESETS.stable, maxCostPerSolveIncreasePct: 50 },
    });
    expect(cmp.decision).toBe('REJECT');
    expect(cmp.reasons.join(' ')).toMatch(/cost\/solve \+/);
  });

  it('gate report renders the §8.6 shape ending in RESULT/decision', () => {
    const cmp = evaluateRegressionGate({
      manifestHash: 'abcdef1234',
      baseline: [rec('a1', 'pass')],
      candidate: [rec('a1', 'fail')],
      currentSuite: { passed: 18, total: 20 },
      policy: RETENTION_PRESETS.stable,
    });
    const text = formatGateReport(cmp, { anchorsPassed: 1, anchorsTotal: 1, costPerVerifiedSolve: 0.18 });
    expect(text).toContain('RESULT:');
    expect(text.trim().endsWith('REJECT')).toBe(true);
    expect(text).toContain('1/1 → 0/1');
  });
});

describe('unified cost metric (§15)', () => {
  it('cost aggregations include cache hits and stay null-safe at zero solves', () => {
    const summary = summarizeCost([rec('a1', 'pass', 0.2), rec('a2', 'blocked', 0.1)]);
    expect(summary.verifiedSolves).toBe(1);
    expect(summary.costPerVerifiedSolve).toBeCloseTo(0.3, 5);
    const empty = summarizeCost([]);
    expect(empty.costPerVerifiedSolve).toBeNull();
    expect(addCost(zeroCost(), zeroCost()).modelCostUsd).toBe(0);
  });

  it('pareto report: higher solve rate never auto-promotes (note present)', () => {
    const text = formatParetoReport([
      { candidate: 'A', solveRatePct: 70, costPerVerifiedSolve: 0.18, wallMsPerSolve: 82_000 },
      { candidate: 'B', solveRatePct: 72, costPerVerifiedSolve: 0.37, wallMsPerSolve: 151_000 },
    ]);
    expect(text).toContain('$0.18');
    expect(text).toContain('$0.37');
    expect(text).toContain('never implies promotion');
  });
});
