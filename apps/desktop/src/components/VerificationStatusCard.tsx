/**
 * Deterministic verification status (ADR-0023) for Desktop.
 *
 * Renders the last `verification_run` NDJSON event from the CLI.
 * Source/tier stay explicit: this is evidence, never a probability bar,
 * and never a "% complete" claim.
 *
 * Phase 5 (evidence pack UI): the CLI payload already carries the
 * per-criterion breakdown (`native.results` / `compiled.results`, F2/t22);
 * this card now surfaces it — criterion → status → evidence seq — so a
 * closed mission shows WHY it passed, not just that it did.
 */
import type { CSSProperties } from "react";

export type VerificationVerdict = "PASS" | "REPAIR_REQUIRED" | "BLOCKED";

/** One criterion row of the evidence pack (pack F2 or compiled t22). */
export interface CriterionResultView {
  origin: "pack" | "compiled";
  criterionId: string;
  required: boolean | null;
  status: "pass" | "fail" | "unknown";
  detail?: string;
  evidence: Array<{ tier: string; ref: string; seq?: number }>;
}

export interface VerificationRunView {
  verdict: VerificationVerdict;
  strict: boolean;
  summary: string;
  evidenceComplete: boolean | null;
  passed: number;
  total: number;
  failed: string[];
  unknown: string[];
  /** Per-criterion evidence pack; empty for legacy payloads (render none). */
  results: CriterionResultView[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

interface RawResult {
  criterionId?: unknown;
  status?: unknown;
  detail?: unknown;
  evidence?: unknown;
}

/**
 * Tolerant read of the per-criterion breakdown from `native` (F2 pack) and
 * `compiled` (t22 Verify commands) payload sections. Defensive everywhere:
 * a malformed section means "no rows", never a thrown error in the UI.
 */
function readPackResults(
  section: unknown,
  origin: "pack" | "compiled",
): CriterionResultView[] {
  if (!section || typeof section !== "object") return [];
  const s = section as Record<string, unknown>;
  if (!Array.isArray(s.results)) return [];
  const requiredById = new Map<string, boolean>();
  if (Array.isArray(s.criteria)) {
    for (const c of s.criteria) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const id = str(o.id);
      if (id) requiredById.set(id, o.required === true);
    }
  }
  const rows: CriterionResultView[] = [];
  for (const raw of s.results) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as RawResult;
    const criterionId = str(r.criterionId);
    if (!criterionId) continue;
    const status =
      r.status === "pass" || r.status === "fail" || r.status === "unknown"
        ? r.status
        : "unknown";
    const evidence: CriterionResultView["evidence"] = Array.isArray(r.evidence)
      ? r.evidence
          .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
          .map((e) => ({
            tier: str(e.tier) ?? "tool-output",
            ref: str(e.ref) ?? "",
            ...(typeof e.seq === "number" && e.seq > 0 ? { seq: e.seq } : {}),
          }))
          .filter((e) => e.ref.length > 0)
      : [];
    rows.push({
      origin,
      criterionId,
      required: requiredById.has(criterionId)
        ? requiredById.get(criterionId) ?? null
        : null,
      status,
      ...(str(r.detail) ? { detail: str(r.detail) } : {}),
      evidence,
    });
  }
  return rows;
}

/** Defensive read of a `verification_run` payload; null when unusable. */
export function readVerificationRun(ev: unknown): VerificationRunView | null {
  if (!ev || typeof ev !== "object") return null;
  const r = ev as Record<string, unknown>;
  const type = str(r.type);
  if (type && type !== "verification_run") return null;
  const rawVerdict = str(r.verdict)?.toUpperCase();
  const verdict: VerificationVerdict =
    rawVerdict === "PASS" || rawVerdict === "REPAIR_REQUIRED" || rawVerdict === "BLOCKED"
      ? rawVerdict
      : r.blocked === true
        ? "BLOCKED"
        : "PASS";
  const legacy =
    r.legacy && typeof r.legacy === "object"
      ? (r.legacy as Record<string, unknown>)
      : {};
  const evidence =
    r.evidence && typeof r.evidence === "object"
      ? (r.evidence as Record<string, unknown>)
      : null;
  const total = num(legacy.total);
  const passed = num(legacy.passed);
  return {
    verdict,
    strict: r.strict === true,
    summary: str(r.summary) ?? (verdict === "PASS" ? "open" : verdict.toLowerCase()),
    evidenceComplete:
      evidence && typeof evidence.complete === "boolean" ? evidence.complete : null,
    passed,
    total,
    failed: asStringList(legacy.failed),
    unknown: asStringList(legacy.unknown),
    results: [
      ...readPackResults(r.native, "pack"),
      ...readPackResults(r.compiled, "compiled"),
    ],
  };
}

const VERDICT_LABEL: Record<VerificationVerdict, string> = {
  PASS: "Evidence complete",
  REPAIR_REQUIRED: "Repair required",
  BLOCKED: "Blocked — not done",
};

const STATUS_GLYPH: Record<CriterionResultView["status"], string> = {
  pass: "✓",
  fail: "✗",
  unknown: "?",
};

function toneFor(verdict: VerificationVerdict): CSSProperties {
  if (verdict === "PASS") return { color: "var(--ok, #34c77b)" };
  if (verdict === "REPAIR_REQUIRED") return { color: "var(--warn, #e0a83c)" };
  return { color: "var(--danger, #e05a5a)" };
}

function statusTone(status: CriterionResultView["status"]): CSSProperties {
  if (status === "pass") return { color: "var(--ok, #34c77b)" };
  if (status === "fail") return { color: "var(--danger, #e05a5a)" };
  return { color: "var(--warn, #e0a83c)" };
}

const MAX_CRITERIA_ROWS = 6;

interface Props {
  run: VerificationRunView | null;
}

export function VerificationStatusCard({ run }: Props) {
  if (!run) return null;
  const shown = run.results.slice(0, MAX_CRITERIA_ROWS);
  const hidden = run.results.length - shown.length;
  return (
    <div
      className="verification-card"
      data-verdict={run.verdict}
      data-strict={run.strict ? "true" : "false"}
      aria-live="polite"
    >
      <div className="verification-card-head">
        <span className="verification-card-kicker">
          Verification{run.strict ? " · strict" : " · legacy"}
        </span>
        <span className="verification-card-verdict" style={toneFor(run.verdict)}>
          {VERDICT_LABEL[run.verdict]}
        </span>
      </div>
      <p className="verification-card-summary">{run.summary}</p>
      {run.total > 0 ? (
        <p className="verification-card-counts">
          checks {run.passed}/{run.total}
          {run.evidenceComplete === false ? " · evidence incomplete" : ""}
          {run.evidenceComplete === true ? " · evidence complete" : ""}
        </p>
      ) : null}
      {run.failed.length > 0 ? (
        <p className="verification-card-list">fail: {run.failed.slice(0, 3).join("; ")}</p>
      ) : null}
      {run.unknown.length > 0 ? (
        <p className="verification-card-list">
          unknown ≠ pass: {run.unknown.slice(0, 3).join("; ")}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="verification-card-criteria" data-count={run.results.length}>
          {shown.map((row) => (
            <li
              key={`${row.origin}:${row.criterionId}`}
              className="verification-card-criterion"
              data-status={row.status}
              data-required={row.required === null ? "unknown" : String(row.required)}
            >
              <span className="verification-card-criterion-status" style={statusTone(row.status)}>
                {STATUS_GLYPH[row.status]}
              </span>
              <span className="verification-card-criterion-id">
                {row.criterionId}
                {row.required === false ? " · optional" : ""}
              </span>
              {row.evidence.length > 0 ? (
                <span className="verification-card-criterion-evidence">
                  {row.evidence
                    .slice(0, 2)
                    .map((e) => (typeof e.seq === "number" ? `seq ${e.seq}` : e.tier))
                    .join(" · ")}
                  {row.evidence.length > 2 ? ` +${row.evidence.length - 2}` : ""}
                </span>
              ) : (
                <span className="verification-card-criterion-evidence">no evidence</span>
              )}
            </li>
          ))}
          {hidden > 0 ? (
            <li className="verification-card-criterion verification-card-criterion-more">
              +{hidden} more
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
