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

/** Findings ledger location (S1) — instance-level failure findings, append-only. */
export const FINDINGS_REL = path.join('.zelari', 'evolution', 'findings.jsonl');

/**
 * S1 — every project-scoped evolution artifact, relative to the root. Kept in
 * one place so runners (tools/eval) and the CLI agree on disk layout. Adding a
 * path here is additive; existing paths never move (append-only culture).
 */
export const EVOLUTION_PATHS = {
  /** Outcome ledger (ADR-0036) — one JSON object per run. */
  ledger: LEDGER_REL,
  /** Instance-level findings ledger — the input to the pattern ledger (S1). */
  findings: FINDINGS_REL,
  /** Proposals store — owned by tools/eval evolvePropose (read-only here). */
  proposals: path.join('.zelari', 'evolution', 'proposals.jsonl'),
  /** Failure-pattern clusters — derived, append-only (S1). */
  patternLedger: path.join('.zelari', 'evolution', 'pattern-ledger.jsonl'),
} as const;

/**
 * S1 — one instance-level failure finding.
 *
 * A Finding is a *record of one mechanism fired in one task* (telemetry), NOT a
 * proposal (the proposer lives in tools/eval, P1). `taskKey` is the
 * instance-origin key (mission task id / hash(task text) / session id) used by
 * the pattern ledger to distinguish "same mechanism across DISTINCT tasks" from
 * "one task retried N times". It is instance data, NOT identity: it is
 * deliberately EXCLUDED from the fingerprint so the same mechanism still
 * merges.
 */
export interface Finding {
  /** Finding kind (e.g. a spine-evidence kind, or a harness lifecycle kind). */
  kind: string;
  /** Harness operator the finding would revise, when known. */
  operator?: string;
  /** Surface the finding applies to, e.g. 'tool:read_file'. */
  surface?: string;
  /** Primary signal key. */
  signal?: string;
  /** Occurrence count (default 1). */
  count?: number;
  /** Session ids the evidence came from. */
  sessions?: string[];
  /** Instance-origin key — mission task id / hash(task text) / session id. */
  taskKey?: string;
  /** Task class (classifyTask) — a DIMENSION, never the cluster key. */
  taskClass?: string;
  /** ISO timestamp of the first observation. */
  firstAt?: string;
  /** ISO timestamp of the last observation. */
  lastAt?: string;
  /** Structured evidence (toolName / errorClass / termination / …). */
  evidence?: Record<string, unknown>;
}

/**
 * Stable fingerprint of a finding's KIND — identity, not instance. taskKey,
 * count and timestamps are excluded so the same mechanism merges as evidence
 * accumulates (mirrors the proposal fingerprint contract).
 */
export function findingFingerprint(f: Finding): string {
  return [f.kind || 'unknown', f.operator || '-', f.surface || '-', f.signal || '-'].join('|');
}

export function findingsPath(cwd: string): string {
  return path.join(cwd, FINDINGS_REL);
}

/**
 * Append instance findings. No-op (not an error) when evolution is off — same
 * gate as the outcome ledger (default-off, ADR-0036). Never throws: fs failures
 * come back as `{ written: false, reason }` (fail-open telemetry).
 */
export function appendFindings(cwd: string, findings: readonly Finding[]): AppendResult {
  if (evolutionMode() === '0') {
    return { written: false, reason: `${EVOLUTION_ENV} != shadow — findings write skipped` };
  }
  if (findings.length === 0) {
    return { written: false, reason: 'no findings' };
  }
  try {
    const file = findingsPath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${findings.map((f) => JSON.stringify(f)).join('\n')}\n`, 'utf8');
    return { written: true, path: file };
  } catch (err) {
    return {
      written: false,
      reason: `findings append failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Tolerant replay for the findings ledger: parse every line, skip corrupt ones
 * silently, require a string `kind` (the one mandatory field). Never throws.
 */
export function readFindings(cwd: string): Finding[] {
  const file = findingsPath(cwd);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Finding[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Finding;
      if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') {
        out.push(parsed);
      }
    } catch {
      // corrupt line — skip (tolerant replay)
    }
  }
  return out;
}

export type LedgerVerdict = 'PASS' | 'FAIL' | 'HOLD' | 'UNKNOWN';

/**
 * Check-id prefix of the honesty FAMILY in the verification report vocabulary
 * (packages/core .../council/verification/types.ts): `synthesis.honesty`,
 * `synthesis.tier-inflation`, `synthesis.cite-invalid`,
 * `synthesis.degraded-banner`. They all grade the chairman's CLAIMS against
 * traceable evidence — exactly what "honesty" means in this codebase.
 */
export const HONESTY_CHECK_PREFIX = 'synthesis.';

/**
 * Synthesis-honesty signal for one run.
 *
 * Derivation is arithmetic over a report that already exists — `linted: false`
 * is reserved for "there was a report but the lint family emitted nothing".
 * There is NO way to express "we did not look": that case omits `honesty`
 * entirely (unknown ≠ clean, P1).
 */
export interface LedgerHonesty {
  /** A verification report existed for this run (the lint family could run). */
  linted: boolean;
  /** Honesty-family checks that FAILED (0 when linted and clean). */
  flagged: number;
}

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
  /**
   * Synthesis-honesty lint outcome (ADR-0023 / P1). Written ONLY at call-sites
   * where a verification report is in scope — an absent field means "not
   * measured here", never "clean" (unknown ≠ pass).
   */
  honesty?: LedgerHonesty;
  toolCalls?: number;
  /** /steer --interrupt count — behavioural signal (anti-Goodhart). */
  steerCount?: number;
  rollbackUsed?: boolean;
  costUsd?: number;
  /** Wall-clock duration of the run in ms, when the caller knows it. */
  latencyMs?: number;
  /** Harness manifest hash when known — fitness validity boundary. */
  manifestHash?: string;
  /**
   * Runtime model/provider attribution (HarnessDev steal #2): harness gains
   * are model-dependent, so an entry without them confounds the engine's
   * fitness. Optional + tolerant replay keeps old lines valid.
   */
  model?: string;
  provider?: string;
  /** Provider-reported prompt tokens summed over the run (never estimated). */
  inputTokens?: number;
  /** Provider-reported completion tokens summed over the run (never estimated). */
  outputTokens?: number;
  /**
   * Provider-reported prompt tokens served from the provider prefix cache — a
   * SUBSET of `inputTokens` (name matches `RunTelemetryAccumulator.usage()`
   * `cacheHitTokens`, the runtime source of truth; the arm metrics call the
   * same number `ArmRunMetrics.cachedTokens`). Present only when ≥1 provider
   * usage report backed it: no provider report ⇒ the field is omitted.
   */
  cacheHitTokens?: number;
}

/** Resolve the active evolution mode (default off, ADR-0036). */
export function evolutionMode(env: Record<string, string | undefined> = process.env): EvolutionMode {
  return env[EVOLUTION_ENV] === 'shadow' ? 'shadow' : '0';
}

export function ledgerPath(cwd: string): string {
  return path.join(cwd, LEDGER_REL);
}

/**
 * Derive the ledger honesty signal from a verification report's `results`.
 * Pure and total: `undefined` when the run produced NO report (unknown — the
 * caller then omits the field), and `flagged` counts only FAILED checks of the
 * honesty family. A missing check is never read as a violation, and a passing
 * one never as evidence that the lint ran.
 */
export function honestyFromVerificationResults(
  results: readonly { id: string; ok: boolean }[] | undefined | null,
): LedgerHonesty | undefined {
  if (!results) return undefined;
  return {
    linted: true,
    flagged: results.filter((r) => !r.ok && r.id.startsWith(HONESTY_CHECK_PREFIX)).length,
  };
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
  /** Mean honesty flags over entries that carried `honesty` (WS7 slice 0). */
  avgHonestyFlags?: number;
  /**
   * Token-weighted provider cache hit rate (0..1) over entries carrying BOTH
   * `cacheHitTokens` and a positive `inputTokens`. Undefined when no entry had
   * a provider-backed cache report — absence is not a 0% hit rate.
   */
  cacheHitRate?: number;
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
  /** Mean honesty flags over entries that carried `honesty` (WS7 slice 0). */
  avgHonestyFlags?: number;
  /** Token-weighted provider cache hit rate over cache-reporting entries. */
  cacheHitRate?: number;
  /** Per-taskClass deterministic fitness (the routing/fitness key). */
  byClassFitness: Record<string, ClassFitness>;
}

function mean(nums: readonly number[]): number | undefined {
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Token-weighted provider cache hit rate over the entries that actually carry
 * both numbers. Entries without a provider cache report contribute nothing —
 * the result is `undefined` rather than a flattering 0.
 */
function cacheHitRate(entries: readonly LedgerEntry[]): number | undefined {
  const withCache = entries.filter(
    (e) =>
      typeof e.cacheHitTokens === 'number' &&
      typeof e.inputTokens === 'number' &&
      e.inputTokens > 0,
  );
  if (withCache.length === 0) return undefined;
  const hit = withCache.reduce((acc, e) => acc + (e.cacheHitTokens ?? 0), 0);
  const prompt = withCache.reduce((acc, e) => acc + (e.inputTokens ?? 0), 0);
  return prompt > 0 ? hit / prompt : undefined;
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
    avgHonestyFlags: mean(
      entries.map((e) => e.honesty?.flagged).filter((c): c is number => typeof c === 'number'),
    ),
    cacheHitRate: cacheHitRate(entries),
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
    ...(global.avgHonestyFlags !== undefined ? { avgHonestyFlags: global.avgHonestyFlags } : {}),
    ...(global.cacheHitRate !== undefined ? { cacheHitRate: global.cacheHitRate } : {}),
    byClassFitness,
  };
}
