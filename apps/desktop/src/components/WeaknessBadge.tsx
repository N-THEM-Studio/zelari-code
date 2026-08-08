/**
 * WeaknessBadge - inline pill that surfaces a Bennett-style weakness score
 * for a verify/spec/conformance persona reply, parsed from the assistant text.
 *
 * Reads the standard trailer `VERDICT: PASS|FAIL` (with markdown tolerance)
 * and computes a heuristic specificity score in [0, 1] (more markers →
 * higher specificity → lower weakness). The score is rendered as a colored
 * pill with a tooltip explaining what "tight" / "medium" / "loose" mean
 * and a link to the underlying paper.
 *
 * Why a local heuristic instead of importing @zelari/core:
 *  - Avoids a new cross-workspace dependency for a UI-only signal.
 *  - The score is *metadata*, not a gate; small drift from the CLI's
 *    score is acceptable.
 *  - If we ever want the exact CLI score, swap `localWeaknessFromText`
 *    with a re-export from @zelari/core's weakness module.
 *
 * @since v1.31.x - Bennett's Razor UI surface (Slice N / desktop)
 */

import { useState } from "react";

interface Props {
  /** The full reply text the persona produced. Trailer may be mid-text. */
  text: string;
  /**
   * Optional override of the weakness score in [0, 1]. When supplied,
   * skips the local heuristic entirely. Used by the workbench ingest
   * path, which already computed the score on the CLI side.
   */
  weaknessScore?: number;
}

/**
 * Verdict values we surface. Mirrors `VerifyVerdict` from the core
 * (pass / fail / unknown) so the badge is consistent with the CLI.
 */
type Verdict = "pass" | "fail" | "unknown";

/**
 * Parse the verdict trailer. Tolerant of:
 *  - `VERDICT: PASS` / `VERDICT: FAIL` (case-insensitive)
 *  - Markdown emphasis: `**VERDICT: PASS**`, `- VERDICT: PASS`, `> VERDICT: PASS`
 *  - Trailing text on the line (`VERDICT: FAIL — 3 gaps found`)
 * Returns the LAST trailer (mirrors the CLI's `parseVerifyVerdict`
 * which deliberately lets the last line win, so echoed instructions
 * before the real answer don't flip the gate).
 */
function parseVerdict(text: string): Verdict {
  if (typeof text !== "string" || text.trim() === "") return "unknown";
  const re = /^[\s>*_-]*VERDICT[\s*_]*:[\s*_]*(PASS|FAIL)\b/gim;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m[1].toUpperCase();
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  if (last === "PASS") return "pass";
  if (last === "FAIL") return "fail";
  return "unknown";
}

/**
 * Local heuristic: counts markers of "this reviewer is being specific".
 * Kept in lockstep (in intent, not in implementation) with
 * `weaknessFromVerdict` in @zelari/core. The two WILL drift over time;
 * the UI must not depend on bit-exact equality.
 *
 * Returns specificity in [0, 1]; weakness is `1 - specificity`.
 */
const SPECIFICITY_MARKERS: readonly RegExp[] = [
  /\bguarantee[ds]?\b/i,
  /\bexact(?:ly)?\b/i,
  /\bmust\b/i,
  /\bshall\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\brequire[ds]?\b/i,
  /\bmandatory\b/i,
  /\bline\s+\d+/i,
  /\bversion\s+[\d.]+/i,
  /\bv?\d+\.\d+\.\d+\b/,
  /\b[0-9a-f]{7,40}\b/i, // commit SHA
  /\bthe\s+(?:file|path)\s+(?:is|at)\b/i,
  /\bprecise(?:ly)?\b/i,
  /\bassert(?:s|ed|ion)?\b/i,
  /\bconfirm(?:s|ed)?\b/i,
];

function localSpecificity(text: string | undefined | null): number {
  if (typeof text !== "string") return 0;
  const t = text.trim();
  if (t === "") return 0;
  let score = 0;
  for (const re of SPECIFICITY_MARKERS) if (re.test(t)) score += 0.25;
  // Cap at 1.0
  return Math.max(0, Math.min(1, score));
}

function weaknessFromSpecificity(spec: number): number {
  return Math.max(0, Math.min(1, 1 - spec));
}

function weaknessBucket(w: number): "tight" | "medium" | "loose" {
  if (w < 0.4) return "tight";
  if (w < 0.7) return "medium";
  return "loose";
}

const BUCKET_LABEL: Record<"tight" | "medium" | "loose", string> = {
  tight: "Tightly asserted",
  medium: "Moderately asserted",
  loose: "Loosely claimed",
};

const BUCKET_HINT: Record<"tight" | "medium" | "loose", string> = {
  tight:
    "The reviewer pinned specifics (paths, versions, line numbers). High-confidence verdict.",
  medium: "Some specifics, some hand-waving. Verdict is informative but not ironclad.",
  loose:
    "The reviewer asserted very little. PASS is informative but should be re-verified for critical work.",
};

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "PASS",
  fail: "FAIL",
  unknown: "?",
};

export function WeaknessBadge({ text, weaknessScore: override }: Props) {
  const [showTip, setShowTip] = useState(false);

  const verdict = parseVerdict(text);
  // If the text has no verdict trailer, do not render a badge at all —
  // a badge without a verdict is just a weakness score on free text,
  // which is misleading ("what is this scoring?").
  if (verdict === "unknown" && override === undefined) return null;

  const weakness =
    typeof override === "number" && override >= 0 && override <= 1
      ? override
      : weaknessFromSpecificity(localSpecificity(text));
  const bucket = weaknessBucket(weakness);

  // Visual color cue: green/amber/red on the pill background, with the
  // emoji matching the bucket so it's skimmable at a glance.
  return (
    <span
      className={`weakness-badge weakness-${bucket}`}
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
      onFocus={() => setShowTip(true)}
      onBlur={() => setShowTip(false)}
      tabIndex={0}
      role="status"
      aria-label={`${VERDICT_LABEL[verdict]} · Bennett weakness ${weakness.toFixed(2)} (${BUCKET_LABEL[bucket]})`}
    >
      <span className="weakness-verdict" data-verdict={verdict}>
        {VERDICT_LABEL[verdict]}
      </span>
      <span className="weakness-score">{weakness.toFixed(2)}</span>
      <span className="weakness-bucket">{BUCKET_LABEL[bucket]}</span>
      {showTip ? (
        <span className="weakness-tip" role="tooltip">
          {BUCKET_HINT[bucket]}
          <br />
          <span className="weakness-tip-formula">
            weakness = 1 − specificity
          </span>
          <span className="weakness-tip-paper">
            Based on Bennett, AGI 2023 —{" "}
            <a
              href="https://arxiv.org/abs/2301.12987"
              target="_blank"
              rel="noreferrer"
            >
              arXiv:2301.12987
            </a>
          </span>
        </span>
      ) : null}
    </span>
  );
}
