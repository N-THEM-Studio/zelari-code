/**
 * tools/eval/skillEvidence.ts — Fase 1 — evidence aggregator (report-only,
 * zero mutation). Data source: the skill history JSONL
 * (`~/.tmp/zelari-code/skill-history.jsonl`, override
 * `ANATHEMA_SKILL_HISTORY_FILE`; record schema in src/cli/skillHistory.ts —
 * deliberately NOT imported: parsing here is tolerant and self-contained).
 *
 * A record is usable when it carries a non-empty string `skillId` and a
 * boolean `ok` — the two fields this aggregator counts on. Everything else
 * (ts, invocationId, durationMs, tokensUsed…) is optional and never trusted
 * for arithmetic. Malformed records are counted and skipped, never a crash.
 * Pure functions: no I/O, no Date.now/random → deterministic.
 */

import { compareFindings, type EvidenceFinding, type FindingSeverity } from './spineEvidence.ts';

export type { EvidenceFinding, FindingSeverity };

export interface SkillEvidenceOpts {
  /** Minimum runs for a skill to be judged (default 3, clamped to >= 1). */
  minRuns?: number;
  /** Success rate below which a skill is flagged (default 0.5, clamped to [0,1]). */
  maxSuccessRate?: number;
}

export const DEFAULT_MIN_RUNS = 3;
export const DEFAULT_MAX_SUCCESS_RATE = 0.5;
/** Below this rate a flagged skill is 'high' instead of 'warn'. */
export const HIGH_SEVERITY_RATE = 0.25;

export interface SkillEvidenceReport {
  recordsScanned: number;
  malformedRecords: number;
  findings: EvidenceFinding[];
}

/** Tolerant record check: only the two counted fields are required. */
function isUsableRecord(r: unknown): r is { skillId: string; ok: boolean } {
  return (
    r !== null &&
    typeof r === 'object' &&
    !Array.isArray(r) &&
    typeof (r as Record<string, unknown>).skillId === 'string' &&
    ((r as Record<string, unknown>).skillId as string).length > 0 &&
    typeof (r as Record<string, unknown>).ok === 'boolean'
  );
}

/**
 * Flag skills whose success rate is below `maxSuccessRate` over at least
 * `minRuns` runs. A skill with a perfect (or merely non-terrible) record is
 * never a finding: ok:true runs can never produce one. Output is sorted
 * with the same deterministic order as the spine report.
 */
export function aggregateSkillEvidence(
  records: unknown[],
  opts?: SkillEvidenceOpts,
): SkillEvidenceReport {
  const minRuns = Math.max(1, Math.floor(opts?.minRuns ?? DEFAULT_MIN_RUNS));
  const maxSuccessRate = Math.min(
    1,
    Math.max(0, opts?.maxSuccessRate ?? DEFAULT_MAX_SUCCESS_RATE),
  );

  let malformedRecords = 0;
  const runs = new Map<string, { runs: number; ok: number }>();
  for (const r of records) {
    if (!isUsableRecord(r)) {
      malformedRecords += 1;
      continue;
    }
    let bucket = runs.get(r.skillId);
    if (!bucket) {
      bucket = { runs: 0, ok: 0 };
      runs.set(r.skillId, bucket);
    }
    bucket.runs += 1;
    if (r.ok) bucket.ok += 1;
  }

  const findings: EvidenceFinding[] = [];
  for (const [skillId, bucket] of runs) {
    const successRate = bucket.ok / bucket.runs;
    if (bucket.runs < minRuns || successRate >= maxSuccessRate) continue;
    const severity: FindingSeverity = successRate < HIGH_SEVERITY_RATE ? 'high' : 'warn';
    findings.push({
      id: `skill-low-success:${skillId}`,
      kind: 'skill-low-success',
      severity,
      count: bucket.runs - bucket.ok,
      sessions: [],
      detail: `skill "${skillId}": ${bucket.runs} run(s), success rate ${successRate.toFixed(2)} (${bucket.ok} ok / ${bucket.runs - bucket.ok} failed) below ${maxSuccessRate.toFixed(2)} threshold`,
      hint: 'Repeated failures on this skill — inspect its instructions/template before reusing it.',
    });
  }

  findings.sort(compareFindings);
  return {
    recordsScanned: records.length,
    malformedRecords,
    findings,
  };
}
