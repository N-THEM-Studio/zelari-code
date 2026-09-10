#!/usr/bin/env node
/**
 * dogfood-driver.mjs — orchestrator for a dogfood mission (t52, live half).
 *
 *   node scripts/dogfood-driver.mjs [--task <id>] [--base <ref>]
 *
 * brief (plan.json) -> live zelari mission -> synthesis-vs-diff audit.
 * Off by default and honest: with no provider (ZELARI_API_KEY / ZELARI_LOCAL_CLI)
 * or no built dist/ it refuses to fake a mission and exits 2 INSUFFICIENT-DATA,
 * mirroring tools/eval/runExploreFlipGate.ts. The audit decision is propagated
 * unchanged (0 pass · 1 ungrounded claim · 2 insufficient-data). The synthesis is
 * also kept at `.zelari/dogfood/synthesis.md` (gitignored) — the artifact the
 * PR workflow looks for, so a human can attach it to the PR.
 *
 * No PR is opened here — that stays a human/gh step (no gh auth in this
 * environment). See docs/GUIDA.md ("Dogfooding this repo").
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PLAN, formatBrief, loadPlan, pickTask } from './dogfood-brief.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MISSION = path.join(REPO_ROOT, 'scripts', 'run-zelari-mission-live.mjs');
const AUDIT = path.join(REPO_ROOT, 'scripts', 'dogfood-audit.mjs');

export const USAGE =
  'usage: node scripts/dogfood-driver.mjs [--task <id>] [--base <ref>] (exit 0 audit pass · 1 ungrounded · 2 insufficient-data)';

export function parseArgs(args) {
  const opts = { task: null, plan: DEFAULT_PLAN, base: null };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const next = args[i + 1];
    if (flag !== '--task' && flag !== '--plan' && flag !== '--base') return `unknown argument "${flag}"`;
    if (next === undefined) return `${flag} requires a value`;
    i += 1;
    if (flag === '--base') opts.base = next;
    else if (flag === '--task') opts.task = next;
    else opts.plan = next;
  }
  return opts;
}

/** origin/main when it exists locally, HEAD~1 otherwise (the driver's own contract). */
export function resolveBase(explicit) {
  if (explicit) return explicit;
  const probe = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return probe.status === 0 ? 'origin/main' : 'HEAD~1';
}

export function main(args) {
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    console.error(`dogfood-driver: ${parsed}`);
    console.error(USAGE);
    return 2;
  }

  if (!process.env.ZELARI_API_KEY && !process.env.ZELARI_LOCAL_CLI) {
    console.error(
      'dogfood-driver: INSUFFICIENT-DATA — no provider key (ZELARI_API_KEY or ZELARI_LOCAL_CLI); ' +
        'audit script is unit-tested but a live mission needs credentials.',
    );
    return 2;
  }
  if (!existsSync(path.join(REPO_ROOT, 'dist', 'cli', 'zelariMission.js'))) {
    console.error('dogfood-driver: INSUFFICIENT-DATA — dist/ is not built; run `npm run build:cli` first.');
    return 2;
  }

  let task;
  try {
    task = pickTask(loadPlan(parsed.plan).tasks ?? [], parsed.task);
  } catch (err) {
    task = null;
  }
  if (!task) {
    console.error(`dogfood-driver: INSUFFICIENT-DATA — no brief available (plan "${parsed.plan}" missing or no pending task).`);
    return 2;
  }

  const base = resolveBase(parsed.base);
  const workDir = mkdtempSync(path.join(tmpdir(), 'zelari-dogfood-'));
  const brief = formatBrief(task);
  const briefPath = path.join(workDir, 'brief.md');
  writeFileSync(briefPath, brief, 'utf8');

  console.log(`dogfood-driver: task ${task.id} | base ${base} | brief ${briefPath}`);
  const mission = spawnSync(process.execPath, [MISSION, brief, REPO_ROOT], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const synthesis = (mission.stdout ?? '').trim();
  if (synthesis.length === 0) {
    console.error(`dogfood-driver: INSUFFICIENT-DATA — the live mission produced no synthesis (exit ${mission.status ?? 'signal'}); nothing to audit.`);
    return 2;
  }
  const synthesisPath = path.join(workDir, 'synthesis.md');
  writeFileSync(synthesisPath, synthesis, 'utf8');
  const kept = path.join(REPO_ROOT, '.zelari', 'dogfood', 'synthesis.md');
  mkdirSync(path.dirname(kept), { recursive: true });
  writeFileSync(kept, synthesis, 'utf8');
  console.log(`dogfood-driver: synthesis kept at ${kept}`);

  const audit = spawnSync(
    process.execPath,
    [AUDIT, '--synthesis', synthesisPath, '--base', base, '--cwd', REPO_ROOT, '--out', path.join('.zelari', 'dogfood', 'audit.md')],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  return audit.status ?? 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
