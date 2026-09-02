/*
 * tools/eval/runEditBench.ts — t79 live runner (INTEGRATION, real provider).
 *
 *   npm run edit:bench -- --model cheap-model-id [--reps 3] [--count 200]
 *     [--baseline-ref v2.23.0] [--baseline-entry path/to/cli.js] [--skip-baseline]
 *     [--out eval/results/edit-bench]
 *
 * Arms: "anchored-edit" = current tree; "legacy-relocating" = CLI checked out
 * at --baseline-ref in a git worktree (pre-ADR-0033 catalog: edit_file +
 * apply_diff rilocante). Fixtures are re-materialized before EVERY run so each
 * run is a first shot from a clean workspace. After each arm pass, every case
 * file gets a syntax check (residual parse-error count).
 *
 * Output: outdir/run-TS/manifest.json (raw) + report.md (delta). Exit 0 only
 * when the report was written; capture failures are recorded, never hidden.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import type { ArmRunRecord, EvalCase } from './arms/types.ts';
import { runExperiment } from './arms/runner.ts';
import {
  EDIT_BENCH_CASES,
  EDIT_BENCH_REPS,
  EDIT_BENCH_SEED,
  type ArmSummary,
  type EditBenchPatch,
  editBenchArms,
  generateEditBenchSet,
  modelPinEnv,
  renderDeltaReport,
  summarizeArm,
} from './editBench.ts';

function arg(name: string): string | undefined {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

function sh(cmd: string, cwd?: string): { ok: boolean; stdout: string } {
  const res = spawnSync(cmd, { shell: true, encoding: 'utf8', cwd, timeout: 600000 });
  return { ok: (res.status ?? -1) === 0, stdout: (res.stdout ?? '') + (res.stderr ?? '') };
}

function materialize(root: string, cases: EditBenchPatch[]): Map<string, string> {
  const dirs = new Map<string, string>();
  rmSync(root, { recursive: true, force: true });
  for (const c of cases) {
    const dir = join(root, c.id);
    mkdirSync(dir, { recursive: true });
    for (const f of c.files) writeFileSync(join(dir, f.path), f.content);
    dirs.set(c.id, dir);
  }
  return dirs;
}

function toEvalCases(cases: EditBenchPatch[], dirs: Map<string, string>): EvalCase[] {
  return cases.map((c) => ({
    id: c.id,
    prompt: c.task,
    cwdFixture: dirs.get(c.id) as string,
    timeoutMs: 180000,
    expected: { command: { cmd: c.success[0].command, expectExit: 0 } },
  }));
}

/** Residual-corruption count: files still failing a syntax check post-run. */
function countParseErrors(
  cases: EditBenchPatch[],
  dirs: Map<string, string>,
): { failed: number; checked: number; unavailable: boolean } {
  const firstDir = dirs.get(cases[0].id) as string;
  const probe = sh('node --experimental-strip-types --check t.mts', firstDir);
  const pyOk = sh('python --version').ok;
  if (!probe.ok) {
    console.error('edit:bench: syntax checker unavailable (node --check probe failed) — parse-error count SKIPPED (loud, not zero)');
    return { failed: -1, checked: 0, unavailable: true };
  }
  let failed = 0;
  let checked = 0;
  for (const c of cases) {
    const dir = dirs.get(c.id) as string;
    for (const f of c.files) {
      if (f.path.startsWith('t.')) continue; // test files are bench-owned, not agent output
      const cmd =
        c.language === 'ts'
          ? 'node --experimental-strip-types --check ' + f.path
          : 'python -m py_compile ' + f.path;
      if (c.language === 'py' && !pyOk) continue;
      checked++;
      if (!sh(cmd, dir).ok) failed++;
    }
  }
  return { failed, checked, unavailable: false };
}

function setupBaselineWorktree(outDir: string, ref: string): string | null {
  const wt = join(outDir, 'baseline-worktree');
  rmSync(wt, { recursive: true, force: true });
  console.log('edit:bench: git worktree add ' + wt + ' ' + ref + ' (baseline CLI pre-ADR-0033)');
  if (!sh('git worktree add "' + wt + '" ' + ref).ok) {
    console.error('edit:bench: worktree add FAILED for ref ' + ref + ' — pass --baseline-entry or --skip-baseline');
    return null;
  }
  console.log('edit:bench: npm install in baseline worktree (one-off, --ignore-scripts)...');
  if (!sh('npm install --ignore-scripts --no-audit --no-fund', wt).ok) {
    console.error('edit:bench: baseline npm install FAILED');
    return null;
  }
  return join(wt, 'bin', 'zelari-code.js');
}

function main(): number {
  const model = arg('model');
  const reps = Number.parseInt(arg('reps') ?? String(EDIT_BENCH_REPS), 10);
  const count = Number.parseInt(arg('count') ?? String(EDIT_BENCH_CASES), 10);
  const seed = Number.parseInt(arg('seed') ?? String(EDIT_BENCH_SEED), 10);
  const outDir = resolve(arg('out') ?? 'eval/results/edit-bench');
  const baselineRef = arg('baseline-ref') ?? 'v2.23.0';
  const skipBaseline = argv.includes('--skip-baseline');

  if (!model) {
    console.error('usage: runEditBench.ts --model cheap-model-id [--reps N] [--count N] [--baseline-ref git-ref | --baseline-entry path | --skip-baseline] [--out dir]');
    return 2;
  }
  if (!Number.isFinite(reps) || reps < 1) {
    console.error('edit:bench: --reps must be a positive integer');
    return 2;
  }

  const cases = generateEditBenchSet(seed, count);
  const arms = editBenchArms().filter((a) => !(skipBaseline && a.cliEntry === null));
  let baselineEntry = arg('baseline-entry') ?? null;
  if (!skipBaseline && !baselineEntry) {
    baselineEntry = setupBaselineWorktree(outDir, baselineRef);
    if (!baselineEntry) return 2;
  }

  const runDir = join(outDir, 'run-' + new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });
  const baseEnv = { ...modelPinEnv(model), ZELARI_RUNTIME_OBSERVERS: '1' };
  const runsByArm = new Map<string, ArmRunRecord[]>();
  const parseErrorsByArm = new Map<string, number>();
  const manifests: unknown[] = [];
  const gitCommit = sh('git rev-parse HEAD').stdout.trim();

  for (const arm of arms) {
    const cliEntry = arm.cliEntry ?? baselineEntry ?? '';
    const collected: ArmRunRecord[] = [];
    let parseFailed = 0;
    for (let rep = 1; rep <= reps; rep++) {
      const fixtureRoot = join(runDir, 'fixtures', arm.armId, 'rep-' + rep);
      const dirs = materialize(fixtureRoot, cases);
      const evalCases = toEvalCases(cases, dirs);
      console.log('edit:bench: arm=' + arm.armId + ' rep=' + rep + '/' + reps + ' cases=' + evalCases.length + ' entry=' + cliEntry);
      const manifest = runExperiment({
        experimentId: 'edit-bench-' + arm.armId + '-r' + rep,
        cases: evalCases,
        arms: [{ id: arm.armId, env: arm.env }],
        baseEnv,
        cliEntry,
        model,
      });
      manifests.push(manifest);
      collected.push(...manifest.runs);
      const pe = countParseErrors(cases, dirs);
      if (pe.unavailable) parseFailed = -1;
      else if (parseFailed >= 0) parseFailed += pe.failed;
    }
    runsByArm.set(arm.armId, collected);
    parseErrorsByArm.set(arm.armId, parseFailed);
  }

  const summarize = (armId: string): ArmSummary =>
    summarizeArm(armId, runsByArm.get(armId) ?? [], parseErrorsByArm.get(armId) ?? 0);
  const candidate = summarize('anchored-edit');
  const baseline = skipBaseline ? candidate : summarize('legacy-relocating');

  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), seed, count, reps, model, baselineRef, gitCommit, summaries: { baseline, candidate }, manifests }, null, 2));
  const report = skipBaseline
    ? renderDeltaReport({ seed, count, reps, model, baselineRef: 'n/a (--skip-baseline)', gitCommit }, candidate, candidate)
    : renderDeltaReport({ seed, count, reps, model, baselineRef, gitCommit }, baseline, candidate);
  writeFileSync(join(runDir, 'report.md'), report);

  console.log('\nedit:bench: RAW -> ' + join(runDir, 'manifest.json') + '\nedit:bench: REPORT -> ' + join(runDir, 'report.md') + '\n');
  console.log(report);
  return 0;
}

if (argv[1] && resolve(argv[1]) === resolve(import.meta.filename)) {
  exit(main());
}
