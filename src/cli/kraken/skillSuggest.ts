/**
 * Kraken — skill auto-suggest (Gauntlet Loop step 8, Cross-cutting C1).
 *
 * After a converged graph, scan the run for patterns worth promoting to
 * a reusable skill. Today the patterns are simple:
 *
 *   - A `verify`/`spec`/`conformance` reviewer returned FAIL with a
 *     concrete, actionable gap, the next attempt fixed it. The (gap,
 *     fix) pair is a candidate.
 *   - A writer hit the same scope twice (rework round) and the second
 *     attempt succeeded where the first failed.
 *
 * The suggestion is *offered, not applied*. The user accepts via the
 * existing `/promote-skill <id>` command. We deliberately do not
 * auto-promote: a converged run is not always a good run, and a
 * suggestion the user can audit is much safer than a silent
 * write-to-SKILL.md.
 *
 * The threshold is "did the same kind of review reject a writer and a
 * later iteration accept the work?". The function below is pure: it
 * takes a structured run summary and returns zero or more suggestions.
 *
 * @since Kraken v1.30.x — workflow script runtime (Cross-cutting C1)
 */

import type { ScriptRunResult, TentacleRef } from '@zelari/core';

/** A candidate skill surfaced from a converged run. */
export interface SkillSuggestion {
  /** Stable id derived from the run; the user passes this to /promote-skill. */
  id: string;
  /** One-line title. */
  title: string;
  /** Body the user sees in the suggestion card. */
  body: string;
  /** The reviewer that flagged the issue (verify / spec / conformance). */
  sourceKind: 'verify' | 'spec' | 'conformance' | string;
  /** The original failure findings (truncated to a useful size). */
  failureFindings: string;
  /** Confidence: how strong is the evidence? 0..1. */
  confidence: number;
}

const MAX_FINDINGS_CHARS = 600;

/** Produce a short, kebab-case id from a free-text label. */
export function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'kraken-skill';
}

/** Compute skill suggestions from a finished run. Pure function. */
export function suggestSkillsFromRun(
  result: ScriptRunResult,
  opts: { graphId: string; goal: string } = { graphId: 'g', goal: '' },
): SkillSuggestion[] {
  if (!result.converged) return [];
  const refs = [...result.tentacles.values()];

  // 1. Pattern: a reviewer FAILed with concrete findings, and a later
  //    pass produced a `done` with a similar scope/label. Heuristic: a
  //    reviewer FAIL followed by a `fix` node that the executor resolved
  //    (a rework round).
  const reviewerFails = refs.filter(
    (r) => (r.kind === 'verify' || r.kind === 'spec' || r.kind === 'conformance') && r.verdict === 'fail',
  );
  const fixNodes = refs.filter((r) => r.kind === 'fix' && r.status === 'done');

  if (reviewerFails.length === 0 || fixNodes.length === 0) return [];

  // Pair the first reviewer FAIL with the first fix-node. One suggestion
  // per run is the right cadence for v1; multi-suggestion can come later.
  const fail = reviewerFails[0];
  const fix = fixNodes[0];

  const failureFindings = (fail.findings || '').slice(0, MAX_FINDINGS_CHARS);
  const fixFindings = (fix.findings || '').slice(0, MAX_FINDINGS_CHARS);
  const id = `kraken-skill-${slugifyLabel(fail.label)}-${opts.graphId}`;

  // Confidence: stronger when the fix succeeded on a fresh attempt (no
  // cascading errors), when the failure findings are concrete, and when
  // the goal is non-empty.
  let confidence = 0.4;
  if (failureFindings.length > 60) confidence += 0.2;
  if (fixFindings.length > 60) confidence += 0.2;
  if (opts.goal.trim().length > 0) confidence += 0.1;
  if (result.tentacles.size > 1) confidence += 0.1;
  confidence = Math.min(1, confidence);

  return [
    {
      id,
      title: `Skill from "${fail.label}" (fixed on rework)`,
      body: [
        `The reviewer \`${fail.label}\` (${fail.kind}) FAILed with:`,
        '',
        '```',
        failureFindings,
        '```',
        '',
        `The follow-up \`${fix.label}\` fixed the issue.`,
        '',
        `Promote this to a skill with:`,
        '```',
        `/promote-skill ${id}`,
        '```',
        '',
        `Confidence: ${(confidence * 100).toFixed(0)}%`,
      ].join('\n'),
      sourceKind: fail.kind,
      failureFindings,
      confidence,
    },
  ];
}

/** Render a single suggestion as a Markdown card for the transcript. */
export function renderSuggestionCard(s: SkillSuggestion): string {
  return s.body;
}
