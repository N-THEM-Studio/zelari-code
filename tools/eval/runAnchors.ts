/**
 * tools/eval/runAnchors.ts — execute the historical anchor suite against the
 * CURRENT harness candidate and seed the eval result store (2.6 F11, §17).
 *
 *   node --experimental-strip-types tools/eval/runAnchors.ts \
 *     --tier 0 --tier 1 --runner headless [--store <dir>] [--limit N]
 *       [--repeat N]
 *
 * Store layout (file-based, no database until volumes demand one):
 *   eval/results/<manifestHash>/anchors.jsonl   — one record per anchor run
 *   eval/results/<manifestHash>/summary.json    — self-comparison report
 *
 * Provenance is DEEP by default (2.6.1 plan §19 + 2.6.2 slice-2): the
 * harness manifest hash is computed from the profile's tool SPECS
 * (name + description + inputSchema) out of the core builtin registry —
 * not from bare tool names. CLI-layer-only tools fall back to the name
 * list until their specs land in the core registry.
 *
 * Exit code: 0 once the store is seeded (the RETENTION decision belongs to
 * runGate.ts, never to the seeder). `--strict` flips non-pass runs to exit 1
 * for manual runs. Never fakes outcomes: a runner that cannot execute
 * records honest fails/blocked, and the offline case must NOT seed at all.
 */

import { argv, exit, env } from 'node:process';
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  defaultResourcePolicy,
  resolveProfile,
  resourcePolicyHash,
  toolFingerprintHash,
} from '@zelari/core';
import { getToolRegistry } from '@zelari/core/harness/tools';
import { loadAnchors } from './anchorLoader.ts';
import { runAnchor, type AgentRunner, type AgentRunOutcome } from './anchorRunner.ts';
import { EvalResultStore, type EvalSummaryRecord } from './resultStore.ts';
import { evaluateRegressionGate } from './regressionGate.ts';
import { RETENTION_PRESETS } from './retentionPolicy.ts';
import type { AnchorManifest, AnchorRunRecord } from './types.ts';

export const DEFAULT_ANCHORS_DIR = path.resolve(import.meta.dirname, '../../eval/anchors');

/**
 * Deep provenance for a profile: hash over the profile's tool NAMES plus the
 * SPECS (name+description+inputSchema) of every name resolvable in the core
 * builtin registry. Names always participate — the hash is never shallower
 * than the 2.6.1 default (store continuity); specs deepen it as tools land
 * in the core registry (2.6.2 slice-2 seam).
 */
export function computeSuiteProvenance(profileId: string): {
  harnessManifestHash: string;
  resourcePolicyHash: string;
} {
  const profile = resolveProfile(profileId);
  const nameParts = profile.tools.map((name) => ({ name }));
  const specParts = getToolRegistry().fingerprints(profile.tools);
  return {
    harnessManifestHash: toolFingerprintHash([...nameParts, ...specParts]),
    resourcePolicyHash: resourcePolicyHash(defaultResourcePolicy(profileId)),
  };
}

/**
 * Production runner: spawns the real headless CLI in the anchor workspace.
 * Requires provider credentials in the environment — runGate is only honest
 * if the seeder refuses to run without them (see `--runner` handling).
 *
 * Limitations (documented, honest): token/tool-call counts are not parsed
 * from the headless event stream yet, so per-run budget enforcement relies
 * on wall-time + the deterministic success checks (§7.7 golden signal).
 */
export function headlessAgentRunner(cliPath = 'bin/zelari-code.js'): AgentRunner {
  return (anchor: AnchorManifest, workspaceDir: string): AgentRunOutcome => {
    const taskFile = path.join(workspaceDir, '.anchor-task.txt');
    writeFileSync(taskFile, anchor.task, 'utf8');
    const budgetWallMs = anchor.budget.maxWallMs ?? 600_000;
    const startedAt = Date.now();
    const res = spawnSync(
      process.execPath,
      [cliPath, '--headless', '--task-file', taskFile, '--profile', anchor.profile],
      { cwd: workspaceDir, encoding: 'utf8', timeout: budgetWallMs + 60_000, env },
    );
    const wallMs = Date.now() - startedAt;
    if (res.error) {
      return { ok: false, toolCalls: 0, wallMs, detail: `headless spawn failed: ${res.error.message}` };
    }
    return {
      ok: res.status === 0,
      toolCalls: 0,
      wallMs,
      detail: `headless exit=${res.status ?? 'null'} ${(res.stderr ?? '').slice(-400)}`,
    };
  };
}

export interface RunSuiteOptions {
  tiers?: readonly (0 | 1 | 2)[];
  anchorsDir?: string;
  store: EvalResultStore;
  runner: AgentRunner;
  /** Skip provenance computation and pin the hash (tests / re-seeding). */
  provenance?: { harnessManifestHash?: string; resourcePolicyHash?: string };
  limit?: number;
  /** Run each anchor N times (multi-run data for the variance-aware
   * comparator, Fase 0.1); default 1. */
  repeat?: number;
  now?: () => string;
}

export interface SuiteRunResult {
  manifestHash: string;
  records: AnchorRunRecord[];
  passed: number;
  failed: number;
  blocked: number;
  summary: EvalSummaryRecord;
}

/** Run every anchor of the requested tiers and seed the result store. */
export async function runAnchorSuite(options: RunSuiteOptions): Promise<SuiteRunResult> {
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('repeat must be an integer >= 1');
  const tiers = options.tiers ?? [0];
  const anchors = loadAnchors(options.anchorsDir ?? DEFAULT_ANCHORS_DIR).filter((a) =>
    tiers.includes(a.tier as 0 | 1 | 2),
  );
  const selected = options.limit ? anchors.slice(0, options.limit) : anchors;
  if (selected.length === 0) throw new Error(`no anchors match tiers [${tiers.join(', ')}]`);
  const profiles = [...new Set(selected.map((a) => a.profile))];
  // One provenance per distinct profile; records carry their profile's hash.
  const provenanceByProfile = new Map(
    profiles.map((p) => [p, { ...computeSuiteProvenance(p), ...(options.provenance ?? {}) }]),
  );

  const records: AnchorRunRecord[] = [];
  for (const anchor of selected) {
    const provenance = provenanceByProfile.get(anchor.profile)!;
    for (let run = 1; run <= repeat; run += 1) {
      const record = await runAnchor(anchor, {
        runner: options.runner,
        provenance,
        workspaceRoot: options.store.rootDir,
        now: options.now,
      });
      records.push(record);
      // `#n/N` suffix only when repeating — single-run log stays identical.
      console.log(
        `[runAnchors] ${record.result.padEnd(7)} ${record.anchorId}` +
          (repeat > 1 ? ` #${run}/${repeat}` : '') +
          ` (${record.reason ?? 'ok'})` +
          ` manifest=${record.harnessManifestHash.slice(0, 12)}`,
      );
    }
  }

  // The store keys runs by harness manifest hash. Mixed-profile suites are
  // keyed by the FIRST profile's hash (single-profile suites, the CI norm,
  // are exact); runGate compares per-anchor ids regardless.
  const manifestHash = records[0].harnessManifestHash;
  const passed = records.filter((r) => r.result === 'pass').length;
  const selfComparison = evaluateRegressionGate({
    manifestHash,
    baseline: records,
    candidate: records,
    currentSuite: { passed, total: records.length },
    validityViolations: [],
    policy: RETENTION_PRESETS.stable,
  });
  const summary: EvalSummaryRecord = {
    manifestHash,
    recordedAt: (options.now ?? (() => new Date().toISOString()))(),
    gateDecision: selfComparison.decision,
    gateReasons: selfComparison.reasons,
    result: selfComparison.result,
  };
  for (const record of records) options.store.saveRun(record);
  options.store.saveSummary(summary);
  return {
    manifestHash,
    records,
    passed,
    failed: records.filter((r) => r.result === 'fail').length,
    blocked: records.filter((r) => r.result === 'blocked').length,
    summary,
  };
}

function tiersFromArgv(): (0 | 1 | 2)[] {
  const tiers: (0 | 1 | 2)[] = [];
  for (let i = argv.indexOf('--tier'); i >= 0; i = argv.indexOf('--tier', i + 1)) {
    const value = Number(argv[i + 1]);
    if (value === 0 || value === 1 || value === 2) tiers.push(value);
  }
  return tiers.length ? tiers : [0];
}

async function main(): Promise<number> {
  const runnerName = (argv.find((a) => a.startsWith('--runner='))?.split('=')[1] ??
    argv[argv.indexOf('--runner') + 1] ??
    'headless');
  if (runnerName !== 'headless' && runnerName !== 'echo') {
    console.error(`runAnchors: unknown runner '${runnerName}' (headless | echo)`);
    return 2;
  }
  if (runnerName === 'headless' && !env.ZELARI_API_KEY && !env.ZELARI_LOCAL_CLI && !env.ZELARI_EVAL_ALLOW_HEADLESS) {
    console.error(
      'runAnchors: headless runner needs credentials (ZELARI_API_KEY / ZELARI_LOCAL_CLI). ' +
        'Refusing to seed the store with fake outcomes — set ZELARI_EVAL_ALLOW_HEADLESS=1 to override explicitly.',
    );
    return 3;
  }
  const storeArg = argv[argv.indexOf('--store') + 1];
  const store = storeArg ? new EvalResultStore(path.resolve(storeArg)) : EvalResultStore.default();
  const limitArg = Number(argv[argv.indexOf('--limit') + 1]);
  const repeatArg = argv.includes('--repeat') ? Number(argv[argv.indexOf('--repeat') + 1]) : undefined;
  if (repeatArg !== undefined && (!Number.isInteger(repeatArg) || repeatArg < 1)) {
    console.error('runAnchors: --repeat must be an integer >= 1');
    return 2;
  }
  const runner: AgentRunner =
    runnerName === 'echo'
      ? () => ({ ok: true, toolCalls: 1, wallMs: 1 })
      : headlessAgentRunner();

  const result = await runAnchorSuite({
    tiers: tiersFromArgv(),
    store,
    runner,
    limit: limitArg || undefined,
    repeat: repeatArg,
  });
  console.log(
    `\n[runAnchors] suite done: ${result.passed} pass / ${result.failed} fail / ${result.blocked} blocked`,
  );
  console.log(`candidate-hash: ${result.manifestHash}`);
  if (env.GITHUB_ENV) {
    appendFileSync(env.GITHUB_ENV, `ZELARI_CANDIDATE_HASH=${result.manifestHash}\n`, 'utf8');
  }
  if (argv.includes('--strict') && result.passed !== result.records.length) return 1;
  return 0;
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  // F11: exit only AFTER the async suite completes — a synchronous exit(0)
  // would kill the process before the store is seeded / GITHUB_ENV written.
  main().then(
    (code) => exit(code),
    (err: unknown) => {
      console.error(`runAnchors: ${(err as Error).message}`);
      exit(1);
    },
  );
}
