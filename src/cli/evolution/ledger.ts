/**
 * ledger — append-only outcome ledger for the Evolution Engine v0 (ADR-0036).
 *
 * One JSON object per line under `<cwd>/.zelari/evolution/ledger.jsonl`.
 * Rules:
 *   - written ONLY when ZELARI_EVOLUTION=shadow (default '0' ⇒ no-op);
 *   - append-only: nothing in this module ever rewrites or deletes lines;
 *   - fail-open: a ledger failure must NEVER break a run (it is telemetry,
 *     not a gate — the judge lives elsewhere by constitution);
 *   - tolerant replay: corrupt lines are skipped, not fatal.
 *
 * The ledger records OUTCOMES. Proposals/promotions stay in the existing
 * tools/eval evolvePropose/evolveDecide pipeline — this module never proposes
 * and never promotes anything (P1: the proposer is not the measurer).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Env var gating every ledger write (and the whole evolution v0 surface). */
export const EVOLUTION_ENV = 'ZELARI_EVOLUTION';

export type EvolutionMode = '0' | 'shadow';

/** Ledger location, relative to the project root (project-scoped by design). */
export const LEDGER_REL = path.join('.zelari', 'evolution', 'ledger.jsonl');

export type LedgerVerdict = 'PASS' | 'FAIL' | 'HOLD' | 'UNKNOWN';

export interface LedgerEntry {
  /** Stable run id (session/mission id from the caller). */
  runId: string;
  /** ISO timestamp of the run outcome. */
  at: string;
  mode: EvolutionMode;
  /** From classifyTask — the routing/fitness key. */
  taskClass: string;
  verdict: LedgerVerdict;
  /** Best evidence tier backing the verdict (ADR-0023 vocabulary). */
  evidenceTier?: string;
  toolCalls?: number;
  /** /steer --interrupt count — behavioural signal (anti-Goodhart). */
  steerCount?: number;
  rollbackUsed?: boolean;
  costUsd?: number;
  /** Wall-clock duration of the run in ms, when the caller knows it. */
  latencyMs?: number;
  /** Harness manifest hash when known — fitness validity boundary. */
  manifestHash?: string;
}

/** Resolve the active evolution mode (default off, ADR-0036). */
export function evolutionMode(env: Record<string, string | undefined> = process.env): EvolutionMode {
  return env[EVOLUTION_ENV] === 'shadow' ? 'shadow' : '0';
}

export function ledgerPath(cwd: string): string {
  return path.join(cwd, LEDGER_REL);
}

export interface AppendResult {
  written: boolean;
  path?: string;
  reason?: string;
}

/**
 * Append one outcome entry. No-op (not an error) when evolution is off.
 * Never throws: fs failures come back as `{ written: false, reason }`.
 */
export function appendLedgerEntry(cwd: string, entry: LedgerEntry): AppendResult {
  if (evolutionMode() === '0') {
    return { written: false, reason: `${EVOLUTION_ENV} != shadow — ledger write skipped` };
  }
  try {
    const file = ledgerPath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return { written: true, path: file };
  } catch (err) {
    return {
      written: false,
      reason: `ledger append failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Tolerant replay: read every parsable line, skip corrupt ones silently —
 * the ledger must stay readable even after a partial write.
 */
export function readLedger(cwd: string): LedgerEntry[] {
  const file = ledgerPath(cwd);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LedgerEntry;
      if (typeof parsed?.runId === 'string' && typeof parsed?.at === 'string') {
        out.push(parsed);
      }
    } catch {
      // corrupt line — skip (tolerant replay)
    }
  }
  return out;
}

// ─── Deterministic fitness v1 (t42, ADR-0036) ─────────────────────────────
//
// Pure arithmetic over ledger entries. NO LLM anywhere: the module that
// proposes (tools/eval evolvePropose) never computes this — whoever reads
// fitness only reads, never proposes (P1: proposer ≠ measurer).
//
// Tier weights — how much a verdict counts, based on the evidence backing it
// (the evidence ladder applied to the engine itself):
//   1.0  build / tool-output / command-output   — event-backed, traceable
//   0.9  fs-observation                          — deterministic read, no exec
//   0.25 anything else or missing                — claimed-ish, near-zero trust
// Verdict handling: PASS=1, FAIL=0; HOLD and UNKNOWN are EXCLUDED from both
// numerator and denominator (unknown ≠ pass AND unknown ≠ fail — ADR-0023).

const TIER_WEIGHTS: Record<string, number> = {
  build: 1,
  'tool-output': 1,
  'command-output': 1,
  tool: 1,
  command: 1,
  'fs-observation': 0.9,
  fs: 0.9,
};
const UNTIERED_WEIGHT = 0.25;

function tierWeight(tier: string | undefined): number {
  if (!tier) return UNTIERED_WEIGHT;
  return TIER_WEIGHTS[tier] ?? UNTIERED_WEIGHT;
}

/** True for verdicts that count towards pass-rate (PASS or FAIL only). */
function isRated(verdict: string): boolean {
  return verdict === 'PASS' || verdict === 'FAIL';
}

export interface ClassFitness {
  runs: number;
  /** Simple PASS / (PASS+FAIL) — no tier weighting. */
  passRate: number;
  /** Tier-weighted pass rate in [0,1] (see weights above). */
  weightedPassRate: number;
  /** Mean costUsd over entries that carry it. */
  avgCostUsd?: number;
  /** Mean latencyMs over entries that carry it. */
  avgLatencyMs?: number;
  /** Mean steerCount over entries that carry it (behavioural signal). */
  avgSteerCount?: number;
  /** Share of entries with rollbackUsed=true. */
  rollbackRate: number;
}

export interface LedgerStats {
  runs: number;
  byVerdict: Record<string, number>;
  byClass: Record<string, number>;
  firstAt?: string;
  lastAt?: string;
  /** Tier-weighted global pass rate over rated (PASS|FAIL) runs. */
  weightedPassRate?: number;
  avgSteerCount?: number;
  rollbackRate?: number;
  avgCostUsd?: number;
  avgLatencyMs?: number;
  /** Per-taskClass deterministic fitness (the routing/fitness key). */
  byClassFitness: Record<string, ClassFitness>;
}

function mean(nums: readonly number[]): number | undefined {
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function classFitness(entries: readonly LedgerEntry[]): ClassFitness {
  const rated = entries.filter((e) => isRated(e.verdict));
  const passRate =
    rated.length === 0 ? 0 : rated.filter((e) => e.verdict === 'PASS').length / rated.length;
  const wSum = rated.reduce((acc, e) => acc + tierWeight(e.evidenceTier), 0);
  const wPass = rated
    .filter((e) => e.verdict === 'PASS')
    .reduce((acc, e) => acc + tierWeight(e.evidenceTier), 0);
  return {
    runs: entries.length,
    passRate,
    weightedPassRate: wSum === 0 ? 0 : wPass / wSum,
    avgCostUsd: mean(entries.map((e) => e.costUsd).filter((c): c is number => typeof c === 'number')),
    avgLatencyMs: mean(
      entries.map((e) => e.latencyMs).filter((c): c is number => typeof c === 'number'),
    ),
    avgSteerCount: mean(
      entries.map((e) => e.steerCount).filter((c): c is number => typeof c === 'number'),
    ),
    rollbackRate:
      entries.length === 0 ? 0 : entries.filter((e) => e.rollbackUsed === true).length / entries.length,
  };
}

/** Aggregate stats + deterministic fitness for `--evolve-status` / `/evolve`. */
export function ledgerStats(entries: readonly LedgerEntry[]): LedgerStats {
  const byVerdict: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  const byClassEntries: Record<string, LedgerEntry[]> = {};
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  for (const e of entries) {
    byVerdict[e.verdict] = (byVerdict[e.verdict] ?? 0) + 1;
    byClass[e.taskClass] = (byClass[e.taskClass] ?? 0) + 1;
    (byClassEntries[e.taskClass] ??= []).push(e);
    if (!firstAt || e.at < firstAt) firstAt = e.at;
    if (!lastAt || e.at > lastAt) lastAt = e.at;
  }
  const byClassFitness: Record<string, ClassFitness> = {};
  for (const [cls, list] of Object.entries(byClassEntries)) {
    byClassFitness[cls] = classFitness(list);
  }
  const global = classFitness(entries);
  return {
    runs: entries.length,
    byVerdict,
    byClass,
    ...(firstAt ? { firstAt } : {}),
    ...(lastAt ? { lastAt } : {}),
    ...(global.weightedPassRate !== undefined && entries.some((e) => isRated(e.verdict))
      ? { weightedPassRate: global.weightedPassRate }
      : {}),
    ...(global.avgSteerCount !== undefined ? { avgSteerCount: global.avgSteerCount } : {}),
    ...(entries.length > 0 ? { rollbackRate: global.rollbackRate } : {}),
    ...(global.avgCostUsd !== undefined ? { avgCostUsd: global.avgCostUsd } : {}),
    ...(global.avgLatencyMs !== undefined ? { avgLatencyMs: global.avgLatencyMs } : {}),
    byClassFitness,
  };
}
