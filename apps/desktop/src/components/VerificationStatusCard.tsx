/**
 * Deterministic verification status (ADR-0023) for Desktop.
 *
 * Renders the last `verification_run` NDJSON event from the CLI.
 * Source/tier stay explicit: this is evidence, never a probability bar,
 * and never a "% complete" claim.
 */
import type { CSSProperties } from "react";

export type VerificationVerdict = "PASS" | "REPAIR_REQUIRED" | "BLOCKED";

export interface VerificationRunView {
  verdict: VerificationVerdict;
  strict: boolean;
  summary: string;
  evidenceComplete: boolean | null;
  passed: number;
  total: number;
  failed: string[];
  unknown: string[];
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
  };
}

const VERDICT_LABEL: Record<VerificationVerdict, string> = {
  PASS: "Evidence complete",
  REPAIR_REQUIRED: "Repair required",
  BLOCKED: "Blocked — not done",
};

function toneFor(verdict: VerificationVerdict): CSSProperties {
  if (verdict === "PASS") return { color: "var(--ok, #34c77b)" };
  if (verdict === "REPAIR_REQUIRED") return { color: "var(--warn, #e0a83c)" };
  return { color: "var(--danger, #e05a5a)" };
}

interface Props {
  run: VerificationRunView | null;
}

export function VerificationStatusCard({ run }: Props) {
  if (!run) return null;
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
    </div>
  );
}
