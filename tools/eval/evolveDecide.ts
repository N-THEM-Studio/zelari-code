/**
 * tools/eval/evolveDecide.ts — Fase 2.1 — evolution DECISION engine
 * (human decision loop on proposals: applied | rejected | withdrawn;
 * ZERO code mutation — this records decisions ONLY).
 *
 * Event-sourced: a decision is a NEW record repeating the proposal's id
 * (+ fingerprint/operator/surface/…), appended AFTER the original
 * 'proposed' record. The effective status of an id is the LAST record's
 * status in file order (effectiveStatusById in evolvePropose.ts) — that
 * fold is what lets a 'withdrawn' decision re-allow dedupe in
 * buildProposals while 'applied'/'rejected' keep blocking.
 *
 * Fail-closed evidence for 'applied': every entry of the proposal's
 * requiredValidation must be answered by one evidence entry (and at least
 * 1 entry even when requiredValidation is []), each non-empty, plus a
 * non-empty ref. Rejected/withdrawn need NO evidence — refusing is cheap,
 * applying is not. Evidence strings SHOULD state "exit 0"; ones that do
 * not get a non-fatal warning (manual-review evidence may be honest —
 * the operator verifies; the tool never fabricates a pass).
 *
 * Idempotent: deciding an id whose EFFECTIVE status already equals the
 * requested status is a noop — no record, no write, honest message.
 *
 * The core (decide / buildDecisionRecord) is pure — no I/O, no clock;
 * `decidedAt` is injected by the caller (the CLI stamps its clock). The
 * one impure function is appendDecision, mirroring appendProposals:
 * append-only JSONL, one decision per line, mkdir -p for the parent.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { effectiveStatusById, type StoredProposal } from './evolvePropose.ts';
import { behavioralVerdict, type BehavioralMetrics } from './behavioral.ts';

export type DecisionStatus = 'applied' | 'rejected' | 'withdrawn';

export interface DecisionInput {
  /** Existing proposal id ('p-NNNN') — must already be in the store. */
  id: string;
  status: DecisionStatus;
  /** Where the decision is materialized (git ref / worktree path) — REQUIRED for 'applied'. */
  ref?: string;
  /** One entry per validation ask, "exit 0" stated per ask — REQUIRED for 'applied'. */
  evidence: string[];
  /** Optional free-form operator note (copied verbatim, never generated). */
  note?: string;
  /**
   * W2/t45 anti-Goodhart gate: ledger-derived behavioural metrics
   * (baseline vs variant). When present and REGRESSING, 'applied' is
   * rejected by code (docs/EVALS.md #2) — see behavioral.ts.
   */
  behavior?: { baseline: BehavioralMetrics; variant: BehavioralMetrics; minRuns?: number };
}

/** A decision record repeats the decided proposal's fields + the decision fields. */
export interface DecisionRecord extends StoredProposal {
  /** ISO timestamp from the caller's clock — never stamped inside the pure core. */
  decidedAt: string;
  ref?: string;
  evidence?: string[];
  note?: string;
  /** Marker distinguishing decision records from proposal records. */
  decision: true;
}

/**
 * Copy the LATEST record for the id (operator/surface/fingerprint/evidence/
 * rationale/patchHint/requiredValidation/createdAt) and override status +
 * decision fields. Pure: `decidedAt` arrives from the caller.
 */
export function buildDecisionRecord(latest: StoredProposal, input: DecisionInput, decidedAt: string): DecisionRecord {
  const record: DecisionRecord = {
    ...latest,
    status: input.status,
    decision: true,
    decidedAt,
  };
  if (input.ref !== undefined) record.ref = input.ref;
  if (input.note !== undefined) record.note = input.note;
  record.evidence = [...(Array.isArray(input.evidence) ? input.evidence : [])];
  return record;
}

/**
 * Pure decision core: store records + decision input → the record to
 * append (or a noop). Throws Error with actionable messages on invalid
 * input: empty id, unknown id, invalid status, and — for 'applied' only —
 * the fail-closed evidence/ref gates. Returns `outcome: 'noop'` (no
 * record) when the CURRENT EFFECTIVE status of the id already equals the
 * requested status (idempotent re-runs are honest, not errors).
 */
export function decide(
  records: StoredProposal[],
  input: DecisionInput,
  decidedAt: string,
): { outcome: 'appended' | 'noop'; record?: DecisionRecord; warnings: string[] } {
  if (typeof input.id !== 'string' || input.id === '') {
    throw new Error('decision requires a non-empty proposal id — pass --id <p-NNNN> (see evolve:decide --list)');
  }
  if (input.status !== 'applied' && input.status !== 'rejected' && input.status !== 'withdrawn') {
    throw new Error(
      `invalid decision status ${JSON.stringify(input.status)} — expected 'applied' | 'rejected' | 'withdrawn'`,
    );
  }
  const eff = effectiveStatusById(records).get(input.id);
  if (!eff) {
    throw new Error(
      `unknown proposal id '${input.id}' — no record with that id in the store; run evolve:decide --list to see recorded ids`,
    );
  }
  if (eff.status === input.status) {
    // Idempotent: the decision is already the effective one. No record, no write.
    return { outcome: 'noop', warnings: [] };
  }

  const latest = eff.record;
  const required: string[] = Array.isArray(latest.requiredValidation)
    ? latest.requiredValidation.filter((v): v is string => typeof v === 'string')
    : [];
  const evidence: string[] = Array.isArray(input.evidence) ? input.evidence : [];

  if (input.status === 'applied') {
    if (typeof input.ref !== 'string' || input.ref.trim() === '') {
      throw new Error("applied requires a non-empty ref (git commit/worktree path where it was applied) — pass --ref <ref>");
    }
    if (evidence.length < 1) {
      throw new Error(
        'applied requires at least 1 evidence entry — pass --evidence "<command> … exit 0" for every validation ask',
      );
    }
    for (const e of evidence) {
      if (typeof e !== 'string' || e.trim() === '') {
        throw new Error('applied evidence entries must be non-empty strings — every validation ask needs a real answer');
      }
    }
    // Fail-closed: EVERY required validation ask needs an evidence entry.
    // Surfaces with requiredValidation [] still need >= 1 entry.
    if (evidence.length < required.length) {
      throw new Error(
        `applied requires evidence for every validation ask: ${required.length} required (${required.join('; ')}), got ${evidence.length} — fail-closed; pass --evidence once per ask`,
      );
    }
  }

  // W2/t45 — anti-Goodhart behavioural gate (docs/EVALS.md #2): a variant
  // that raises steer/interrupt rate or lowers the average evidence tier is
  // rejected BY CODE even when the pass rate improves. Evaluated only when
  // the caller supplies ledger-derived metrics (runEvolveDecide computes
  // them by default); without data the decision proceeds (absent telemetry
  // never fabricates a verdict — the runner states it on stderr).
  if (input.status === 'applied' && input.behavior !== undefined) {
    const behavior = behavioralVerdict(input.behavior.baseline, input.behavior.variant, {
      minRuns: input.behavior.minRuns,
    });
    if (!behavior.ok) {
      throw new Error(
        `applied blocked by the behavioural rule (anti-Goodhart, docs/EVALS.md #2): ${behavior.reasons.join('; ')} — a variant that degrades behaviour is rejected by construction`,
      );
    }
  }

  const warnings: string[] = [];
  for (const e of evidence) {
    if (typeof e === 'string' && !e.includes('exit 0')) {
      warnings.push(`warning: evidence "${e}" does not state "exit 0" — manual-review evidence? verify honestly`);
    }
  }
  return { outcome: 'appended', record: buildDecisionRecord(latest, input, decidedAt), warnings };
}

export interface AppendDecisionOpts {
  /** Dry run: NO fs write happens at all. */
  dryRun?: boolean;
}

/**
 * The append layer — the one impure function of the decision engine.
 * Appends ONE JSON line (mkdir -p for the parent dir). `written` is 0 for
 * a dry run. Mirrors appendProposals: append-only, never rewrites.
 */
export function appendDecision(
  storePath: string,
  record: DecisionRecord,
  opts: AppendDecisionOpts = {},
): { written: number; path: string } {
  if (opts.dryRun === true) {
    return { written: 0, path: storePath };
  }
  mkdirSync(path.dirname(storePath), { recursive: true });
  appendFileSync(storePath, `${JSON.stringify(record)}\n`, 'utf-8');
  return { written: 1, path: storePath };
}
