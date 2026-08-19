/**
 * verification/sessionEvidence.ts — read the strict completion verdict back
 * from the session spine (ADR-0023 × ADR-0021; Exit-2/E2.1).
 *
 * A `verification.run` event carries the machine-readable record emitted by
 * the strict build gate (`strictGateEventPayload`). This module reconstructs
 * a CompletionEvaluation from the session log alone — no in-process registry
 * — so hosts, mission retries and audits can confirm why a turn finished.
 *
 * Discipline (P1): unknown ≠ pass. A missing or malformed record yields
 * null; a non-strict record is readable as a snapshot but NEVER converts to
 * a completion evaluation. Callers must treat null as "no verification
 * evidence", never as a pass.
 */
import type {
  CompletionEvaluation,
  CompletionVerdict,
  UnsatisfiedCriterion,
} from './completionPolicy.js';

/** Structural event view — decoupled from session internals (no cycles). */
export interface VerificationEventLike {
  kind: string;
  seq: number;
  ts: number;
  data?: Record<string, unknown>;
}

/** Defensive view of one verification record from the log. */
export interface SessionVerificationRunSnapshot {
  seq: number;
  ts: number;
  engine: string | null;
  strict: boolean;
  verdict: CompletionVerdict | 'unknown';
  satisfied: string[];
  unsatisfied: { id: string; status: string; reason: string }[];
  evidenceComplete: boolean;
  summary: string;
}

const VERDICTS = new Set<string>(['PASS', 'REPAIR_REQUIRED', 'BLOCKED']);

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function asUnsatisfied(v: unknown): { id: string; status: string; reason: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { id: string; status: string; reason: string }[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = asString(rec.id);
    if (id === null) continue;
    out.push({
      id,
      status: asString(rec.status) ?? 'unknown',
      reason: asString(rec.reason) ?? '',
    });
  }
  return out;
}

/**
 * Parse one `verification.run` event payload defensively.
 * Returns null when the payload carries no recognizable record.
 */
export function parseVerificationRunPayload(
  ev: VerificationEventLike,
): SessionVerificationRunSnapshot | null {
  const data = ev.data;
  if (!data || typeof data !== 'object') return null;
  const rec = data as Record<string, unknown>;
  const verdictRaw = asString(rec.verdict);
  const verdict: CompletionVerdict | 'unknown' =
    verdictRaw !== null && VERDICTS.has(verdictRaw)
      ? (verdictRaw as CompletionVerdict)
      : 'unknown';
  const evidence =
    rec.evidence && typeof rec.evidence === 'object'
      ? (rec.evidence as Record<string, unknown>)
      : null;
  const satisfied = asStringArray(evidence?.satisfied);
  const unsatisfied = asUnsatisfied(evidence?.unsatisfied);
  const completeRaw = evidence?.complete;
  return {
    seq: ev.seq,
    ts: ev.ts,
    engine: asString(rec.engine),
    strict: rec.strict === true,
    verdict,
    satisfied,
    unsatisfied,
    evidenceComplete:
      typeof completeRaw === 'boolean'
        ? completeRaw
        : verdict === 'PASS' && satisfied.length > 0 && unsatisfied.length === 0,
    summary: asString(rec.summary) ?? '',
  };
}

/** Last recognizable `verification.run` in the log (latest wins). */
export function lastVerificationRun(
  events: readonly VerificationEventLike[],
): SessionVerificationRunSnapshot | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== 'verification.run') continue;
    const snap = parseVerificationRunPayload(ev);
    if (snap) return snap;
  }
  return null;
}

/**
 * Convert a snapshot into a CompletionEvaluation. Null when the record is
 * not strict (informational only): a non-strict legacy record must never
 * satisfy the evidence contract.
 */
export function snapshotToCompletionEvaluation(
  snap: SessionVerificationRunSnapshot,
): CompletionEvaluation | null {
  if (!snap.strict) return null;
  const unsatisfied: UnsatisfiedCriterion[] = snap.unsatisfied.map((u) => ({
    id: u.id,
    status: u.status === 'fail' || u.status === 'missing' ? u.status : 'unknown',
    reason: u.reason,
  }));
  const verdict: CompletionVerdict =
    snap.verdict === 'PASS' || snap.verdict === 'REPAIR_REQUIRED' || snap.verdict === 'BLOCKED'
      ? snap.verdict
      : 'BLOCKED';
  return {
    verdict,
    satisfied: [...snap.satisfied],
    unsatisfied,
    evidenceComplete: snap.evidenceComplete && unsatisfied.length === 0 && verdict === 'PASS',
    // F3: snapshot summaries do not carry per-ref seq — event-backedness is
    // auditable from the raw spine events (verification.evidence), unknown here.
    eventBackedEvidenceComplete: false,
    summary: snap.summary,
  };
}
