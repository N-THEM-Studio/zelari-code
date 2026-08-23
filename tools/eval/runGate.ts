/*
 * tools/eval/runGate.ts — retention-gate entry point (2.6 F11 / CI Phase 4).
 *
 * Compares the CANDIDATE results (eval/results/<hash>) against a recorded
 * BASELINE manifest under a retention preset:
 *
 *   node --experimental-strip-types tools/eval/runGate.ts \
 *     --baseline <manifestHash> --candidate <manifestHash> --preset stable
 *
 * `--candidate all` compares EVERY manifest recorded in the candidate store —
 * mixed-profile suites (tier 0 = kraken + minimal) split across manifest dirs
 * and a single-hash comparison would cover only one profile's anchors (F11).
 * Report-only mode (rollout Phase 1) prints the report but exits 0.
 * Default is BLOCKING (Phase 4) with `--report-only` for shadow runs.
 */

import { argv, exit } from 'node:process';
import path from 'node:path';
import { EvalResultStore } from './resultStore.ts';
import { evaluateRegressionGate } from './regressionGate.ts';
import { RETENTION_PRESETS } from './retentionPolicy.ts';
import { formatGateReport } from './report.ts';
import { summarizeCost } from './regressionGate.ts';

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Compare ONE baseline manifest against its candidate counterpart and print
 * the report. Shared by the single-hash path and `--candidate all`.
 *
 * `skipOnMissingBaseline`: in `all` mode a manifest the baseline never
 * recorded is a NEW harness (nothing to retain yet) → informational SKIP.
 * In single mode a missing baseline stays a validity violation (§22).
 */
export function compareManifest(input: {
  baselineHash: string;
  candidateHash?: string;
  baselineStore: EvalResultStore;
  store: EvalResultStore;
  skipOnMissingBaseline: boolean;
  presetName?: keyof typeof RETENTION_PRESETS;
}): 'COMMIT' | 'REJECT' | 'SKIP' {
  const { baselineHash, candidateHash, baselineStore, store } = input;
  const policy = RETENTION_PRESETS[input.presetName ?? 'stable'] ?? RETENTION_PRESETS.stable;
  const baseline = baselineStore.loadRuns(baselineHash);
  if (baseline.length === 0 && input.skipOnMissingBaseline) {
    console.log(`\n=== ${baselineHash.slice(0, 8)}: no baseline runs — new harness, nothing to retain (skip) ===`);
    return 'SKIP';
  }
  const candidate = candidateHash ? store.loadRuns(candidateHash) : [];
  // 2.6.1 (plan §22): baseline and candidate summaries load SEPARATELY — the
  // candidate suite describes the candidate, never a copy of the baseline.
  const baselineSummary = baselineStore.loadSummary(baselineHash);
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
  return comparison.decision === 'COMMIT' ? 'COMMIT' : 'REJECT';
}

function main(): number {
  let baselineHash = arg('baseline');
  const candidateArg = arg('candidate') ?? '';
  const presetName = (arg('preset') ?? 'stable') as keyof typeof RETENTION_PRESETS;
  const reportOnly = argv.includes('--report-only');
  // 2.6.1 (plan §24): `none` is FORBIDDEN as a baseline — an anchor must
  // never be able to 'disappear' from the comparison by pointing at nothing.
  if (baselineHash === 'none' && !process.env.ZELARI_EVAL_ALLOW_NONE) {
    console.error(
      'runGate: --baseline none is not allowed (2.6.1 plan §24). Use the last stable tag or an approved manifest hash.',
    );
    process.exit(2);
  }
  const store = EvalResultStore.default();
  // F11/CI: the baseline store may live elsewhere (extracted from the stable
  // tag via `git archive <tag> eval/results`). Candidate always uses default.
  const baselineStoreArg = arg('baseline-store');
  const baselineStore = baselineStoreArg
    ? new EvalResultStore(path.resolve(baselineStoreArg))
    : store;
  // `--baseline latest` resolves to the newest recorded manifest in the
  // baseline store (CI: the tag's most recent seeded suite).
  if (baselineHash === 'latest') {
    const latest = baselineStore.latestManifestHash();
    if (!latest) {
      console.error('runGate: --baseline latest found no recorded summaries in the baseline store');
      return 2;
    }
    baselineHash = latest;
    console.log(`runGate: --baseline latest → ${latest}`);
  }

  if (!baselineHash) {
    console.error(
      'usage: runGate.ts --baseline <manifestHash> [--candidate <hash>|all] [--baseline-store <dir>] [--preset stable|experimental|research] [--report-only]',
    );
    return 2;
  }

  // F11/CI: `--candidate all` iterates EVERY manifest in the candidate store —
  // mixed-profile suites (tier 0 = kraken + minimal) split across manifest
  // dirs, and a single-hash comparison would cover only one profile's anchors.
  if (candidateArg === 'all') {
    const hashes = store.listManifestHashes();
    if (hashes.length === 0) {
      console.error('runGate: --candidate all found no recorded manifests in the candidate store');
      return 2;
    }
    let worst: 'COMMIT' | 'REJECT' = 'COMMIT';
    let compared = 0;
    for (const hash of hashes) {
      const outcome = compareManifest({
        baselineHash: hash,
        candidateHash: hash,
        baselineStore,
        store,
        skipOnMissingBaseline: true,
        presetName,
      });
      if (outcome === 'SKIP') continue;
      compared += 1;
      if (outcome === 'REJECT') worst = 'REJECT';
    }
    console.log(`\n[all] ${compared}/${hashes.length} manifests compared → ${worst}`);
    if (reportOnly) {
      console.log('(report-only mode: decision is advisory, exit 0)');
      return 0;
    }
    return worst === 'COMMIT' ? 0 : 1;
  }

  const single = compareManifest({
    baselineHash,
    candidateHash: candidateArg || undefined,
    baselineStore,
    store,
    skipOnMissingBaseline: false,
    presetName,
  });
  if (reportOnly) {
    console.log('\n(report-only mode: decision is advisory, exit 0)');
    return 0;
  }
  return single === 'COMMIT' ? 0 : 1;
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  exit(main());
}
