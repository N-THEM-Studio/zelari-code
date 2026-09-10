/**
 * exploreFlipGate — t57/C4: the decision harness for the `explore`
 * quick-default flip.
 *
 * Why a gate and not a switch
 * ---------------------------
 * `explore` tentacles run at `medium` thoroughness today. Flipping the
 * default to `quick` buys latency and tokens on every plan, and pays for it
 * with *less* coverage of the files the plan ends up touching. A flip
 * decided by intuition would be justified by the very metric it degrades,
 * so this module is the measuring instrument that has to answer first:
 * compare the explore→plan coverage ratio of sessions whose explore ran
 * `medium`/`deep` (baseline) against sessions whose explore ran `quick`
 * (flip), and refuse to decide below a minimum number of sessions per phase.
 *
 * Design (all deliberate)
 * -----------------------
 *   - **pure core**: `classifySession` / `evaluateFlipGate` are functions of
 *     their arguments — no I/O, no clock, no env, so a verdict is
 *     reproducible from the recorded sessions alone;
 *   - **honest unknown**: a session whose explore sidecars carry no
 *     `thoroughness:` header (every session written before C4) is EXCLUDED,
 *     never guessed into a phase. A mixed-mode session is excluded too:
 *     `quick + medium` is not a phase, it is two experiments in one number;
 *   - **median, not mean**: one pathological session must not move a verdict
 *     that authorises a default change;
 *   - **strictly greater-than**: exactly `maxDropPp` is a KEEP — a tie is not
 *     a revert, and float noise at the boundary must not decide either (see
 *     `round6`);
 *   - **fail-open I/O**: `scanTentacleReports` is the only reader, and
 *     unreadable / corrupt `coverage.json` entries are counted and skipped,
 *     never fatal.
 *
 * Status semantics: `'insufficient-data'` (fewer than `minSessions` valid
 * sessions in either phase) | `'revert'` | `'keep'`.
 *
 * Scope note (deliberate): this module MEASURES and DECIDES nothing else —
 * it never flips the default, never writes, and never touches a run.
 *
 * The only import is a type (erased at runtime), so this file runs as-is
 * under `node --experimental-strip-types` from `tools/eval/`.
 *
 * No I/O at import time.
 *
 * @since v2.x — t57/C4 gate per il flip quick di explore
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExploreCoverageReport } from './exploreCoverage.js';

/** Default sidecar root, relative to the cwd of the run being measured. */
export const TENTACLE_REPORTS_ROOT = path.join('.zelari', 'radio', 'tentacles');

/** Minimum valid sessions PER PHASE before any verdict other than 'insufficient-data'. */
export const DEFAULT_MIN_SESSIONS = 5;

/** Maximum tolerated coverage drop, in percentage points, of the flip median. */
export const DEFAULT_MAX_DROP_PP = 10;

/** Thoroughness values that count as baseline (thorough explores). */
const BASELINE_MODES = new Set(['medium', 'deep']);

/** The flip phase: exactly this one mode, nothing else. */
const FLIP_MODE = 'quick';

export type SessionPhase = 'baseline' | 'flip' | 'excluded';

export type GateStatus = 'keep' | 'revert' | 'insufficient-data';

/**
 * Minimal shape the gate needs from a coverage report. `ExploreCoverageReport`
 * is assignable to it, and a legacy report parsed from disk (no mode
 * information at all) is a valid value of it — it lands in 'excluded'.
 */
export interface GateReportInput {
  sessionId?: string;
  /** Explore→plan coverage ratio (0..1). Missing/non-finite ⇒ unusable. */
  ratio?: number;
  /** Sorted unique thoroughness values declared by the session's explore sidecars. */
  exploreModes?: string[];
  /** Explore sidecars that declared no mode (legacy headers). */
  exploreModesUnknown?: number;
}

export interface FlipGateOptions {
  /** Valid sessions required in EACH phase before deciding. Default 5. */
  minSessions?: number;
  /** Tolerated drop in percentage points. Default 10; exactly this keeps. */
  maxDropPp?: number;
}

export interface PhaseStats {
  n: number;
  /** Median coverage ratio of the phase, in percentage points (null when n = 0). */
  medianPp: number | null;
}

export interface FlipGateResult {
  status: GateStatus;
  /**
   * (baseline median − flip median) × 100, rounded to 6 decimals; null when
   * the status is 'insufficient-data'.
   */
  dropPp: number | null;
  baseline: PhaseStats;
  flip: PhaseStats;
  /** Reports that entered no phase (legacy, mixed, or unusable ratio). */
  excludedCount: number;
  minSessions: number;
  maxDropPp: number;
  /** Human-readable, decision-honest summary of the verdict. */
  reason: string;
}

/** Float noise guard: ratios come out of a division (0.6 − 0.5 = 9.99…pp). */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Median of a ratio list (even count: mean of the two middles). Null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function toPp(ratio: number | null): number | null {
  return ratio === null ? null : round6(ratio * 100);
}

function isUsableRatio(ratio: unknown): ratio is number {
  return typeof ratio === 'number' && Number.isFinite(ratio);
}

/**
 * Which phase a session's coverage report belongs to.
 *
 * - `'flip'` — exploreModes is EXACTLY `['quick']`;
 * - `'baseline'` — exploreModes is non-empty and every mode is medium/deep;
 * - `'excluded'` — everything else: no mode recorded (legacy sidecars),
 *   partially recorded modes, or a mix of quick with anything.
 *
 * The exclusion is the honest branch: a session we cannot phase is a session
 * we cannot count, and guessing it would corrupt the very comparison the flip
 * is authorised by.
 */
export function classifySession(report: GateReportInput | null | undefined): SessionPhase {
  const modes = (report?.exploreModes ?? []).filter(
    (mode): mode is string => typeof mode === 'string' && mode.trim() !== '',
  );
  if (modes.length === 0) return 'excluded';
  // A silently-unlabelled explore sidecar makes the phase of this session
  // unknown: the flip comparison must not inherit a guess.
  if ((report?.exploreModesUnknown ?? 0) > 0) return 'excluded';
  if (modes.length === 1 && modes[0] === FLIP_MODE) return 'flip';
  return modes.every((mode) => BASELINE_MODES.has(mode)) ? 'baseline' : 'excluded';
}

/**
 * The verdict. Groups the reports by phase, takes the MEDIAN coverage ratio
 * of each phase and compares them in percentage points of drop.
 *
 * 'insufficient-data' whenever either phase has fewer than `minSessions`
 * valid reports — an empty tentacles dir therefore never reads as 'keep'.
 * Otherwise 'revert' iff the drop is strictly greater than `maxDropPp`.
 */
export function evaluateFlipGate(
  reports: readonly GateReportInput[],
  opts: FlipGateOptions = {},
): FlipGateResult {
  const minSessions = opts.minSessions ?? DEFAULT_MIN_SESSIONS;
  const maxDropPp = opts.maxDropPp ?? DEFAULT_MAX_DROP_PP;

  const baselineRatios: number[] = [];
  const flipRatios: number[] = [];
  let excludedCount = 0;

  for (const report of reports ?? []) {
    const phase = classifySession(report);
    const ratio = (report ?? {}).ratio;
    if (phase === 'excluded' || !isUsableRatio(ratio)) {
      excludedCount += 1;
      continue;
    }
    if (phase === 'baseline') baselineRatios.push(ratio);
    else flipRatios.push(ratio);
  }

  const baselineMedian = median(baselineRatios);
  const flipMedian = median(flipRatios);
  const baseline: PhaseStats = { n: baselineRatios.length, medianPp: toPp(baselineMedian) };
  const flip: PhaseStats = { n: flipRatios.length, medianPp: toPp(flipMedian) };
  const common = { baseline, flip, excludedCount, minSessions, maxDropPp };

  if (baselineRatios.length < minSessions || flipRatios.length < minSessions) {
    const excludedNote =
      excludedCount > 0 ? ` — ${excludedCount} report(s) excluded (legacy/mixed/unusable)` : '';
    return {
      ...common,
      status: 'insufficient-data',
      dropPp: null,
      reason:
        `insufficient data: baseline n=${baselineRatios.length}/${minSessions}, ` +
        `flip n=${flipRatios.length}/${minSessions}${excludedNote}. No verdict — the flip stays unmade.`,
    };
  }

  const dropPp = round6(((baselineMedian as number) - (flipMedian as number)) * 100);
  const status: GateStatus = dropPp > maxDropPp ? 'revert' : 'keep';
  const balance =
    `baseline n=${baselineRatios.length} median=${baseline.medianPp}pp, ` +
    `flip n=${flipRatios.length} median=${flip.medianPp}pp`;
  return {
    ...common,
    status,
    dropPp,
    reason:
      status === 'revert'
        ? `revert: median coverage drop ${dropPp}pp > ${maxDropPp}pp (${balance}) — keep explore on medium.`
        : `keep: median coverage drop ${dropPp}pp <= ${maxDropPp}pp (${balance}) — quick is authorised by the data.`,
  };
}

export interface TentacleScanResult {
  /** Root actually scanned (absolute). */
  root: string;
  reports: ExploreCoverageReport[];
  /** Entries skipped: unreadable, unparseable, or not a coverage report. */
  skipped: number;
  /** True when the root itself does not exist (honest empty, not an error). */
  dirMissing: boolean;
}

/**
 * Read `coverage.json` from every session subdirectory of `root`, tolerantly.
 *
 * Fail-open by construction: a missing root, an unreadable file or a corrupt
 * payload only moves the counter, because a measurement tool that crashes on
 * bad data reports nothing about the good data either.
 */
export async function scanTentacleReports(
  root: string = path.join(process.cwd(), TENTACLE_REPORTS_ROOT),
): Promise<TentacleScanResult> {
  const resolved = path.resolve(root);
  let entries: string[];
  try {
    entries = (await readdir(resolved, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { root: resolved, reports: [], skipped: 0, dirMissing: true };
  }

  const reports: ExploreCoverageReport[] = [];
  let skipped = 0;
  for (const sessionId of entries.sort()) {
    const file = path.join(resolved, sessionId, 'coverage.json');
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      const report = parsed as Partial<ExploreCoverageReport> | null;
      if (!report || typeof report !== 'object' || !isUsableRatio(report.ratio)) {
        skipped += 1; // structurally not a coverage report
        continue;
      }
      reports.push({
        ...report,
        sessionId: typeof report.sessionId === 'string' ? report.sessionId : sessionId,
      } as ExploreCoverageReport);
    } catch {
      skipped += 1; // absent / unreadable / unparseable: honest skip
    }
  }
  return { root: resolved, reports, skipped, dirMissing: false };
}
