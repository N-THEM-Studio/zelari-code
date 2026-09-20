/**
 * tools/eval/promotionReceipt.ts — WS7 slice 1 — ONE promotion receipt, two clients.
 *
 * The premise "the receipt already exists" was FALSE: two parallel stores each recorded
 * HALF of a promotion and neither could read the other — the gate rows
 * (eval/results/<manifestHash>/summary.json: gateDecision COMMIT|REJECT + gateReasons[],
 * regressionGate.ts → resultStore.ts) and the decision rows
 * (.zelari/evolution/proposals.jsonl: status applied|rejected|withdrawn + operator/ref/
 * evidence[]/note, evolveDecide.ts). This module UNIFIES them in ONE zod object WITHOUT
 * rewriting either store: the receipt is DERIVED from those rows (receiptFromSummary /
 * receiptFromDecision) and persisted INSIDE them via the optional `promotion` field — rows
 * written before this slice still parse. No parallel JSON file, no new store.
 *
 * `decision: promote | canary | hold | reject` EXTENDS the store vocabularies. The tables
 * below are total and deterministic in BOTH directions; an unknown status maps to [] hence
 * to `hold` — never a guess. Fail-closed (INVARIANT, §2): `promote` needs a non-empty ref
 * and >= 1 evidence entry per declared validation ask, otherwise it DEGRADES to `hold` with
 * an explicit reason (never throws, never rounds up). `canary` is opt-in and is NEVER the
 * automatic fallback of a failed promote — the fallback is `hold`.
 *
 * Pure: no I/O, no clock, zod the only import. The row types are accepted structurally, so
 * the judge side (regressionGate → runGate, ADR-0036) gains no proposer dependency.
 */

import { z } from 'zod';

/** The unified decision — the receipt's closed vocabulary. */
export type PromotionDecision = 'promote' | 'canary' | 'hold' | 'reject';

/** Gate-store vocabulary (`GateComparison.decision`). */
export type GateDecision = 'COMMIT' | 'REJECT';

/** Decision-store vocabulary (`DecisionStatus`). */
export type DecisionStatus = 'applied' | 'rejected' | 'withdrawn';

/** Every decision, in one place (clients and tests iterate this). */
export const PROMOTION_DECISIONS: readonly PromotionDecision[] = ['promote', 'canary', 'hold', 'reject'];

/**
 * `status → decisions`, total (unknown ⇒ []): applied → promote|canary (an applied change
 * earned one of the two), rejected → reject, withdrawn → hold (abstention ≠ refusal).
 */
const STATUS_TO_DECISIONS: Readonly<Record<DecisionStatus, readonly PromotionDecision[]>> = {
  applied: ['promote', 'canary'],
  rejected: ['reject'],
  withdrawn: ['hold'],
};

/** `gate → decisions`, total. The gate has NO abstention state — `hold` only comes from the degrade below. */
const GATE_TO_DECISIONS: Readonly<Record<GateDecision, readonly PromotionDecision[]>> = {
  COMMIT: ['promote', 'canary'],
  REJECT: ['reject'],
};

/** `decision → statuses`, the inverse of STATUS_TO_DECISIONS, total (>=1 status each). */
const DECISION_TO_STATUSES: Readonly<Record<PromotionDecision, readonly DecisionStatus[]>> = {
  promote: ['applied'],
  canary: ['applied'],
  hold: ['withdrawn'],
  reject: ['rejected'],
};

/** `decision → gate outcomes`, the gate-side inverse, with ONE asymmetry: `hold` has no gate spelling. */
const DECISION_TO_GATES: Readonly<Record<PromotionDecision, readonly GateDecision[]>> = {
  promote: ['COMMIT'],
  canary: ['COMMIT'],
  hold: [],
  reject: ['REJECT'],
};

/** Fresh arrays every call: mutating a result never corrupts the table. */
export const statusToDecisions = (status: string): PromotionDecision[] => [...(STATUS_TO_DECISIONS[status as DecisionStatus] ?? [])];
export const decisionToStatuses = (decision: PromotionDecision): DecisionStatus[] => [...DECISION_TO_STATUSES[decision]];
export const gateToDecisions = (gate: string): PromotionDecision[] => [...(GATE_TO_DECISIONS[gate as GateDecision] ?? [])];
export const decisionToGates = (decision: PromotionDecision): GateDecision[] => [...DECISION_TO_GATES[decision]];

/** One verifiable pointer (file, command, sha, session id) — a ref, never a claim. */
export const ReceiptEvidenceSchema = z.object({ kind: z.string().min(1), ref: z.string().min(1) });
export type ReceiptEvidence = z.infer<typeof ReceiptEvidenceSchema>;

/** Evidence floor for a promote: one entry per ask, and at least one even with zero asks. */
export const MIN_PROMOTION_EVIDENCE = 1;

export const PromotionReceiptSchema = z
  .object({
    /** Additive-only schema version; readers ignore unknown keys. */
    v: z.literal(1),
    /** What is judged: manifestHash (gate) | proposal id 'p-NNNN' (decision). */
    subject: z.string(),
    source: z.enum(['gate', 'decision']),
    /** Timestamp of the SOURCE row — '' when it carried none. */
    at: z.string(),
    /** The source's own vocabulary, kept verbatim ('' = the row recorded no outcome). */
    status: z.string(),
    decision: z.enum(['promote', 'canary', 'hold', 'reject']),
    /** The source's own reasons plus every fail-closed degradation, in order. */
    reasons: z.array(z.string()),
    /** Absent = unknown, never defaulted. */
    operator: z.string().optional(),
    surface: z.string().optional(),
    /** Where the artifact was materialized (git ref / worktree) — REQUIRED for `promote`. */
    ref: z.string().optional(),
    /** The asks proof was demanded for; [] = the store declares none. */
    requiredValidation: z.array(z.string()),
    evidence: z.array(ReceiptEvidenceSchema),
    /** Ledger signal (WS7 slice 0). Absent = NOT MEASURED, never 0 (a non-finite value fails the parse). */
    cacheHitDelta: z.number().optional(),
    /** Prompt-prefix stability. Absent = NOT MEASURED, never false. */
    prefixStable: z.boolean().optional(),
  })
  .superRefine((receipt, ctx) => {
    if (receipt.decision !== 'promote') return;
    if (typeof receipt.ref !== 'string' || receipt.ref.trim() === '') {
      ctx.addIssue({ code: 'custom', message: 'promote requires a non-empty ref — point at what is promoted' });
    }
    const need = Math.max(MIN_PROMOTION_EVIDENCE, receipt.requiredValidation.length);
    if (receipt.evidence.length < need) {
      ctx.addIssue({
        code: 'custom',
        message: `promote requires >= 1 evidence per required validation: ${receipt.requiredValidation.length} ask(s) declared, ${receipt.evidence.length} entry(ies) — degrade to hold`,
      });
    }
  });
export type PromotionReceipt = z.infer<typeof PromotionReceiptSchema>;

export type ReceiptParse = { receipt: PromotionReceipt; error?: undefined } | { receipt?: undefined; error: string };

/** Non-throwing read: a malformed value yields an `error`, never a half-parsed receipt. */
export function parsePromotionReceipt(value: unknown): ReceiptParse {
  if (value === undefined || value === null) return { error: 'absent' };
  const parsed = PromotionReceiptSchema.safeParse(value);
  if (parsed.success) return { receipt: parsed.data };
  return { error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}

/** Caller-supplied proof/metadata. An explicit field WINS over the row (it may hold fresher proof). */
export interface ReceiptInput {
  /** Ask for a decision (e.g. `canary`): honoured only when compatible with the source status. */
  request?: PromotionDecision;
  ref?: string;
  evidence?: readonly ReceiptEvidence[];
  requiredValidation?: readonly string[];
  operator?: string;
  surface?: string;
  cacheHitDelta?: number;
  prefixStable?: boolean;
}

/** THE fail-closed gate: the only path to `promote` — insufficient proof degrades to `hold`. */
export function resolvePromotionDecision(
  attempt: PromotionDecision,
  proof: ReceiptInput,
): { decision: PromotionDecision; reasons: string[] } {
  if (attempt !== 'promote') return { decision: attempt, reasons: [] };
  const reasons: string[] = [];
  if (nonBlank(proof.ref) === undefined) {
    reasons.push('promote refused: ref is empty — a promotion must point at the materialized artifact (git ref/worktree)');
  }
  const evidence = withRealRef(proof.evidence ?? []);
  const required = strings(proof.requiredValidation);
  if (evidence.length < MIN_PROMOTION_EVIDENCE) {
    reasons.push(`promote refused: ${MIN_PROMOTION_EVIDENCE} evidence entry required, got none with a verifiable ref`);
  }
  if (evidence.length < required.length) {
    reasons.push(
      `promote refused: ${required.length} validation ask(s) (${required.join('; ')}) need one evidence entry each, got ${evidence.length}`,
    );
  }
  return reasons.length === 0 ? { decision: 'promote', reasons: [] } : { decision: 'hold', reasons };
}

/** Row client: `EvalSummaryRecord` (resultStore.ts) satisfies this. `promotion` = a persisted receipt. */
export interface SummaryReceiptSource {
  manifestHash: string;
  recordedAt?: string;
  gateDecision?: string;
  gateReasons?: readonly string[];
  promotion?: unknown;
}

/** Row client: `DecisionRecord` (evolveDecide.ts) satisfies this. `promotion` = a persisted receipt. */
export interface DecisionReceiptSource {
  id: string;
  decidedAt?: string;
  status?: string;
  operator?: string;
  surface?: string;
  ref?: string;
  /** Decision-store evidence strings ("<command> → exit 0") — copied verbatim as kind 'validation'. */
  evidence?: readonly string[];
  note?: string;
  requiredValidation?: readonly string[];
  promotion?: unknown;
}

/** The derived-from-the-row half of a receipt, shared by both clients. */
interface ReceiptBase {
  source: 'gate' | 'decision';
  subject: string;
  at: string;
  status: string;
  allowed: readonly PromotionDecision[];
  reasons: readonly string[];
}

/** The one builder both clients share: derive → resolve an optional request → fail-closed resolve. */
function buildReceipt(base: ReceiptBase, input: ReceiptInput): PromotionReceipt {
  const all = [...base.reasons];
  if (base.allowed.length === 0) all.push(`no decision derivable from status ${JSON.stringify(base.status)} — unknown ≠ promote (P1)`);
  let attempt = base.allowed[0] ?? 'hold';
  if (input.request !== undefined) {
    // An incompatible request is dropped, but the reason is kept: never a silent upgrade.
    if (base.allowed.includes(input.request)) attempt = input.request;
    else all.push(`requested decision '${input.request}' is not compatible with status ${JSON.stringify(base.status)} (allowed: ${base.allowed.join('|') || 'none'}) — ignored, fail-closed`);
  }
  const evidence = withRealRef(input.evidence ?? []);
  const required = strings(input.requiredValidation);
  const resolved = resolvePromotionDecision(attempt, { ...input, evidence, requiredValidation: required });
  return PromotionReceiptSchema.parse({
    v: 1,
    subject: base.subject,
    source: base.source,
    at: base.at,
    status: base.status,
    decision: resolved.decision,
    reasons: [...all, ...resolved.reasons],
    ...(nonBlank(input.operator) !== undefined ? { operator: input.operator } : {}),
    ...(nonBlank(input.surface) !== undefined ? { surface: input.surface } : {}),
    ...(nonBlank(input.ref) !== undefined ? { ref: input.ref } : {}),
    requiredValidation: required,
    evidence,
    // Absent = unknown: never default a missing measurement to 0 / false.
    ...(typeof input.cacheHitDelta === 'number' ? { cacheHitDelta: input.cacheHitDelta } : {}),
    ...(typeof input.prefixStable === 'boolean' ? { prefixStable: input.prefixStable } : {}),
  });
}

/**
 * A persisted receipt is AUTHORITATIVE: re-deriving it later could launder a `hold` into a
 * `promote` by supplying fresher proof. A malformed one fails closed, never re-derived.
 */
function persisted(value: unknown, base: ReceiptBase): PromotionReceipt | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = parsePromotionReceipt(value);
  if (parsed.receipt !== undefined) return parsed.receipt;
  return buildReceipt({ ...base, reasons: [`stored receipt unreadable (${parsed.error}) — fail-closed, NOT re-derived`] }, {});
}

/** Derive the receipt from a summary row — the CI-gate client's entry point. */
export function receiptFromSummary(summary: SummaryReceiptSource, input: ReceiptInput = {}): PromotionReceipt {
  const base: ReceiptBase = {
    source: 'gate',
    subject: typeof summary.manifestHash === 'string' ? summary.manifestHash : '',
    at: typeof summary.recordedAt === 'string' ? summary.recordedAt : '',
    status: typeof summary.gateDecision === 'string' ? summary.gateDecision : '',
    allowed: gateToDecisions(summary.gateDecision ?? ''),
    reasons: strings(summary.gateReasons),
  };
  return persisted(summary.promotion, base) ?? buildReceipt(base, input);
}

/** Derive the receipt from a decision record — the evolution controller's entry point. */
export function receiptFromDecision(record: DecisionReceiptSource, input: ReceiptInput = {}): PromotionReceipt {
  const note = nonBlank(record.note);
  const base: ReceiptBase = {
    source: 'decision',
    subject: typeof record.id === 'string' ? record.id : '',
    at: typeof record.decidedAt === 'string' ? record.decidedAt : '',
    status: typeof record.status === 'string' ? record.status : '',
    allowed: statusToDecisions(record.status ?? ''),
    reasons: note !== undefined ? [note] : [],
  };
  const stored = persisted(record.promotion, base);
  if (stored !== undefined) return stored;
  const proof = strings(record.evidence).map((ref): ReceiptEvidence => ({ kind: 'validation', ref }));
  return buildReceipt(base, {
    ...input,
    operator: input.operator ?? nonBlank(record.operator),
    surface: input.surface ?? nonBlank(record.surface),
    ref: input.ref ?? nonBlank(record.ref),
    requiredValidation: input.requiredValidation ?? record.requiredValidation,
    evidence: input.evidence ?? proof,
  });
}

/** Non-blank string keeper (a blank entry is an unanswered ask, not a value). */
function strings(value: readonly unknown[] | undefined): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A declared evidence ref must be non-blank; blank ones are dropped, never counted. */
function withRealRef(evidence: readonly ReceiptEvidence[]): ReceiptEvidence[] {
  return evidence.filter((e) => e !== null && typeof e === 'object' && nonBlank(e.ref) !== undefined);
}
