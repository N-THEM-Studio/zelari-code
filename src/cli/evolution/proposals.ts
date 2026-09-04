/**
 * proposals — read-only view over the Evolution proposal store (t43, ADR-0036).
 *
 * The store is owned by tools/eval (evolvePropose/evolveDecide): this module
 * NEVER writes it and never promotes anything — it only folds the JSONL the
 * same way the eval pipeline does (event-sourced: LAST record per id wins,
 * mirroring effectiveStatusById) so `/evolve proposals` shows the truth.
 * Kept local on purpose: no import from tools/eval (src must not depend on
 * eval tooling; P5 surface discipline).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Proposal store location (same default as tools/eval runEvolvePropose). */
export const PROPOSALS_REL = path.join('.zelari', 'evolution', 'proposals.jsonl');

export function proposalsPath(cwd: string): string {
  return path.join(cwd, PROPOSALS_REL);
}

/** Unknown-tolerant view of a stored record (statuses arrive as free strings). */
export interface ProposalRecord {
  id: string;
  createdAt?: string;
  status: string;
  operator?: string;
  surface?: string;
  fingerprint?: string;
  evidenceCount?: number;
  rationale?: string;
}

/**
 * Tolerant read + fold: corrupt lines are skipped; when an id repeats, the
 * LAST record wins (event-sourced status transitions, e.g. proposed→applied).
 */
export function readProposalStore(cwd: string): ProposalRecord[] {
  const file = proposalsPath(cwd);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const byId = new Map<string, ProposalRecord>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const p = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof p?.id !== 'string') continue;
      byId.set(p.id, {
        id: p.id,
        ...(typeof p.createdAt === 'string' ? { createdAt: p.createdAt } : {}),
        status: typeof p.status === 'string' ? p.status : 'unknown',
        ...(typeof p.operator === 'string' ? { operator: p.operator } : {}),
        ...(typeof p.surface === 'string' ? { surface: p.surface } : {}),
        ...(typeof p.fingerprint === 'string' ? { fingerprint: p.fingerprint } : {}),
        ...(typeof p.rationale === 'string' ? { rationale: p.rationale } : {}),
        ...(p.evidence && typeof p.evidence === 'object' && typeof (p.evidence as { count?: unknown }).count === 'number'
          ? { evidenceCount: (p.evidence as { count: number }).count }
          : {}),
      });
    } catch {
      // corrupt line — skip (tolerant replay, same contract as the ledger)
    }
  }
  return [...byId.values()];
}

export interface ProposalSummary {
  total: number;
  byStatus: Record<string, number>;
}

/** Status counts over the folded store (deterministic). */
export function proposalSummary(records: readonly ProposalRecord[]): ProposalSummary {
  const byStatus: Record<string, number> = {};
  for (const r of records) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return { total: records.length, byStatus };
}
