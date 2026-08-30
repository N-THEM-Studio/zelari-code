/**
 * Defensive normalizer for the CLI's final `harness_state` NDJSON read-model
 * (ADR-0023 — shapes derived by src/cli/harnessState.ts, emitted by
 * src/cli/headless/harnessStateEmit.ts when output=json and relayed by the
 * harness sidecar as the advisory `harness-state` Tauri event).
 *
 * Advisory by contract: a missing or malformed payload normalizes to null
 * and the panel simply does not render — never a crash. Verdicts follow
 * ADR-0023 "unknown ≠ pass": only a STRICT verification PASS is admissible
 * evidence; a non-strict run, a missing run, or an unrecognized verdict all
 * stay "unknown".
 */

export type HarnessVerdict = "PASS" | "REPAIR_REQUIRED" | "BLOCKED" | "unknown";

export interface HarnessTurnView {
  index: number;
  verdict: HarnessVerdict;
  /** Raw verification.verdict when the payload carried one (display honesty). */
  verdictRaw: string | null;
  complete: boolean;
  blockers: string[];
  toolCalls: number;
  outcome: string;
}

export interface HarnessSupportView {
  contextProjections: number;
  contextChars: number;
  memoryEvents: number;
  compactions: number;
  /** T4 (ADR-0032) budget-path fields from the LAST projection carrying them. */
  lastOccupancy?: number;
  lastPolicy?: string;
  contextLimit?: number;
}

export interface HarnessStateView {
  sessionId: string;
  status: string;
  turnsTotal: number;
  turns: HarnessTurnView[];
  support: HarnessSupportView;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function recordList(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v
    .map(asRecord)
    .filter((x): x is Record<string, unknown> => x !== null);
}

function verdictFor(
  verification: Record<string, unknown> | null,
): { verdict: HarnessVerdict; verdictRaw: string | null } {
  const raw = str(verification?.verdict) ?? null;
  if (!verification || verification.strict !== true) {
    // Non-strict evidence is not admissible (unknown ≠ pass).
    return { verdict: "unknown", verdictRaw: raw };
  }
  if (raw === "PASS" || raw === "BLOCKED" || raw === "REPAIR_REQUIRED") {
    return { verdict: raw, verdictRaw: raw };
  }
  return { verdict: "unknown", verdictRaw: raw };
}

/** Contract lookup by turn index (execution.contracts[i].turn). */
function contractFor(
  contracts: Record<string, unknown>[],
  turn: number,
): Record<string, unknown> | null {
  return contracts.find((c) => num(c.turn) === turn) ?? null;
}

/**
 * Normalize one `harness_state` payload (the `state` field of the sidecar's
 * `harness-state` Tauri event); null when unusable.
 */
export function readHarnessStateEvent(ev: unknown): HarnessStateView | null {
  const r = asRecord(ev);
  if (!r) return null;
  const type = str(r.type);
  if (type && type !== "harness_state") return null;
  const session = asRecord(r.session);
  const execution = asRecord(r.execution);
  const support = asRecord(r.support);
  const contracts = recordList(execution?.contracts);
  const turns = recordList(r.turns).map((t) => {
    const index = num(t.index);
    const contract = contractFor(contracts, index);
    const { verdict, verdictRaw } = verdictFor(asRecord(t.verification));
    return {
      index,
      verdict,
      verdictRaw,
      complete: contract?.complete === true,
      blockers: strList(contract?.blockers),
      toolCalls: num(t.toolCalls),
      outcome: str(t.outcome) ?? "pending",
    };
  });
  const projections = recordList(support?.contextProjections);
  // T4: the LAST budget-side projection (memory-side records carry no
  // occupancy) — optional fields, absent when no budget note exists.
  const budgetRecord = projections
    .filter((p) => typeof p.occupancy === "number" && Number.isFinite(p.occupancy))
    .pop();
  return {
    sessionId: str(session?.sessionId) ?? "",
    status: str(session?.status) ?? "pending",
    turnsTotal: turns.length,
    turns,
    support: {
      contextProjections: projections.length,
      contextChars: projections.reduce((sum, p) => sum + num(p.contextChars), 0),
      memoryEvents: num(support?.memoryEvents),
      compactions: num(support?.compactions),
      ...(budgetRecord
        ? {
            lastOccupancy: num(budgetRecord.occupancy),
            ...(str(budgetRecord.policy) ? { lastPolicy: str(budgetRecord.policy) } : {}),
            ...(typeof budgetRecord.contextLimit === "number"
              ? { contextLimit: num(budgetRecord.contextLimit) }
              : {}),
          }
        : {}),
    },
  };
}
