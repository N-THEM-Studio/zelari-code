#!/usr/bin/env node
/**
 * scripts/mission-metrics.mjs — M2 budget-ceiling measurement
 * (ZELARI-2.37-NEXT.md §Fase M2, tasks M2.3/M2.4).
 *
 * Reads the persisted mission state (<dir>/.zelari/mission-state.json) and
 * reports the repair/token/cost telemetry the mission loop already
 * accumulates (src/cli/zelariMission.ts, ADR-0013 budget cap), comparing it
 * against the CANONICAL mission ceilings:
 *
 *   ZELARI_MISSION_MAX_ITER    (default 6)   display denominator only
 *   ZELARI_MISSION_MAX_TOKENS  (default off) breach if cumulativeTokens over
 *   ZELARI_MISSION_MAX_COST    (default off) breach if cumulativeCostUsd over
 *   --max-repairs <n>          (default off) breach if repair window over
 *
 * Exit codes:
 *   0 = state read, within every DEFINED ceiling (unset ceilings are off)
 *   1 = bad args / missing or invalid state file
 *   2 = at least one defined ceiling breached, or a defined ceiling cannot be
 *       certified because the state lacks the number (M2.4: unknown ≠ pass —
 *       `tokens: null` can never satisfy a token ceiling)
 *
 * Honesty notes: `cumulativeTokens`/`cumulativeCostUsd` are absolute mission
 * totals; `repairHistory` is a WINDOW (the loop keeps the last 10 entries —
 * zelariMission.ts `slice(-10)`), so the repair count is labelled as such.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const USAGE = `usage: node scripts/mission-metrics.mjs [--dir <workspace>] [--max-repairs <n>] [--json]

  --dir           workspace containing .zelari/mission-state.json (default: cwd)
  --max-repairs   repair-window ceiling (no canonical env; pass explicitly)
  --json          machine-readable single-object output

Ceilings mirror the mission loop env contract (zelariMission.ts):
  ZELARI_MISSION_MAX_ITER (6) · ZELARI_MISSION_MAX_TOKENS (off) · ZELARI_MISSION_MAX_COST (off)

exit 0 within ceilings · 1 bad input · 2 ceiling breached / not certifiable`;

function parseArgs(argv) {
  const out = { dir: '.', json: false, maxRepairs: undefined, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--dir') {
      out.dir = argv[++i];
      if (!out.dir) return { ...out, error: '--dir requires a value' };
    } else if (a === '--max-repairs') {
      const raw = argv[++i];
      const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) return { ...out, error: '--max-repairs requires a non-negative integer' };
      out.maxRepairs = n;
    } else return { ...out, error: `unknown argument: ${a}` };
  }
  return out;
}

/** Same parse semantics as resolveMaxTokens/resolveMaxCost in zelariMission.ts. */
function envCap(env, name, kind) {
  const raw = env[name];
  if (!raw) return undefined;
  const n = kind === 'float' ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function envIter(env) {
  const raw = env.ZELARI_MISSION_MAX_ITER;
  const n = raw ? Number.parseInt(raw, 10) : 6;
  return Number.isFinite(n) && n > 0 ? n : 6;
}

const statePath = (dir) => path.resolve(dir, '.zelari', 'mission-state.json');

function readMetrics(state) {
  const repairs = Array.isArray(state.repairHistory) ? state.repairHistory : [];
  const gapKeys = new Set(repairs.map((r) => r && r.gapKey).filter(Boolean));
  return {
    missionId: typeof state.missionId === 'string' ? state.missionId : null,
    status: typeof state.status === 'string' ? state.status : null,
    iteration: typeof state.iteration === 'number' ? state.iteration : null,
    repairs: {
      window: repairs.length,
      distinctGaps: gapKeys.size,
      unchanged: repairs.filter((r) => r && r.outcome === 'unchanged').length,
    },
    tokens: typeof state.cumulativeTokens === 'number' ? state.cumulativeTokens : null,
    costUsd: typeof state.cumulativeCostUsd === 'number' ? state.cumulativeCostUsd : null,
    traceSlices: Array.isArray(state.trace) ? state.trace.length : 0,
  };
}

/** M2.4 semantics: a DEFINED ceiling with a null measurement is a breach (not certifiable). */
function checkBreaches(m, ceilings) {
  const breaches = [];
  if (ceilings.tokens !== undefined && (m.tokens === null || m.tokens > ceilings.tokens)) {
    breaches.push(
      m.tokens === null
        ? `tokens: ceiling ${ceilings.tokens} set but state reports no cumulativeTokens — not certifiable`
        : `tokens: ${m.tokens} > ceiling ${ceilings.tokens}`,
    );
  }
  if (ceilings.costUsd !== undefined && (m.costUsd === null || m.costUsd > ceilings.costUsd)) {
    breaches.push(
      m.costUsd === null
        ? `cost: ceiling ${ceilings.costUsd} set but state reports no cumulativeCostUsd — not certifiable`
        : `cost: ${m.costUsd} > ceiling ${ceilings.costUsd}`,
    );
  }
  if (ceilings.repairs !== undefined && m.repairs.window > ceilings.repairs) {
    breaches.push(`repairs: window ${m.repairs.window} > ceiling ${ceilings.repairs}`);
  }
  return breaches;
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
if (args.error) {
  console.error(`[mission-metrics] ${args.error}\n${USAGE}`);
  process.exit(1);
}

const ceilings = {
  tokens: envCap(process.env, 'ZELARI_MISSION_MAX_TOKENS', 'int'),
  costUsd: envCap(process.env, 'ZELARI_MISSION_MAX_COST', 'float'),
  repairs: args.maxRepairs,
};
const maxIter = envIter(process.env);

let raw;
try {
  raw = await fs.readFile(statePath(args.dir), 'utf8');
} catch {
  console.error(`[mission-metrics] cannot read ${statePath(args.dir)} — run this in a workspace where a mission has persisted state`);
  process.exit(1);
}
let state;
try {
  state = JSON.parse(raw);
} catch (err) {
  console.error(`[mission-metrics] invalid JSON in ${statePath(args.dir)}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const m = readMetrics(state);
const breaches = checkBreaches(m, ceilings);
const report = {
  ok: breaches.length === 0,
  workspace: path.resolve(args.dir),
  stateFile: statePath(args.dir),
  missionId: m.missionId,
  status: m.status,
  iteration: m.iteration,
  iterationBudget: { used: m.iteration, max: maxIter },
  repairs: m.repairs,
  tokens: m.tokens,
  costUsd: m.costUsd,
  traceSlices: m.traceSlices,
  ceilings: { tokens: ceilings.tokens, costUsd: ceilings.costUsd, repairs: ceilings.repairs },
  breaches,
};

if (args.json) {
  console.log(JSON.stringify(report));
} else {
  const cap = (v) => (v === undefined ? 'off' : String(v));
  const val = (v) => (v === null ? 'null (not reported)' : String(v));
  console.log(`[mission-metrics] ${report.workspace}`);
  console.log(`  mission       ${val(m.missionId)} (${val(m.status)})`);
  console.log(`  iteration     ${val(m.iteration)}/${maxIter}`);
  console.log(`  repairs       ${m.repairs.window} (window ≤10) · ${m.repairs.distinctGaps} distinct gaps · ${m.repairs.unchanged} unchanged (ceiling: ${cap(ceilings.repairs)})`);
  console.log(`  tokens        ${val(m.tokens)} (ceiling: ${cap(ceilings.tokens)})`);
  console.log(`  cost usd      ${val(m.costUsd)} (ceiling: ${cap(ceilings.costUsd)})`);
  console.log(`  trace slices  ${m.traceSlices}`);
  console.log(breaches.length === 0 ? 'VERDICT: within every defined ceiling' : `VERDICT: BREACH (${breaches.length})`);
  for (const b of breaches) console.error(`  - ${b}`);
}

process.exit(breaches.length === 0 ? 0 : 2);
