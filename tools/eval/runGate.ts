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
  // 2.6.1 (plan §24): `none` is FORBIDDEN as a baseline — an anchor must
  // never be able to 'disappear' from the comparison by pointing at nothing.
  if (baselineHash === 'none' && !process.env.ZELARI_EVAL_ALLOW_NONE) {
  console.error('runGate: --baseline none is not allowed (2.6.1 plan §24). Use the last stable tag or an approved manifest hash.');
  process.exit(2);
}
  const store = EvalResultStore.default();

  if (!baselineHash) {
    console.error('usage: runGate.ts --baseline <manifestHash> [--candidate <hash>] [--preset stable|experimental|research] [--report-only]');
    return 2;
  }
  const policy = RETENTION_PRESETS[presetName] ?? RETENTION_PRESETS.stable;
  const baseline = store.loadRuns(baselineHash);
  const candidate = candidateHash ? store.loadRuns(candidateHash) : [];
  // 2.6.1 (plan §22): baseline and candidate summaries load SEPARATELY — the
  // candidate suite describes the candidate, never a copy of the baseline.
  const baselineSummary = store.loadSummary(baselineHash);
  const candidateSummary = candidateHash ? store.loadSummary(candidateHash) : null;

  // 2.6.1 (plan §22): validity is FED, never hardcoded empty. Real sources:
  // missing run records for a requested suite, and records without harness
  // provenance hashes (plan §19 — provenance is part of validity).
  const validityViolations: string[] = [];
  if (baseline.length === 0) {
    validityViolations.push(`baseline ${baselineHash} has no run records`);
  }
  if (candidateHash && candidate.length === 0) {
    validityViolations.push(`candidate ${candidateHash} has no run records`);
  }
  for (const r of candidate) {
    if (!r.harnessManifestHash) validityViolations.push(`candidate record ${r.anchorId}: empty harnessManifestHash`);
    if (!r.resourcePolicyHash) validityViolations.push(`candidate record ${r.anchorId}: empty resourcePolicyHash`);
  }

  const comparison = evaluateRegressionGate({
    manifestHash: candidateHash || baselineHash,
    baseline,
    candidate,
    currentSuite:
      candidateSummary?.result.currentSuite ?? {
        passed: candidate.filter((r) => r.result === 'pass').length,
        total: candidate.length,
      },
    baselineCurrentSuite: baselineSummary?.result.currentSuite,
    validityViolations,
    policy,
  });

  const candidateCost = summarizeCost(candidate).costPerVerifiedSolve;
  console.log(
    formatGateReport(comparison, {
      anchorsPassed: candidate.filter((r) => r.result === 'pass').length,
      anchorsTotal: candidate.length,
      costPerVerifiedSolve: candidateCost,
    }),
  );
  if (reportOnly) {
    console.log('\n(report-only mode: decision is advisory, exit 0)');
    return 0;
  }
  return comparison.decision === 'COMMIT' ? 0 : 1;
}

exit(main());
