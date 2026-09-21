/**
 * tools/eval/runExtensionsBaseline.ts — seed the eval store with the
 * extension/plugin CAPABILITY baseline (t147).
 *
 *   npm run eval:extensions                       # → eval/results/<suite-hash>/
 *   node --experimental-transform-types \
 *        --disable-warning=ExperimentalWarning \
 *        tools/eval/runExtensionsBaseline.ts [--store <dir>] [--workspace-root <dir>]
 *
 * WHAT THIS IS — and what it is NOT
 *  - It EXECUTES the real extension/plugin capability code (see
 *    tools/eval/extensionAnchors.ts) and records what actually happened: one
 *    `AnchorRunRecord` per check, written through the shared
 *    `EvalResultStore` (append-only `anchors.jsonl` + `summary.json`, the
 *    layout `runGate.ts` reads). No echo-stub runner, no synthesized
 *    outcomes (anti-Goodhart, mirroring tools/eval/runSeedBaseline.ts).
 *  - It is a DETERMINISTIC, OFFLINE capability baseline: no model, no
 *    network, no credentials. Cost is therefore zero by construction — the
 *    only measured number is wall time (`RunCost.wallMs`); every token/cost
 *    field is 0 because nothing was billed, not because it went untracked.
 *    These anchors are NOT comparable with the model-measured baselines from
 *    `npm run eval:seed-baseline` (`runSeedBaseline.ts` stays model-only).
 *  - It deliberately does NOT write `ZELARI_CANDIDATE_HASH` to GITHUB_ENV
 *    (that variable drives the model-suite CI flow): this suite carries its
 *    own manifest hash, printed as `extension-suite-hash:`.
 *
 * WHY THE UNUSUAL MODULE WIRING (read before "simplifying" this file)
 *  `src/cli/**` is authored as TS with `.js` relative specifiers + TS
 *  parameter properties, which bare Node type-stripping cannot run:
 *    - `src/cli/extensions/loader.ts` uses a parameter property
 *      (`constructor(…, readonly mismatches: …)`) → strip-only mode raises
 *      ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, hence `--experimental-transform-types`;
 *    - Node does NOT rewrite `./x.js` → `./x.ts`, so
 *      {@link installTsSpecifierResolver} registers a resolve hook mapping a
 *      relative `.js` specifier to its `.ts` sibling when (and only when) the
 *      `.js` file does not exist.
 *  The suite itself therefore stays plain, statically-importable TS (vitest
 *  needs none of this: Vite already resolves `.js`→`.ts`).
 */

import { argv, env, exit } from 'node:process';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { register } from 'node:module';
import { EvalResultStore, type EvalSummaryRecord } from './resultStore.ts';
import { evaluateRegressionGate } from './regressionGate.ts';
import { RETENTION_PRESETS } from './retentionPolicy.ts';
import { zeroCost } from './cost.ts';
import type { AnchorRunRecord } from './types.ts';
import type { CapabilityCheckResult, ExtensionCapabilityCheck } from './extensionAnchors.ts';

/** Repo root from THIS file — cwd-independent (same rule as runAnchors.ts). */
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Default scratch root for the suite's fixture workspaces. Deliberately
 * INSIDE the repo (gitignored `.zelari/`) so a shipped fixture extension still
 * resolves its own bare imports. Kept in sync with `EXTENSION_WORKSPACE_ROOT`
 * in extensionAnchors.ts, which this module must not import statically.
 */
const DEFAULT_WORKSPACE_ROOT = path.join(REPO_ROOT, '.zelari', 'eval-extension-workspaces');

/**
 * Fixed resource-policy label for this offline suite (mirrors the tag in
 * extensionAnchors.ts). It is NOT a resolved `defaultResourcePolicy()` hash:
 * this baseline runs under no profile, so claiming one would be provenance
 * theatre. A fixed, documented label is the honest value.
 */
const RESOURCE_POLICY_TAG = 'extension-baseline/offline-deterministic/v1';
const RESOURCE_POLICY_HASH = createHash('sha256').update(RESOURCE_POLICY_TAG, 'utf8').digest('hex');

export interface ExtensionSuiteRun {
  manifestHash: string;
  records: AnchorRunRecord[];
  passed: number;
  failed: number;
  totalWallMs: number;
  decision: 'COMMIT' | 'REJECT';
  summary: EvalSummaryRecord;
}

export interface RunExtensionSuiteOptions {
  store: EvalResultStore;
  suite: readonly ExtensionCapabilityCheck[];
  suiteHash: string;
  workspaceRoot?: string;
  now?: () => string;
  /** Progress sink (the entrypoint prints; tests stay silent). */
  onCheck?: (check: ExtensionCapabilityCheck, result: CapabilityCheckResult) => void;
}

/**
 * Run every capability check, record one honest `AnchorRunRecord` per check,
 * then write the suite summary. Nothing is invented: `decision` is REJECT
 * unless every check passed AND the self-comparison under the `stable` policy
 * is COMMIT (which is exactly what runGate.ts will re-derive).
 */
export async function runExtensionSuite(options: RunExtensionSuiteOptions): Promise<ExtensionSuiteRun> {
  const workspaceRoot = options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const now = options.now ?? (() => new Date().toISOString());
  const records: AnchorRunRecord[] = [];

  for (const check of options.suite) {
    const result = await check.run(workspaceRoot);
    const record: AnchorRunRecord = {
      runId: randomUUID(),
      anchorId: check.id,
      anchorVersion: check.version,
      harnessManifestHash: options.suiteHash,
      resourcePolicyHash: RESOURCE_POLICY_HASH,
      result: result.ok ? 'pass' : 'fail',
      verified: result.ok,
      // Honest zero cost: nothing was billed, no tokens/tools consumed.
      // `wallMs` is the REAL measured duration of this check.
      cost: { ...zeroCost(), wallMs: result.wallMs },
      exitCode: result.ok ? 0 : 1,
      ...(result.ok ? {} : { reason: 'checks-failed' as const }),
      detail: result.detail,
      recordedAt: now(),
    };
    records.push(record);
    options.onCheck?.(check, result);
    options.store.saveRun(record); // append-only anchors.jsonl
  }

  const passed = records.filter((r) => r.result === 'pass').length;
  const validityViolations = records
    .filter((r) => !r.harnessManifestHash || !r.resourcePolicyHash)
    .map((r) => `record ${r.anchorId}: missing provenance hash`);
  const selfComparison = evaluateRegressionGate({
    manifestHash: options.suiteHash,
    baseline: records,
    candidate: records,
    currentSuite: { passed, total: records.length },
    validityViolations,
    policy: RETENTION_PRESETS.stable,
  });

  const allPassed = records.length > 0 && passed === records.length;
  const decision: 'COMMIT' | 'REJECT' = allPassed && selfComparison.decision === 'COMMIT' ? 'COMMIT' : 'REJECT';
  const gateReasons = [...selfComparison.reasons];
  if (!allPassed) {
    gateReasons.push(
      `${records.length - passed}/${records.length} capability check(s) failed — a failing baseline is not promotable`,
    );
  }
  const summary: EvalSummaryRecord = {
    manifestHash: options.suiteHash,
    recordedAt: now(),
    gateDecision: decision,
    gateReasons,
    result: selfComparison.result,
  };
  options.store.saveSummary(summary);

  return {
    manifestHash: options.suiteHash,
    records,
    passed,
    failed: records.length - passed,
    totalWallMs: records.reduce((sum, r) => sum + r.cost.wallMs, 0),
    decision,
    summary,
  };
}

/** Human-readable report of one suite run (no verdict invented here either). */
export function formatExtensionReport(run: ExtensionSuiteRun): string {
  const lines = [
    'Extension/plugin capability baseline (t147) — deterministic, offline, cost 0 by construction',
    '',
  ];
  for (const record of run.records) {
    const mark = record.result === 'pass' ? 'pass' : `FAIL (exit ${record.exitCode})`;
    lines.push(`[${mark}] ${record.anchorId} v${record.anchorVersion} — ${record.cost.wallMs}ms`);
    lines.push(`        ${record.detail ?? '(no detail)'}`);
  }
  const avg = run.records.length > 0 ? Math.round(run.totalWallMs / run.records.length) : 0;
  lines.push('');
  lines.push(`checks: ${run.passed}/${run.records.length} passed · wall ${run.totalWallMs}ms total / ${avg}ms avg`);
  const reasons = run.summary.gateReasons ?? [];
  lines.push(
    `self-comparison (stable policy): ${run.decision}${reasons.length > 0 ? ` — ${reasons.join('; ')}` : ''}`,
  );
  lines.push(`extension-suite-hash: ${run.manifestHash}`);
  lines.push('');
  lines.push(
    `gate:  npm run eval:gate -- --baseline ${run.manifestHash} --candidate ${run.manifestHash}`,
  );
  return lines.join('\n');
}

/**
 * Register the `.js`→`.ts` resolve hook described in the header. Idempotent
 * per process; unnecessary under vitest (Vite resolves those specifiers).
 */
export function installTsSpecifierResolver(): void {
  const hookSource = `import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const target = fileURLToPath(new URL(specifier, context.parentURL));
    if (!fs.existsSync(target)) {
      const tsSibling = target.slice(0, -3) + '.ts';
      if (fs.existsSync(tsSibling)) return nextResolve(pathToFileURL(tsSibling).href, context);
    }
  }
  return nextResolve(specifier, context);
}
`;
  register(`data:text/javascript,${encodeURIComponent(hookSource)}`);
}

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  installTsSpecifierResolver();

  let suiteModule: typeof import('./extensionAnchors.ts');
  try {
    suiteModule = await import('./extensionAnchors.ts');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`runExtensionsBaseline: cannot load the capability suite: ${message}`);
    console.error(
      'hint: this entry point needs `node --experimental-transform-types` (src/cli uses TS parameter ' +
        'properties) — run it through `npm run eval:extensions`.',
    );
    return 2;
  }

  const storeArg = arg('store');
  const store = storeArg ? new EvalResultStore(path.resolve(storeArg)) : EvalResultStore.default();
  const workspaceRootArg = arg('workspace-root');
  const workspaceRoot = workspaceRootArg ? path.resolve(workspaceRootArg) : DEFAULT_WORKSPACE_ROOT;

  const run = await runExtensionSuite({
    store,
    suite: suiteModule.EXTENSION_SUITE,
    suiteHash: suiteModule.extensionSuiteManifestHash(),
    workspaceRoot,
    onCheck: (check, result) => {
      const mark = result.ok ? 'pass' : 'FAIL';
      console.log(`[${mark}] ${check.id} v${check.version} — ${result.wallMs}ms`);
      console.log(`        ${result.detail}`);
    },
  });

  console.log(`\n${formatExtensionReport(run)}`);
  console.log(`\nstore: ${path.join(store.rootDir, run.manifestHash)}`);
  if (env.GITHUB_ENV) {
    appendFileSync(env.GITHUB_ENV, `ZELARI_EXTENSION_SUITE_HASH=${run.manifestHash}\n`, 'utf8');
  }
  return run.passed === run.records.length ? 0 : 1;
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (code) => exit(code),
    (err: unknown) => {
      console.error(`runExtensionsBaseline: ${err instanceof Error ? err.message : String(err)}`);
      exit(1);
    },
  );
}
