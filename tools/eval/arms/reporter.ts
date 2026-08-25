/**
 * tools/eval/arms/reporter.ts — per-arm aggregation + comparison table
 * (upgrade doc §85). Pure: no IO, no clock.
 */

import type { ArmRunRecord } from './types.ts';

export interface ArmAggregate {
  armId: string;
  runs: number;
  passRate: number;
  meanDurationMs: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanToolCalls: number;
  meanRetries: number;
  verificationFailRate: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function aggregateByArm(runs: readonly ArmRunRecord[]): ArmAggregate[] {
  const byArm = new Map<string, ArmRunRecord[]>();
  for (const r of runs) {
    const list = byArm.get(r.armId);
    if (list) list.push(r);
    else byArm.set(r.armId, [r]);
  }
  return [...byArm.entries()].map(([armId, list]) => ({
    armId,
    runs: list.length,
    passRate: list.filter((r) => r.metrics.passed).length / list.length,
    meanDurationMs: mean(list.map((r) => r.metrics.durationMs)),
    meanInputTokens: mean(list.map((r) => r.metrics.inputTokens)),
    meanOutputTokens: mean(list.map((r) => r.metrics.outputTokens)),
    meanToolCalls: mean(list.map((r) => r.metrics.toolCalls)),
    meanRetries: mean(list.map((r) => r.metrics.retries)),
    verificationFailRate:
      list.filter((r) => r.metrics.verificationFailures > 0).length / list.length,
  }));
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function s(x: number): string {
  return Math.round(x).toLocaleString('en-US');
}

function row(label: string, cells: string[]): string {
  return `${label.padEnd(16)}${cells.map((c) => c.padStart(12)).join('')}`;
}

/** Fixed-width comparison table (§85): one column per arm. */
export function renderComparisonTable(aggs: readonly ArmAggregate[]): string {
  const header = row('Metric', aggs.map((a) => a.armId));
  const lines = [
    header,
    row('Pass rate', aggs.map((a) => pct(a.passRate))),
    row('Duration mean', aggs.map((a) => `${s(a.meanDurationMs / 1000)}s`)),
    row('Input tokens', aggs.map((a) => s(a.meanInputTokens))),
    row('Output tokens', aggs.map((a) => s(a.meanOutputTokens))),
    row('Tool calls', aggs.map((a) => s(a.meanToolCalls))),
    row('Retry count', aggs.map((a) => a.meanRetries.toFixed(1))),
    row('Verification fail', aggs.map((a) => pct(a.verificationFailRate))),
  ];
  return lines.join('\n');
}
