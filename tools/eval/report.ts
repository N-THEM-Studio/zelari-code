/**
 * tools/eval/report.ts — human-readable gate report (doc §8.6) + pareto
 * table (§15.4). Text only; the machine-readable record lives in the
 * result store (F11).
 */

import type { GateComparison } from './regressionGate.ts';

export function formatGateReport(
  comparison: GateComparison,
  baseline: { anchorsPassed: number; anchorsTotal: number; costPerVerifiedSolve: number | null },
): string {
  const { result, decision, reasons } = comparison;
  const anchorLine = `${baseline.anchorsPassed}/${baseline.anchorsTotal} → ${result.anchors.passed}/${result.anchors.total}`;
  const anchorDelta = result.anchors.passed - baseline.anchorsPassed;
  const costB = baseline.costPerVerifiedSolve;
  const costC = result.cost.costPerVerifiedSolve;
  const costLine =
    costB !== null && costC !== null
      ? `$${costB.toFixed(2)} → $${costC.toFixed(2)} (${(((costC - costB) / Math.max(costB, 1e-9)) * 100).toFixed(0)}%)`
      : 'n/a';
  const lines = [
    `Harness candidate: ${result.manifestHash.slice(0, 8)}`,
    '',
    'Historical anchors',
    `${anchorLine} (${anchorDelta >= 0 ? '+' : ''}${anchorDelta})`,
    `Regressions: ${result.anchors.regressions.map((r) => r.anchorId).join(', ') || 'none'}`,
    `Improvements: ${result.anchors.improvements.map((r) => r.anchorId).join(', ') || 'none'}`,
    '',
    'Cost / verified solve',
    costLine,
    '',
    `Retention budget: ${comparison.policy.maxRegressedAnchors}`,
    '',
    ...(reasons.length > 0 ? reasons.map((r) => `REASON: ${r}`) : []),
    'RESULT:',
    decision,
  ];
  return lines.join('\n');
}

export interface ParetoRow {
  candidate: string;
  solveRatePct: number;
  costPerVerifiedSolve: number | null;
  wallMsPerSolve: number | null;
}

export function formatParetoReport(rows: readonly ParetoRow[]): string {
  const header = 'Candidate   Solve   Cost/solve   Wall';
  const body = rows.map(
    (r) =>
      `${r.candidate.padEnd(11)} ${String(r.solveRatePct).padEnd(7)} ${
        r.costPerVerifiedSolve === null ? 'n/a' : `$${r.costPerVerifiedSolve.toFixed(2)}`
      }       ${r.wallMsPerSolve === null ? 'n/a' : `${Math.round(r.wallMsPerSolve / 1000)}s`}`,
  );
  return [header, ...body, '', 'note: a higher solve rate alone never implies promotion'].join('\n');
}
