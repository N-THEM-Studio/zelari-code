/*
 * tools/eval/runCompetitiveBench.ts — competitive benchmark runner (t35+t36,
 * closes t31): runs the SAME pinned anchors against zelari AND the competitor
 * CLIs (codex / claude / opencode), writing per-run JSON + a markdown
 * comparison report under eval/results/competitive/.
 *
 *   node --experimental-strip-types tools/eval/runCompetitiveBench.ts \
 *     [--dry-run] [--anchors id1,id2,...] [--agents zelari,codex,claude,opencode] \
 *     [--runs N] [--out <dir>]
 *
 * Deliberate choices:
 *  - ADVISORY-ONLY: output never gates CI (t31 requirement). Exit stays 0
 *    when a competitor binary is missing — recorded as skip, never failed.
 *  - `--dry-run` is the primary verification path: validates the anchor
 *    selection, resolves adapters via PATH scan (filesystem only) and prints
 *    the plan. NO network, NO LLM, NO spawned process.
 *  - Golden signal is the anchor's own deterministic success checks (doc
 *    §7.7) run in each workspace after the agent — identical criteria for
 *    every agent, so the comparison stays apples-to-apples.
 *  - Tokens/cost are recorded only when an agent actually reports them;
 *    nothing is inferred (report shows n/a otherwise).
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { argv, exit } from 'node:process';
import path from 'node:path';
import { loadAnchors } from './anchorLoader.ts';
import type { AnchorManifest } from './types.ts';
import {
  allAdapters,
  parseZelariUsage,
  probeVersion,
  REPO_ROOT,
  zelariChildEnv,
  type AgentAdapter,
} from './competitive/adapters.ts';
import { AGENT_IDS, BenchManifestSchema, CompetitiveRunRecordSchema, type AgentId, type AgentResolution, type CompetitiveRunRecord } from './competitive/schema.ts';
import { formatMarkdownReport, formatPlan } from './competitive/report.ts';

const DEFAULT_ANCHORS_DIR = path.resolve(import.meta.dirname, '../../eval/anchors');
const DEFAULT_RESULTS_ROOT = path.resolve(import.meta.dirname, '../../eval/results/competitive');
/** Same defaults as runAnchors.ts (§7.7 shell semantics for fixture/check commands). */
const CHECK_SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
const CHECK_TIMEOUT_MS = 120_000;

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function tail(text: string, max = 400): string {
  const s = String(text ?? '');
  return s.length > max ? `…${s.slice(-max)}` : s;
}

/** Default: the first 3 pinned local-bugfix anchors (stable loader order). */
function defaultAnchorIds(anchors: readonly AnchorManifest[]): string[] {
  const bugfix = anchors.filter((a) => a.tags.includes('local-bugfix'));
  return (bugfix.length > 0 ? bugfix : anchors).slice(0, 3).map((a) => a.id);
}

function selectAnchors(all: readonly AnchorManifest[], csv: string | undefined): AnchorManifest[] {
  const wanted = csv ? csv.split(',').map((s) => s.trim()).filter(Boolean) : defaultAnchorIds(all);
  const byId = new Map(all.map((a) => [a.id, a]));
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    console.error(`runCompetitiveBench: unknown anchor id(s): ${unknown.join(', ')}\navailable: ${all.map((a) => a.id).join(', ')}`);
    exit(2);
  }
  return wanted.map((id) => byId.get(id) as AnchorManifest);
}

/** Resolve adapters via PATH scan — no process spawned (dry-run safe). */
function resolveAdapters(agentIds: readonly AgentId[]): { adapters: AgentAdapter[]; resolutions: AgentResolution[] } {
  const adapters = allAdapters().filter((a) => agentIds.includes(a.id));
  const resolutions: AgentResolution[] = adapters.map((a) => {
    const located = a.locate();
    return {
      agent: a.id,
      available: located.found,
      version: null,
      note: located.found ? '' : `binary not found on PATH (${a.preview})`,
    };
  });
  return { adapters, resolutions };
}

/**
 * Windows-resilient scratch removal: Defender / delayed handles can hold a
 * fresh workspace dir for a few hundred ms after the child exits, which made
 * plain rmSync throw EPERM and kill the whole bench (observed in the first
 * real smoke). Best-effort with retries; a stubborn dir is left behind with
 * a warning — never a crash (advisory tool).
 */
function rmScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    console.warn(`[bench] warning: could not remove scratch ${dir} (${code}) — leaving it behind`);
  }
}

/** Deterministic fixture materialization (inline files, then commands). */
function materializeFixture(anchor: AnchorManifest, workspaceDir: string): { ok: boolean; failed?: string; code?: number } {
  for (const file of anchor.fixture.files) {
    const target = path.join(workspaceDir, ...file.path.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  for (const cmd of anchor.fixture.commands) {
    const res = spawnSync(cmd, { cwd: workspaceDir, shell: CHECK_SHELL, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, windowsHide: true });
    if ((res.status ?? -1) !== 0) return { ok: false, failed: cmd, code: res.status ?? -1 };
  }
  return { ok: true };
}

/** The ONLY golden signal: anchor success checks in the workspace (§7.7). */
function runSuccessChecks(anchor: AnchorManifest, workspaceDir: string): { ok: boolean; firstFailure: string | null } {
  for (const check of anchor.success) {
    const res = spawnSync(check.command, { cwd: workspaceDir, shell: CHECK_SHELL, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, windowsHide: true });
    const expect = check.expectExit ?? 0;
    if ((res.status ?? -1) !== expect) {
      return { ok: false, firstFailure: `${check.command} → exit ${res.status ?? 'null'} (expected ${expect})` };
    }
  }
  return { ok: true, firstFailure: null };
}

function zelariVersionFromPackageJson(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

interface RunContext {
  outDir: string;
  scratchRoot: string;
  runs: number;
  zelariVersion: string | null;
}

function runOne(input: {
  ctx: RunContext;
  adapter: AgentAdapter;
  resolution: AgentResolution;
  anchor: AnchorManifest;
  runIndex: number;
}): CompetitiveRunRecord {
  const { ctx, adapter, anchor, runIndex } = input;
  const recordedAt = new Date().toISOString();
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `zelari-bench-${anchor.id}-`));
  try {
    const taskFile = path.join(workspaceDir, '.anchor-task.txt');
    writeFileSync(taskFile, anchor.task, 'utf8');
    const setup = materializeFixture(anchor, workspaceDir);
    if (!setup.ok) {
      return CompetitiveRunRecordSchema.parse({
        agent: adapter.id, agentLabel: adapter.label, agentVersion: input.resolution.version, model: 'undeclared',
        anchorId: anchor.id, anchorVersion: anchor.version, runIndex, status: 'error', exitCode: setup.code ?? -1,
        wallMs: 0, checksFailed: null, tokens: null, costUsd: null,
        detail: `fixture setup failed: ${setup.failed}`, recordedAt,
      });
    }
    const spec = adapter.buildSpawn({ anchor, taskFile, prompt: anchor.task });
    const timeoutMs = (anchor.budget.maxWallMs ?? 600_000) + 60_000; // grace, mirroring runAnchors
    const startedAt = Date.now();
    const res = spawnSync(spec.program, spec.args, {
      cwd: workspaceDir,
      encoding: 'utf8',
      timeout: timeoutMs,
      shell: spec.shell,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: adapter.id === 'zelari' ? zelariChildEnv(ctx.scratchRoot) : process.env,
    });
    const wallMs = Date.now() - startedAt;
    const checks = runSuccessChecks(anchor, workspaceDir);
    const spawnError = res.error ? `spawn failed: ${res.error.message}` : null;
    return CompetitiveRunRecordSchema.parse({
      agent: adapter.id,
      agentLabel: adapter.label,
      agentVersion: input.resolution.version,
      model: 'undeclared',
      anchorId: anchor.id,
      anchorVersion: anchor.version,
      runIndex,
      status: checks.ok ? 'pass' : spawnError ? 'error' : 'fail',
      exitCode: res.status ?? null,
      wallMs,
      checksFailed: checks.firstFailure,
      tokens: adapter.id === 'zelari' ? parseZelariUsage(String(res.stdout ?? '')) : null,
      costUsd: null,
      detail: [spawnError, res.stderr ? tail(res.stderr) : null, checks.firstFailure].filter(Boolean).join(' | '),
      recordedAt,
    });
  } finally {
    rmScratch(workspaceDir);
  }
}

function runBench(input: { adapters: AgentAdapter[]; resolutions: AgentResolution[]; anchors: AnchorManifest[]; flags: { anchors: string[]; agents: AgentId[]; runs: number }; outDir: string }): number {
  const scratchRoot = mkdtempSync(path.join(tmpdir(), 'zelari-competitive-'));
  mkdirSync(input.outDir, { recursive: true });

  // Probe versions once per agent (real runs only — spawns `--version`).
  const versions = new Map<AgentId, string | null>();
  const zelariVersion = zelariVersionFromPackageJson();
  for (const r of input.resolutions) {
    const adapter = input.adapters.find((a) => a.id === r.agent);
    versions.set(r.agent, r.available && adapter && adapter.id !== 'zelari' ? probeVersion(adapter) : adapter?.id === 'zelari' ? zelariVersion : null);
    r.version = versions.get(r.agent) ?? null;
  }

  const manifest = BenchManifestSchema.parse({
    kind: 'competitive-bench',
    recordedAt: new Date().toISOString(),
    dryRun: false,
    flags: input.flags,
    anchors: input.anchors.map((a) => ({ id: a.id, version: a.version, tier: a.tier })),
    agents: input.resolutions,
    versions: { zelari: zelariVersion },
  });
  writeFileSync(path.join(input.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const ctx: RunContext = { outDir: input.outDir, scratchRoot, runs: input.flags.runs, zelariVersion };
  const runsFile = path.join(input.outDir, 'runs.jsonl');
  const records: CompetitiveRunRecord[] = [];
  for (const resolution of input.resolutions) {
    const adapter = input.adapters.find((a) => a.id === resolution.agent) as AgentAdapter;
    if (!resolution.available) {
      console.log(`[bench] ${resolution.agent}: skip — ${resolution.note}`);
      continue;
    }
    for (const anchor of input.anchors) {
      for (let runIndex = 0; runIndex < ctx.runs; runIndex++) {
        const record = runOne({ ctx, adapter, resolution, anchor, runIndex });
        records.push(record);
        appendFileSync(runsFile, JSON.stringify(record) + '\n', 'utf8');
        console.log(`[bench] ${record.agent} × ${record.anchorId} #${runIndex}: ${record.status} in ${(record.wallMs / 1000).toFixed(1)}s`);
      }
    }
  }
  rmScratch(scratchRoot);

  const report = formatMarkdownReport({
    outDir: input.outDir,
    manifestAnchors: manifest.anchors,
    agents: input.resolutions,
    zelariVersion,
    records,
  });
  writeFileSync(path.join(input.outDir, 'report.md'), report, 'utf8');
  console.log('\n' + report + '\n');
  console.log(`[bench] done: ${records.length} record(s) in ${input.outDir} (advisory-only — never a CI gate)`);
  return 0;
}

function main(): number {
  const dryRun = argv.includes('--dry-run');
  // 2.31 C1: default 3 runs — a single run is an anecdote; three make a
  // median and a spread. Free override with --runs N.
  const runsRaw = Number.parseInt(arg('runs') ?? '3', 10);
  if (!Number.isInteger(runsRaw) || runsRaw < 1) {
    console.error('runCompetitiveBench: --runs must be an integer >= 1');
    return 2;
  }
  const agentIds = (arg('agents') ?? AGENT_IDS.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean) as AgentId[];
  const unknownAgents = agentIds.filter((id) => !AGENT_IDS.includes(id));
  if (unknownAgents.length > 0) {
    console.error(`runCompetitiveBench: unknown agent id(s): ${unknownAgents.join(', ')} (known: ${AGENT_IDS.join(', ')})`);
    return 2;
  }
  const all = existsSync(DEFAULT_ANCHORS_DIR) ? loadAnchors(DEFAULT_ANCHORS_DIR) : [];
  if (all.length === 0) {
    console.error(`runCompetitiveBench: no anchors found under ${DEFAULT_ANCHORS_DIR}`);
    return 2;
  }
  const anchors = selectAnchors(all, arg('anchors'));
  const { adapters, resolutions } = resolveAdapters(agentIds);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const outDir = arg('out') ? path.resolve(arg('out') as string) : path.join(DEFAULT_RESULTS_ROOT, stamp);

  if (dryRun) {
    console.log(formatPlan({ anchors, resolutions, runs: runsRaw, outDir }));
    return 0;
  }
  return runBench({
    adapters,
    resolutions,
    anchors,
    flags: { anchors: anchors.map((a) => a.id), agents: agentIds, runs: runsRaw },
    outDir,
  });
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  const code = main();
  exit(code);
}
