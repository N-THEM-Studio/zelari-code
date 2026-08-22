/**
 * tools/eval/runGate.ts — retention-gate entry point (2.6 F11 / CI Phase 4).
 *
 * Compares the CANDIDATE results (eval/results/<hash>) against a recorded
 * BASELINE manifest under a retention preset:
 *
 *   node --experimental-strip-types tools/eval/runGate.ts \
 *     --baseline <manifestHash> --candidate <manifestHash> --preset stable
 *
 * Report-only mode (rollout Phase 1) prints the report but exits 0.
 * Default is BLOCKING (Phase 4) with `--report-only` for shadow runs.
 */

import { argv, exit } from 'node:process';
import { EvalResultStore } from './resultStore.ts';
import { evaluateRegressionGate } from './regressionGate.ts';
import { RETENTION_PRESETS } from './retentionPolicy.ts';
import { formatGateReport } from './report.ts';
import { summarizeCost } from './regressionGate.ts';

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(): number {
  const baselineHash = arg('baseline');
  const candidateHash = arg('candidate') ?? '';
  const presetName = (arg('preset') ?? 'stable') as keyof typeof RETENTION_PRESETS;
  const reportOnly = argv.includes('--report-only');
  const store = EvalResultStore.default();

  if (!baselineHash) {
    console.error('usage: runGate.ts --baseline <manifestHash> [--candidate <hash>] [--preset stable|experimental|research] [--report-only]');
    return 2;
  }
  const policy = RETENTION_PRESETS[presetName] ?? RETENTION_PRESETS.stable;
  const baseline = store.loadRuns(baselineHash);
  const candidate = candidateHash ? store.loadRuns(candidateHash) : [];
  const baselineSummary = store.loadSummary(baselineHash);

  const comparison = evaluateRegressionGate({
    manifestHash: candidateHash || baselineHash,
    baseline,
    candidate,
    currentSuite: baselineSummary?.result.currentSuite ?? { passed: 0, total: 0 },
    baselineCurrentSuite: baselineSummary?.result.currentSuite,
    validityViolations: [],
    policy,
  });

  const baselineCost = summarizeCost(baseline).costPerVerifiedSolve;
  console.log(
    formatGateReport(comparison, {
      anchorsPassed: baseline.filter((r) => r.result === 'pass').length,
      anchorsTotal: baseline.length,
      costPerVerifiedSolve: baselineCost,
    }),
  );
  if (reportOnly) {
    console.log('\n(report-only mode: decision is advisory, exit 0)');
    return 0;
  }
  return comparison.decision === 'COMMIT' ? 0 : 1;
}

exit(main());
