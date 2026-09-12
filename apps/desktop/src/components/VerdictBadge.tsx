/**
 * Verification badge (Desktop UI phase F3, ADR-0023 vocabulary).
 *
 * Pure renderer for `PASS | REPAIR_REQUIRED | BLOCKED | unknown`. It never
 * decides a verdict — it paints the one it is handed (`tentacleVerdict.ts`
 * reads the per-tentacle backend caption, `VerificationStatusCard.
 * readVerificationRun` reads the mission one). Unknown is a first-class state,
 * rendered "—": ADR-0023's "unknown ≠ pass" is visible, not implied.
 *
 * `scope` is not decoration: a mission verdict is painted with an explicit
 * `mission` label so it can never be read as that tentacle's own result.
 */
import type { CSSProperties } from "react";
import type { TentacleVerdict } from "./tentacleVerdict";

const LABEL: Record<TentacleVerdict, string> = {
  PASS: "PASS",
  REPAIR_REQUIRED: "REPAIR_REQUIRED",
  BLOCKED: "BLOCKED",
  unknown: "",
};

/** Unknown has no glyph of its own: "—" IS the glyph. */
const GLYPH: Record<TentacleVerdict, string> = {
  PASS: "✓",
  REPAIR_REQUIRED: "✗",
  BLOCKED: "⊘",
  unknown: "—",
};

/** Same semantic vars as `VerificationStatusCard.toneFor` (one palette). */
function toneFor(verdict: TentacleVerdict): CSSProperties {
  if (verdict === "PASS") return { color: "var(--ok, #34c77b)" };
  if (verdict === "REPAIR_REQUIRED") return { color: "var(--warn, #e0a83c)" };
  if (verdict === "BLOCKED") return { color: "var(--danger, #e05a5a)" };
  return { opacity: 0.6 };
}

export interface VerdictBadgeProps {
  verdict: TentacleVerdict;
  /** `mission` = the run-level `verification_run` verdict (labelled as such). */
  scope: "tentacle" | "mission";
  /** Verbatim backend token (caption / verdict) shown in the tooltip. */
  signal?: string;
}

export function VerdictBadge({ verdict, scope, signal }: VerdictBadgeProps) {
  const label = LABEL[verdict];
  const text = `${scope === "mission" ? "mission " : ""}${GLYPH[verdict]}${label ? ` ${label}` : ""}`;
  const title =
    verdict === "unknown"
      ? scope === "mission"
        ? "Nessuna verifica di missione ricevuta (evento verification_run) — sconosciuto, mai PASS"
        : "Nessun segnale di verifica per questo tentacle — sconosciuto (— ≠ PASS)"
      : scope === "mission"
        ? `Verifica di missione/run: ${signal ?? verdict} (evento verification_run) — NON del singolo tentacle`
        : `Verifica del tentacle: ${signal ?? verdict} (segnale backend agent_status.message)`;
  return (
    <span
      className="verdict-badge"
      data-verdict={verdict}
      data-scope={scope}
      style={{ ...toneFor(verdict), whiteSpace: "nowrap" }}
      title={title}
      aria-label={title}
    >
      {text}
    </span>
  );
}
