/**
 * Kraken Verified Selection — per-turn metrics (Fase 10, ADR-0020 §58).
 *
 * Captures the cost/effectiveness telemetry of a Kraken turn that used the
 * selection flow, so alpha adoption can be measured against the key question:
 * "do SIMPLE tasks pay a measurable price?" (They must not — with
 * ZELARI_KRAKEN_SELECTION unset the registry stays empty, collect returns
 * null and nothing is emitted.)
 *
 * Design mirrors candidateRegistry: in-memory, per-process, reset every
 * parent turn. Transient counters (tokens, latency, repair flags) are
 * recorded at call sites; everything derivable (selectionUsed,
 * candidateCount, needsMoreEvidence, verification pass/fail/unknown) is
 * derived at collect time from the candidate registry + completion gate —
 * one source of truth, no double bookkeeping.
 *
 * Token numbers are REAL provider-reported usage (UsageBreakdown on
 * message_end / usage deltas), never approximated. Absent usage stays
 * undefined/0 — we do not fabricate data.
 */

import {
  getKrakenCheckResults,
  getKrakenSelection,
  krakenCandidates,
  krakenRequiredChecks,
} from './candidateRegistry.js';
import { classifyKrakenChecks } from './completionGate.js';

/** Turn-level metrics snapshot (§58 field names, stable for consumers). */
export interface KrakenTurnMetrics {
  selectionUsed: boolean;
  candidateCount: number;
  /** Provider-reported total tokens across candidate tentacles (0 when providers report none). */
  candidateTokens: number;
  /** Provider-reported tokens for the judging call (undefined when not reported). */
  selectionTokens?: number;
  /** Wall-clock ms of the judging call (including transport). */
  selectionLatencyMs?: number;
  /** True when a fallback path (not the verifier LLM) produced the verdict. */
  selectionFallback: boolean;
  selectionFallbackReason?: string;
  needsMoreEvidence: boolean;
  verificationPass: number;
  verificationFail: number;
  /** unknown ≠ pass — blocked checks are the repair trigger, so we track them. */
  verificationUnknown: number;
  repairTriggered: boolean;
  /** True only when the repair pass resolved every blocking check. */
  repairSucceeded: boolean;
}

interface MetricsStore {
  candidateTokens: number;
  selectionRecorded: boolean;
  selectionTokens?: number;
  selectionLatencyMs?: number;
  selectionFallback: boolean;
  selectionFallbackReason?: string;
  repairTriggered: boolean;
  repairSucceeded: boolean;
}

interface MetricsGlobal {
  __zelariKrakenTurnMetrics?: MetricsStore;
}

function store(): MetricsStore {
  const g = globalThis as unknown as MetricsGlobal;
  g.__zelariKrakenTurnMetrics ??= {
    candidateTokens: 0,
    selectionRecorded: false,
    selectionFallback: false,
    repairTriggered: false,
    repairSucceeded: false,
  };
  return g.__zelariKrakenTurnMetrics;
}

/** Reset per parent turn (call beside resetKrakenCandidates). */
export function resetKrakenTurnMetrics(): void {
  const g = globalThis as unknown as MetricsGlobal;
  g.__zelariKrakenTurnMetrics = undefined;
}

/** Record provider-reported tokens consumed by one candidate tentacle. */
export function recordCandidateTokens(totalTokens: number): void {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;
  store().candidateTokens += Math.round(totalTokens);
}

/** Record the judging-call outcome (called once per kraken_select). */
export function recordSelectionOutcome(outcome: {
  latencyMs: number;
  tokens?: number;
  degraded: boolean;
  fallbackReason?: string;
}): void {
  const s = store();
  s.selectionRecorded = true;
  s.selectionLatencyMs = Math.max(0, Math.round(outcome.latencyMs));
  if (typeof outcome.tokens === 'number' && Number.isFinite(outcome.tokens) && outcome.tokens > 0) {
    s.selectionTokens = Math.round(outcome.tokens);
  }
  s.selectionFallback = outcome.degraded;
  s.selectionFallbackReason = outcome.fallbackReason;
}

/** The completion gate forced a repair pass (budget = 1, Fase 8). */
export function markRepairTriggered(): void {
  store().repairTriggered = true;
}

/** The repair pass ended with every blocking check resolved. */
export function markRepairSucceeded(): void {
  if (store().repairTriggered) store().repairSucceeded = true;
}

/**
 * Collect the turn snapshot. Returns null when the turn had NO selection
 * activity (flag off, or a plain turn) — callers emit nothing, so simple
 * tasks pay exactly zero telemetry overhead (§58).
 */
export function collectKrakenTurnMetrics(): KrakenTurnMetrics | null {
  const s = store();
  const verdict = getKrakenSelection();
  const candidates = krakenCandidates();
  if (!verdict && candidates.length === 0 && !s.selectionRecorded && !s.repairTriggered) {
    return null;
  }
  const classification = classifyKrakenChecks(krakenRequiredChecks(), getKrakenCheckResults());
  return {
    selectionUsed: verdict !== null,
    candidateCount: candidates.length,
    candidateTokens: s.candidateTokens,
    ...(s.selectionTokens !== undefined ? { selectionTokens: s.selectionTokens } : {}),
    ...(s.selectionLatencyMs !== undefined ? { selectionLatencyMs: s.selectionLatencyMs } : {}),
    selectionFallback: s.selectionFallback,
    ...(s.selectionFallbackReason !== undefined
      ? { selectionFallbackReason: s.selectionFallbackReason }
      : {}),
    needsMoreEvidence: verdict?.status === 'needs_more_evidence',
    verificationPass: classification.passed.length,
    verificationFail: classification.failed.length,
    verificationUnknown: classification.unknown.length,
    repairTriggered: s.repairTriggered,
    repairSucceeded: s.repairSucceeded,
  };
}
