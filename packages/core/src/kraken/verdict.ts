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
 * **Pillar 2 extension (v1.30.x)**: `spec` and `conformance` personas emit
 * the same trailer PLUS a per-requirement table in a JSON code block. The
 * parser extracts both: the trailer is the gate, the table is the
 * structured findings the executor can surface in the digest and feed
 * into a follow-up `fix` node.
 *
 * **v1.31.x (Bennett's Razor)**: each parsed verdict now also carries a
 * `weaknessScore` in `[0, 1]`, computed from the persona's free text via
 * `weaknessFromVerdict` (see `./weakness.js`). 1.0 = "maximally general
 * claim" (weak), 0.0 = "maximally specific claim" (strong). The gate
 * (PASS/FAIL) is unchanged — weakness is metadata, surfaced in the
 * workbench digest so the user can see whether a PASS was earned by a
 * tightly-asserted reviewer or a loosely-claimed one.
 *
 * No CLI dependencies (see CORREZIONE-1 in the engine plan).
 *
 * @since v1.28.x — verify quality gate
 * @since v1.30.x — spec / conformance persona verdicts
 * @since v1.31.x — weakness score on persona verdicts
 */

import { weaknessScoreFromText } from './weakness.js';

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

/** One row of the spec / conformance per-requirement table. */
export interface RequirementVerdict {
  requirement: string;
  /** pass = satisfied, fail = violated, unknown = not assessed. */
  met: 'pass' | 'fail' | 'unknown';
  /** Path / line / output the reviewer cites as evidence. */
  evidence?: string;
}

/** Structured verdict for `spec` and `conformance` personas.
 *
 *  The trailer (`VERDICT: PASS|FAIL`) is the gate; the `requirements` table
 *  is the per-row reasoning the executor can surface and feed forward.
 *  `weaknessScore` (Bennett 2023) is metadata: 1.0 = the reviewer asserted
 *  very little (maximally weak / general), 0.0 = the reviewer pinned
 *  specific paths, versions, or invariants. It does NOT change the gate,
 *  but is surfaced in the workbench digest so a user can tell a tightly
 *  earned PASS from a loosely claimed one. */
export interface PersonaVerdict {
  verdict: VerifyVerdict;
  findings: string;
  requirements: RequirementVerdict[];
  /**
   * Bennett-style weakness score in `[0, 1]`, computed from the persona's
   * free text by `weaknessFromVerdict`. Higher = weaker = more general.
   * `1` for the no-trailer case (a missing verdict asserts nothing) and
   * for the all-empty case.
   *
   * @since v1.31.x
   */
  weaknessScore: number;
}

/** Extract the per-requirement JSON block (if any) from a `spec` or
 *  `conformance` reply. The block is a ```json ... ``` fenced object
 *  with a `requirements: [...]` array. */
export function extractRequirementsBlock(text: string | undefined | null): RequirementVerdict[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  // Find the LAST ```json ... ``` block (LLMs sometimes emit the spec first,
  // then the actual answer; we want the final one).
  const re = /```json\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) {
    last = m[1];
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  if (!last) return [];
  try {
    const obj = JSON.parse(last) as { requirements?: unknown };
    if (!obj || !Array.isArray(obj.requirements)) return [];
    const out: RequirementVerdict[] = [];
    for (const r of obj.requirements) {
      if (!r || typeof r !== 'object') continue;
      const row = r as Record<string, unknown>;
      const req = typeof row.requirement === 'string' ? row.requirement : '';
      const metRaw = typeof row.met === 'string' ? row.met.toLowerCase() : '';
      const met: RequirementVerdict['met'] =
        metRaw === 'pass' || metRaw === 'true' ? 'pass'
        : metRaw === 'fail' || metRaw === 'false' ? 'fail'
        : 'unknown';
      const evidence = typeof row.evidence === 'string' ? row.evidence : undefined;
      if (req) out.push({ requirement: req, met, ...(evidence ? { evidence } : {}) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Full parser for a `spec` or `conformance` reply: trailer + table. */
export function parsePersonaVerdict(text: string | undefined | null): PersonaVerdict {
  const base = parseVerifyVerdict(text);
  return {
    verdict: base.verdict,
    findings: base.findings,
    requirements: extractRequirementsBlock(text),
    // Bennett's weakness = "how little the reviewer's free text asserts"
    // (arXiv:2301.12987). `weaknessScoreFromText` is the weakness form
    // (1.0 = maximally general / no claims; 0.0 = maximally specific).
    // The verdict gate is the trailer; weakness is metadata surfaced in
    // the workbench so a user can see whether a PASS was earned by a
    // tightly-asserted or loosely-claimed reviewer.
    weaknessScore: weaknessScoreFromText(text),
  };
}

/** Trim and cap findings text, marking the cut so a reader knows it happened. */
function capFindings(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_FINDINGS_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_FINDINGS_CHARS)}\n… [truncated]`;
}
