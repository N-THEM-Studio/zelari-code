/**
 * tools/eval/arms/arms.test.ts — unit tests for the pure pieces of the
 * PHASE 6 A/B harness: metrics extraction, aggregation/table, env diff,
 * fixture hash, manifest reproducibility. The spawner (runExperiment) is
 * integration-only and NOT exercised here.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { metricsFromNdjson, zeroMetrics } from './metrics.ts';
import { aggregateByArm, renderComparisonTable } from './reporter.ts';
import { buildManifest, composeArmEnv, hashFixture } from './runner.ts';
import { GUARD_AB_REPORT_METRICS, guardAbArms, modelRoutingArms } from './experiments.ts';
import { EvalArmSchema, EvalCaseSchema } from './types.ts';
import type { ArmRunRecord } from './types.ts';

function record(armId: string, passed: boolean, toolCalls: number, retries = 0): ArmRunRecord {
  return {
    armId,
    caseId: 'c1',
    ndjsonLines: 3,
    metrics: { ...zeroMetrics(), passed, toolCalls, retries, durationMs: 1000 },
  };
}

describe('EvalCase/EvalArm schemas (§81–§82)', () => {
  it('accepts a minimal case and rejects an empty prompt', () => {
    expect(EvalCaseSchema.safeParse({ id: 'c1', prompt: 'do it', cwdFixture: '/tmp/x' }).success).toBe(true);
    expect(EvalCaseSchema.safeParse({ id: 'c1', prompt: '', cwdFixture: '/tmp/x' }).success).toBe(false);
  });

  it('accepts kebab-case arm ids and rejects others', () => {
    expect(EvalArmSchema.safeParse({ id: 'all-lead', env: {} }).success).toBe(true);
    expect(EvalArmSchema.safeParse({ id: 'All_Lead', env: {} }).success).toBe(false);
    expect(EvalArmSchema.safeParse({ id: 'x', env: { A: '1' } }).success).toBe(true);
  });
});

describe('metricsFromNdjson (§84)', () => {
  const lines = [
    JSON.stringify({ type: 'agent_start', ts: 1000, agentId: 'lead' }),
    JSON.stringify({ type: 'agent_start', ts: 1100, agentId: 't1', parentAgentId: 'lead' }),
    JSON.stringify({ type: 'tool_execution_start', ts: 1200, tool: 'bash' }),
    JSON.stringify({ type: 'tool_execution_start', ts: 1300, tool: 'read_file', args: { path: '.zelari/runs/r1/spill/bash-1.txt' } }),
    JSON.stringify({ type: 'tool_execution_end', ts: 1400, status: 'failed' }),
    JSON.stringify({ type: 'agent_end', ts: 2000, durationMs: 900, usage: { input: 500, output: 50, cached: 20 } }),
    JSON.stringify({ type: 'session_compacted', ts: 2100 }),
    JSON.stringify({ type: 'runtime_warning', ts: 2200, code: 'repeated_tool' }),
    'not json at all',
    '',
  ];

  it('extracts calls, tokens, warnings, compactions and wall duration', () => {
    const m = metricsFromNdjson(lines, true);
    expect(m.passed).toBe(true);
    expect(m.modelCalls).toBe(2);
    expect(m.tentacles).toBe(1); // agent_start with parentAgentId
    expect(m.toolCalls).toBe(2);
    expect(m.toolFailures).toBe(1);
    expect(m.recoveryReads).toBe(1); // read_file on /spill/
    expect(m.inputTokens).toBe(500);
    expect(m.outputTokens).toBe(50);
    expect(m.cachedTokens).toBe(20);
    expect(m.compactions).toBe(1);
    expect(m.guardWarnings).toBe(1);
    expect(m.durationMs).toBe(1200); // 2200 - 1000
    expect(m.verificationFailures).toBe(0); // no event yet → 0
    expect(m.spillCount).toBe(0);
  });

  it('counts retries from agent_end reason', () => {
    const m = metricsFromNdjson([JSON.stringify({ type: 'agent_end', ts: 5, durationMs: 1, reason: 'provider retry' })], false);
    expect(m.retries).toBe(1);
    expect(m.passed).toBe(false);
  });

  it('returns zero metrics on empty/garbage-only input without throwing', () => {
    const m = metricsFromNdjson(['', '}{'], true);
    expect(m.durationMs).toBe(0);
    expect(m.toolCalls).toBe(0);
  });
});

describe('aggregation + comparison table (§85)', () => {
  it('aggregates per arm with pass rates and means', () => {
    const aggs = aggregateByArm([
      record('all-lead', true, 30),
      record('all-lead', false, 32),
      record('routed', true, 29),
      record('routed', true, 27),
    ]);
    expect(aggs).toHaveLength(2);
    const routed = aggs.find((a) => a.armId === 'routed');
    expect(routed?.passRate).toBe(1);
    expect(routed?.meanToolCalls).toBe(28);
    const allLead = aggs.find((a) => a.armId === 'all-lead');
    expect(allLead?.passRate).toBe(0.5);
  });

  it('renders the §85-style table with arm headers and percentages', () => {
    const table = renderComparisonTable([
      { armId: 'all-lead', runs: 2, passRate: 0.82, meanDurationMs: 94000, meanInputTokens: 81000, meanOutputTokens: 18000, meanToolCalls: 31, meanRetries: 1.8, verificationFailRate: 0.07 },
      { armId: 'routed', runs: 2, passRate: 0.83, meanDurationMs: 66000, meanInputTokens: 53000, meanOutputTokens: 17000, meanToolCalls: 29, meanRetries: 1.5, verificationFailRate: 0.06 },
    ]);
    expect(table).toContain('Metric');
    expect(table).toContain('all-lead');
    expect(table).toContain('routed');
    expect(table).toContain('82%');
    expect(table).toContain('94s');
    expect(table).toContain('31');
    expect(table.split('\n')).toHaveLength(8);
  });
});

describe('composeArmEnv (§83)', () => {
  it('applies the diff and REMOVES keys set to empty string', () => {
    const env = composeArmEnv(
      { ZELARI_KRAKEN_EXPLORE_MODEL: 'inherited', KEEP: '1' },
      { id: 'all-lead', env: { ZELARI_KRAKEN_EXPLORE_MODEL: '', NEW: 'x' } },
    );
    expect(env).toEqual({ KEEP: '1', NEW: 'x' });
  });
});

describe('experiment presets (§83/§87)', () => {
  it('guardAbArms: two valid arms, off vs on', () => {
    const arms = guardAbArms();
    expect(arms.map((a) => a.id)).toEqual(['guards-off', 'guards-on']);
    for (const arm of arms) expect(EvalArmSchema.safeParse(arm).success).toBe(true);
    expect(arms[1]?.env.ZELARI_RUNTIME_OBSERVERS).toBe('1');
  });

  it('modelRoutingArms: all-lead CLEARS routing, routed sets real ids', () => {
    const arms = modelRoutingArms({ explore: 'gpt-4o-mini', general: 'gpt-4o', verify: 'gpt-4o-mini' });
    expect(arms[0]?.env.ZELARI_KRAKEN_EXPLORE_MODEL).toBe(''); // removed by composeArmEnv
    expect(Object.keys(composeArmEnv({ ZELARI_KRAKEN_EXPLORE_MODEL: 'x' }, arms[0]!))).not.toContain('ZELARI_KRAKEN_EXPLORE_MODEL');
    expect(arms[1]?.env.ZELARI_KRAKEN_GENERAL_MODEL).toBe('gpt-4o');
    expect(GUARD_AB_REPORT_METRICS).toContain('guardWarnings');
  });
});

describe('hashFixture + buildManifest (§86)', () => {
  it('hash is deterministic and content-sensitive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zelari-arms-'));
    writeFileSync(join(dir, 'a.txt'), 'hello');
    writeFileSync(join(dir, 'b.txt'), 'world');
    const h1 = hashFixture(dir);
    const h2 = hashFixture(dir);
    expect(h1).toBe(h2);
    writeFileSync(join(dir, 'b.txt'), 'changed');
    expect(hashFixture(dir)).not.toBe(h1);
  });

  it('manifest carries every reproducibility field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zelari-arms-'));
    writeFileSync(join(dir, 'f.txt'), 'x');
    const manifest = buildManifest({
      experimentId: 'guard-ab',
      createdAt: '2026-01-01T00:00:00.000Z',
      gitCommit: 'abc123',
      cliVersion: '2.10.0',
      provider: 'openai-compatible',
      arms: [{ id: 'guards-on', env: { ZELARI_RUNTIME_OBSERVERS: '1' } }],
      cases: [{ id: 'c1', prompt: 'p', cwdFixture: dir }],
      runs: [record('guards-on', true, 5)],
    });
    expect(manifest.version).toBe(1);
    expect(manifest.gitCommit).toBe('abc123');
    expect(manifest.cliVersion).toBe('2.10.0');
    expect(manifest.arms[0]?.envDiff).toEqual({ ZELARI_RUNTIME_OBSERVERS: '1' });
    expect(manifest.cases[0]?.fixtureHash).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.runs).toHaveLength(1);
  });
});
