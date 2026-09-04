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

export interface LedgerStats {
  runs: number;
  byVerdict: Record<string, number>;
  byClass: Record<string, number>;
  firstAt?: string;
  lastAt?: string;
}

/** Aggregate stats for `--evolve-status` (read-only). */
export function ledgerStats(entries: readonly LedgerEntry[]): LedgerStats {
  const byVerdict: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  for (const e of entries) {
    byVerdict[e.verdict] = (byVerdict[e.verdict] ?? 0) + 1;
    byClass[e.taskClass] = (byClass[e.taskClass] ?? 0) + 1;
    if (!firstAt || e.at < firstAt) firstAt = e.at;
    if (!lastAt || e.at > lastAt) lastAt = e.at;
  }
  return { runs: entries.length, byVerdict, byClass, firstAt, lastAt };
}
