/*
 * tools/eval/runMeasured.ts — Fase 0 measured-comparison CLI (advisory).
 *
 *   node --experimental-strip-types tools/eval/runMeasured.ts \
 *     --baseline <manifestHash|latest> --candidate <manifestHash> \
 *     [--baseline-store <dir>] [--min-runs 3] [--strict]
 *
 * Differences from runGate.ts (deliberate):
 *  - ADVISORY by default: exit 0 regardless of the verdict. The blocking
 *    retention decision stays with runGate.ts; this tool measures whether a
 *    delta is distinguishable from run-to-run noise at all.
 *  - `--strict` exits 1 only on a MEASURED regression (suite-level). It
 *    never exits 1 on `insufficient-n` — missing data is a call for more
 *    runs, not a failure signal (unknown ≠ pass, but unknown ≠ fail too).
 *  - `--fail-insufficient` (Fase 3.0, opt-in) makes `insufficient-n` exit 1
 *    TOO — for CI-style evidence rows (evolve:validate --with-eval) where
 *    "we could not measure this" must not read as green. Default stays
 *    advisory; runGate.ts is untouched by this flag.
 */

import { argv, exit } from 'node:process';
import path from 'node:path';
import { EvalResultStore } from './resultStore.ts';
import { evaluateMeasuredGate, formatMeasuredReport } from './measuredGate.ts';

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(): number {
  let baselineHash = arg('baseline');
  const candidateHash = arg('candidate');
  const minRunsRaw = Number.parseInt(arg('min-runs') ?? '3', 10);
  const strict = argv.includes('--strict');
  const failInsufficient = argv.includes('--fail-insufficient');

  if (!baselineHash || !candidateHash) {
    console.error(
      'usage: runMeasured.ts --baseline <manifestHash|latest> --candidate <manifestHash> [--baseline-store <dir>] [--min-runs N] [--strict] [--fail-insufficient]',
    );
    return 2;
  }
  if (!Number.isFinite(minRunsRaw) || minRunsRaw < 1) {
    console.error('runMeasured: --min-runs must be a positive integer');
    return 2;
  }

  const store = EvalResultStore.default();
  const baselineStoreArg = arg('baseline-store');
  const baselineStore = baselineStoreArg
    ? new EvalResultStore(path.resolve(baselineStoreArg))
    : store;

  if (baselineHash === 'latest') {
    const latest = baselineStore.latestManifestHash();
    if (!latest) {
      console.error('runMeasured: --baseline latest found no recorded summaries in the baseline store');
      return 2;
    }
    baselineHash = latest;
    console.log(`runMeasured: --baseline latest → ${latest}`);
  }

  const baseline = baselineStore.loadRuns(baselineHash);
  const candidate = store.loadRuns(candidateHash);
  if (baseline.length === 0 && candidate.length === 0) {
    console.error(
      'runMeasured: no run records on either side — seed the store first (runAnchors.ts), possibly multiple times for variance',
    );
    return 2;
  }

  const comparison = evaluateMeasuredGate({
    baseline,
    candidate,
    minRunsPerAnchor: minRunsRaw,
  });
  console.log(formatMeasuredReport(comparison, { baselineHash, candidateHash }));

  if (strict && comparison.suite.verdict === 'measured-worse') {
    console.log('\n(--strict: MEASURED regression → exit 1)');
    return 1;
  }
  if (failInsufficient && comparison.suite.verdict === 'insufficient-n') {
    console.log('\n(--fail-insufficient: insufficient-n → exit 1 — more runs needed; this is NOT a measured regression)');
    return 1;
  }
  console.log('\n(advisory Fase 0: promotion stays with runGate.ts — run this before trusting any candidate delta)');
  return 0;
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  exit(main());
}
