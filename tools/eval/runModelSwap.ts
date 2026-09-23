/*
 * tools/eval/runModelSwap.ts — K4.6/F28 model swap test (plan W4 → I5).
 *
 * Baseline vs candidate LEAD model on the same case: pass-rate, guard-code
 * delta (which codes fired, baseline vs candidate) and cost (RunCost totals
 * from cost.ts — token totals are the measure here, this harness never prices
 * models). K4.6 is the prereq that makes K4.5 (quality escalation) measurable.
 *
 *   node --experimental-strip-types tools/eval/runModelSwap.ts --help
 *
 *   # execute — run the case ONCE per lead model, then compare:
 *   node --experimental-strip-types tools/eval/runModelSwap.ts \
 *     --baseline-model <id> --candidate-model <id> \
 *     --fixture <dir> --task "<prompt>" [--provider <id>] [--check "<cmd>"] \
 *     [--timeout-ms <ms>] [--out <dir>]
 *
 *   # read — compare two captures written by an earlier --out run:
 *   node --experimental-strip-types tools/eval/runModelSwap.ts \
 *     --baseline-run <capture.json> --candidate-run <capture.json> \
 *     [--baseline-model <id>] [--candidate-model <id>]
 *
 * WHY THE MODEL RIDES THE ARM ENV (F28): `--model` is per-experiment
 * (arms/runner.ts), so the swap arms pin the lead via `OPENAI_MODEL`, the
 * providerConfig env override that always wins (leadModelSwapArms in
 * arms/experiments.ts). Guard codes ride the raw NDJSON stream: arms/metrics.ts
 * keeps aggregate counts only and stays untouched — the per-code counters are
 * extracted here. Capture failures are recorded, never hidden: a failed run
 * still produces a comparable report.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, env as processEnv, exit } from 'node:process';
import {
  GUARD_AB_REPORT_GUARD_CODES,
  leadModelSwapArms,
} from './arms/experiments.ts';
import { metricsFromNdjson } from './arms/metrics.ts';
import { composeArmEnv } from './arms/runner.ts';
import type { ArmRunMetrics, EvalArm } from './arms/types.ts';
import { addCost, type RunCost, zeroCost } from './cost.ts';

const DEFAULT_TIMEOUT_MS = 180_000;

export interface SwapArgs {
  help: boolean;
  baselineModel?: string;
  candidateModel?: string;
  fixture?: string;
  task?: string;
  provider?: string;
  check?: string;
  out?: string;
  baselineRun?: string;
  candidateRun?: string;
  timeoutMs: number;
}

export function parseSwapArgs(argvList: readonly string[]): SwapArgs {
  const arg = (name: string): string | undefined => {
    const i = argvList.indexOf(`--${name}`);
    return i >= 0 ? argvList[i + 1] : undefined;
  };
  const timeoutRaw = Number.parseInt(arg('timeout-ms') ?? '', 10);
  return {
    help: argvList.includes('--help') || argvList.includes('-h'),
    baselineModel: arg('baseline-model'),
    candidateModel: arg('candidate-model'),
    fixture: arg('fixture'),
    task: arg('task'),
    provider: arg('provider'),
    check: arg('check'),
    out: arg('out'),
    baselineRun: arg('baseline-run'),
    candidateRun: arg('candidate-run'),
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
  };
}

/** One executed case: the RAW NDJSON stream is what guard codes are read from. */
export interface SwapRunCase {
  id: string;
  passed: boolean;
  ndjson: string[];
  error?: string;
}

/** Persistable swap run (written by --out, read by --*-run). */
export interface SwapCapture {
  version: 1;
  kind: 'model-swap-capture';
  model: string;
  armId: string;
  createdAt: string;
  cases: SwapRunCase[];
}

/**
 * K4.6/F28 — per-code guard counters from the raw NDJSON stream. Counts the
 * `code` of `error` / `runtime_warning` events (tool_call_truncated,
 * text_tools_parse_failed, assistant_text_loop…). Garbage lines never throw.
 */
export function guardCodesFromNdjson(lines: readonly string[]): Record<string, number> {
  const codes: Record<string, number> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let ev: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      ev = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type !== 'error' && ev.type !== 'runtime_warning') continue;
    if (typeof ev.code !== 'string' || ev.code.length === 0) continue;
    codes[ev.code] = (codes[ev.code] ?? 0) + 1;
  }
  return codes;
}

export interface SwapSideSummary {
  side: 'baseline' | 'candidate';
  model: string;
  runs: number;
  passed: number;
  passRate: number;
  guardCodes: Record<string, number>;
  cost: RunCost;
}

/** ArmRunMetrics → RunCost (cost.ts): tokens/toolCalls/wall as the cost measure. */
function costFromMetrics(m: ArmRunMetrics): RunCost {
  return {
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheHitTokens: m.cachedTokens,
    toolCalls: m.toolCalls,
    modelCostUsd: 0,
    wallMs: m.durationMs,
  };
}

export function summarizeSwapSide(
  side: 'baseline' | 'candidate',
  model: string,
  capture: SwapCapture,
): SwapSideSummary {
  const guardCodes: Record<string, number> = {};
  let cost = zeroCost();
  let passed = 0;
  for (const c of capture.cases) {
    const m = metricsFromNdjson(c.ndjson, c.passed);
    if (m.passed) passed += 1;
    cost = addCost(cost, costFromMetrics(m));
    for (const [code, n] of Object.entries(guardCodesFromNdjson(c.ndjson))) {
      guardCodes[code] = (guardCodes[code] ?? 0) + n;
    }
  }
  const runs = capture.cases.length;
  return {
    side,
    model,
    runs,
    passed,
    passRate: runs > 0 ? passed / runs : 0,
    guardCodes,
    cost,
  };
}

export interface GuardCodeDeltaRow {
  code: string;
  baseline: number;
  candidate: number;
  delta: number;
}

/** Which guard codes fired, baseline vs candidate (candidate − baseline). */
export function compareGuardCodes(
  baseline: Readonly<Record<string, number>>,
  candidate: Readonly<Record<string, number>>,
): GuardCodeDeltaRow[] {
  const codes = new Set<string>(GUARD_AB_REPORT_GUARD_CODES);
  for (const code of Object.keys(baseline)) codes.add(code);
  for (const code of Object.keys(candidate)) codes.add(code);
  return [...codes].sort().map((code) => ({
    code,
    baseline: baseline[code] ?? 0,
    candidate: candidate[code] ?? 0,
    delta: (candidate[code] ?? 0) - (baseline[code] ?? 0),
  }));
}

function pct1(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function signed(n: number, decimals = 0): string {
  const v = decimals > 0 ? n.toFixed(decimals) : String(Math.round(n));
  return n > 0 ? `+${v}` : v;
}

function row3(label: string, b: string, c: string, d: string): string {
  return `| ${label} | ${b} | ${c} | ${d} |`;
}

/** Markdown report: pass-rate, guard-code delta, cost (plan K4.6). */
export function renderSwapReport(input: {
  baseline: SwapSideSummary;
  candidate: SwapSideSummary;
}): string {
  const b = input.baseline;
  const c = input.candidate;
  const guardRows = compareGuardCodes(b.guardCodes, c.guardCodes).map((g) =>
    row3(`\`${g.code}\``, String(g.baseline), String(g.candidate), signed(g.delta)),
  );
  const costRow = (label: string, get: (cost: RunCost) => number): string =>
    row3(label, String(get(b.cost)), String(get(c.cost)), signed(get(c.cost) - get(b.cost)));
  return [
    '# K4.6/F28 model swap report — baseline vs candidate',
    '',
    `- baseline \`${b.side}\` model \`${b.model}\` · candidate \`${c.side}\` model \`${c.model}\``,
    `- runs: ${b.runs} baseline / ${c.runs} candidate · cost metric: RunCost (cost.ts) — tokens are the measure, no model pricing here`,
    '',
    '## pass-rate',
    '',
    '| metric | baseline | candidate | delta |',
    '|---|---|---|---|',
    row3('pass-rate', pct1(b.passRate), pct1(c.passRate), `${signed((c.passRate - b.passRate) * 100, 1)}pp`),
    row3('passed runs', `${b.passed}/${b.runs}`, `${c.passed}/${c.runs}`, signed(c.passed - b.passed)),
    '',
    '## guard-code delta (candidate − baseline)',
    '',
    '| guard code | baseline | candidate | delta |',
    '|---|---|---|---|',
    ...guardRows,
    '',
    '## cost (RunCost totals)',
    '',
    '| metric | baseline | candidate | delta |',
    '|---|---|---|---|',
    costRow('input tokens', (x) => x.inputTokens),
    costRow('output tokens', (x) => x.outputTokens),
    costRow('cached tokens', (x) => x.cacheHitTokens),
    costRow('tool calls', (x) => x.toolCalls),
    costRow('wall ms', (x) => x.wallMs),
    '',
  ].join('\n');
}

export function loadSwapCapture(file: string): SwapCapture {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`not a swap capture object: ${file}`);
  }
  const capture = parsed as Partial<SwapCapture>;
  if (capture.kind !== 'model-swap-capture' || !Array.isArray(capture.cases)) {
    throw new Error(`not a model-swap-capture (kind/cases mismatch): ${file}`);
  }
  return capture as SwapCapture;
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  error?: string;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; shell?: boolean },
): Promise<SpawnResult> {
  return new Promise((settle) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell ?? false,
      timeout: opts.timeoutMs,
    });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.on('error', (err: Error) => settle({ code: null, stdout, error: err.message }));
    child.on('close', (code = null) => settle({ code, stdout }));
  });
}

/**
 * INTEGRATION (real CLI + provider): run the same case once per lead-model
 * arm and keep the RAW stream per side. Failures land in `cases[].error` —
 * the report must still be comparable (runner.ts contract, kept).
 */
export async function executeSwap(input: {
  baselineModel: string;
  candidateModel: string;
  fixture: string;
  task: string;
  provider?: string;
  check?: string;
  timeoutMs: number;
  cliEntry?: string;
}): Promise<{ baseline: SwapCapture; candidate: SwapCapture }> {
  const arms = leadModelSwapArms({
    baseline: input.baselineModel,
    candidate: input.candidateModel,
  });
  // cliEntry may be repo-relative; the child cwd is the FIXTURE, so resolve it
  // against THIS process's cwd first (runner.ts lesson — MODULE_NOT_FOUND otherwise).
  const entryAbs = resolve(input.cliEntry ?? 'bin/zelari-code.js');
  const fixture = resolve(input.fixture);
  const parentEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === 'string') parentEnv[key] = value;
  }
  const baseEnv: Record<string, string> = {
    ...parentEnv,
    // Keep provider selection and the OPENAI_MODEL override on the SAME
    // provider (both are providerConfig env overrides — env always wins).
    ...(input.provider ? { ANATHEMA_ACTIVE_PROVIDER: input.provider } : {}),
  };

  const runSide = async (arm: EvalArm): Promise<SwapCapture> => {
    const res = await runProcess(
      process.execPath,
      [
        entryAbs,
        '--headless',
        '--task',
        input.task,
        '--output',
        'json',
        ...(input.provider ? ['--provider', input.provider] : []),
      ],
      { cwd: fixture, env: composeArmEnv(baseEnv, arm), timeoutMs: input.timeoutMs },
    );
    const ndjson = res.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    let error = res.error ?? (res.code !== 0 ? `cli exited ${String(res.code)}` : undefined);
    if (error === undefined && input.check) {
      const chk = await runProcess(input.check, [], {
        cwd: fixture,
        env: composeArmEnv(baseEnv, arm),
        timeoutMs: input.timeoutMs,
        shell: true,
      });
      if (chk.code !== 0) error = `check exited ${String(chk.code)}`;
    }
    return {
      version: 1,
      kind: 'model-swap-capture',
      model: arm.model ?? '',
      armId: arm.id,
      createdAt: new Date().toISOString(),
      cases: [
        {
          id: 'case-1',
          passed: error === undefined,
          ndjson,
          ...(error ? { error } : {}),
        },
      ],
    };
  };

  const baseline = await runSide(arms[0]!);
  const candidate = await runSide(arms[1]!);
  return { baseline, candidate };
}

function usage(): string {
  return [
    'K4.6/F28 model swap test (runModelSwap.ts) — baseline vs candidate lead model:',
    'report with pass-rate, guard-code delta and cost (RunCost token totals).',
    '',
    'execute (runs the case once per lead model):',
    '  node --experimental-strip-types tools/eval/runModelSwap.ts \\',
    '    --baseline-model <id> --candidate-model <id> \\',
    '    --fixture <dir> --task "<prompt>" [--provider <id>] [--check "<cmd>"] \\',
    '    [--timeout-ms <ms>] [--out <dir>]',
    '',
    'read (compares two captures written by an earlier --out run):',
    '  node --experimental-strip-types tools/eval/runModelSwap.ts \\',
    '    --baseline-run <capture.json> --candidate-run <capture.json> \\',
    '    [--baseline-model <id>] [--candidate-model <id>]',
    '',
    'Baseline/candidate models are passed with --baseline-model / --candidate-model',
    '(arms lead-baseline / lead-candidate — leadModelSwapArms in arms/experiments.ts).',
  ].join('\n');
}

async function main(): Promise<number> {
  const args = parseSwapArgs(argv.slice(2));
  if (args.help || argv.length <= 2) {
    console.log(usage());
    return 0;
  }

  let baselineCapture: SwapCapture;
  let candidateCapture: SwapCapture;
  if (args.baselineRun && args.candidateRun) {
    baselineCapture = loadSwapCapture(resolve(args.baselineRun));
    candidateCapture = loadSwapCapture(resolve(args.candidateRun));
  } else if (args.baselineModel && args.candidateModel && args.fixture && args.task) {
    console.log(
      `runModelSwap: executing swap baseline=${args.baselineModel} candidate=${args.candidateModel} fixture=${args.fixture}`,
    );
    const executed = await executeSwap({
      baselineModel: args.baselineModel,
      candidateModel: args.candidateModel,
      fixture: args.fixture,
      task: args.task,
      provider: args.provider,
      check: args.check,
      timeoutMs: args.timeoutMs,
    });
    baselineCapture = executed.baseline;
    candidateCapture = executed.candidate;
    if (args.out) {
      const outDir = resolve(args.out);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'baseline-capture.json'), JSON.stringify(baselineCapture, null, 2));
      writeFileSync(join(outDir, 'candidate-capture.json'), JSON.stringify(candidateCapture, null, 2));
      console.log(`runModelSwap: captures -> ${outDir}`);
    }
  } else {
    console.error(
      'runModelSwap: pass EITHER --baseline-run + --candidate-run (read) OR --baseline-model + --candidate-model + --fixture + --task (execute)\n',
    );
    console.error(usage());
    return 2;
  }

  const baseline = summarizeSwapSide(
    'baseline',
    args.baselineModel ?? baselineCapture.model,
    baselineCapture,
  );
  const candidate = summarizeSwapSide(
    'candidate',
    args.candidateModel ?? candidateCapture.model,
    candidateCapture,
  );
  console.log(renderSwapReport({ baseline, candidate }));
  return 0;
}

if (argv[1] && resolve(argv[1]) === resolve(import.meta.filename)) {
  main().then(exit, (err: unknown) => {
    console.error(`runModelSwap: ${err instanceof Error ? err.message : String(err)}`);
    exit(2);
  });
}
