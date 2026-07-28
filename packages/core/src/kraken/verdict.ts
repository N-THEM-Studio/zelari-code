/**
 * Kraken graph engine — verify verdict parsing (pure).
 *
 * A `verify` node's job is to judge a writer's work, but a tentacle that runs
 * to completion is a *successful run* regardless of what it concluded: the
 * executor marked the node `done` and never read the text. A verify that said
 * "this is wrong" was indistinguishable from one that said "this is correct",
 * so the graph converged over known-bad work and the only iteration the engine
 * could do was on execution failure, never on quality.
 *
 * This module turns that free text into a decision. The verify prompt asks for
 * a `VERDICT: PASS` / `VERDICT: FAIL` trailer; the executor parses it and, on
 * FAIL, spawns a bounded rework round.
 *
 * No CLI dependencies (see CORREZIONE-1 in the engine plan).
 *
 * @since v1.28.x — verify quality gate
 */

/**
 * What a verify node concluded.
 *
 * `unknown` means no trailer was found. It is deliberately distinct from
 * `pass` so the caller can *report* the omission (a model that quietly stops
 * emitting the trailer would otherwise disable the whole gate invisibly) while
 * still treating it as non-blocking.
 */
export type VerifyVerdict = 'pass' | 'fail' | 'unknown';

export interface ParsedVerdict {
  verdict: VerifyVerdict;
  /**
   * The verify's own reasoning — everything except the trailer line, trimmed
   * and capped. Fed back into the rework node so it knows what to fix.
   */
  findings: string;
}

/**
 * Cap on retained findings text. Mirrors `MAX_UPSTREAM_CHARS_PER_DEP` in the
 * CLI executor, since findings travel the same route (into a sub-agent prompt).
 */
export const MAX_FINDINGS_CHARS = 2800;

/**
 * Matches a verdict trailer at the start of a line: `VERDICT: PASS`.
 * Tolerates leading whitespace, markdown emphasis/bullets the model may wrap
 * it in (`**VERDICT: FAIL**`, `- VERDICT: PASS`), and any trailing text on the
 * line (a model that appends "— 3 gaps found" should still be understood).
 */
const VERDICT_LINE = /^[\s>*_-]*VERDICT[\s*_]*:[\s*_]*(PASS|FAIL)\b/gim;

/**
 * Extract a verify node's verdict from its conclusion text.
 *
 * The **last** trailer wins. Models routinely restate the instruction before
 * answering ("...end with VERDICT: PASS or VERDICT: FAIL") and a first-match
 * scan would read that echo as the answer — inverting the gate on exactly the
 * verbose runs where the judgement matters most.
 */
export function parseVerifyVerdict(text: string | undefined | null): ParsedVerdict {
  const source = typeof text === 'string' ? text : '';
  if (source.trim() === '') return { verdict: 'unknown', findings: '' };

  VERDICT_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = VERDICT_LINE.exec(source)) !== null) {
    last = match;
    // A zero-length match would spin forever; the pattern cannot produce one
    // (it requires the literal "VERDICT"), but guard anyway.
    if (match.index === VERDICT_LINE.lastIndex) VERDICT_LINE.lastIndex += 1;
  }

  if (!last) {
    return { verdict: 'unknown', findings: capFindings(source) };
  }

  const verdict: VerifyVerdict = last[1].toUpperCase() === 'FAIL' ? 'fail' : 'pass';
  // Everything before the trailer is the reasoning that produced it.
  const findings = capFindings(source.slice(0, last.index));
  return { verdict, findings };
}

/**
 * A verify verdict the run could not resolve, carried in the execution summary
 * and rendered in the digest.
 *
 * Lives here (pure) rather than in the CLI executor so the executor and the
 * status/digest renderer can share it without importing each other.
 */
export interface UnresolvedFinding {
  /** The writer node whose work was judged. */
  nodeId: string;
  label: string;
  /** 'fail' → rework budget exhausted; 'unknown' → no parseable verdict. */
  reason: 'fail' | 'unknown';
  findings: string;
}

/** Trim and cap findings text, marking the cut so a reader knows it happened. */
function capFindings(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_FINDINGS_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_FINDINGS_CHARS)}\n… [truncated]`;
}
