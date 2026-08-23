/**
 * src/cli/budget/resourceLedger.ts — host-owned append-only resource ledger
 * (2.6 Track B, doc §9.4). This ledger is cumulative session telemetry.
 * Single counting point: tool-call usage derives from `tool.call` session
 * events (never from tool.interrupted — no double count). BudgetRuntime
 * subtracts an epoch baseline for per-turn enforcement; only the host appends.
 */

import {
  ledgerDeltaFor,
  usageFromLedger,
  type ResourceBudget,
  type ResourceLedgerEntry,
  type ResourceLedgerReason,
} from '@zelari/core';
import type { ResourcePolicy, ResourceStage } from '@zelari/core';
import { budgetPressure, computeBudget } from '@zelari/core';
import type { SessionEventEnvelope } from '@zelari/core';

export class ResourceLedger {
  private entries: ResourceLedgerEntry[] = [];
  private nextSeq = 1;

  static fromEntries(entries: readonly ResourceLedgerEntry[]): ResourceLedger {
    const ledger = new ResourceLedger();
    ledger.entries = [...entries];
    ledger.nextSeq = entries.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
    return ledger;
  }

  /** Record one spend. Returns the entry (host call sites only). */
  record(reason: ResourceLedgerReason, calls = 1): ResourceLedgerEntry {
    const entry: ResourceLedgerEntry = { seq: this.nextSeq++, reason, delta: ledgerDeltaFor(reason, calls) };
    this.entries.push(entry);
    return entry;
  }

  snapshot(): readonly ResourceLedgerEntry[] {
    return [...this.entries];
  }

  /** Replace state (BudgetRuntime resume path); host call sites only. */
  resetTo(entries: readonly ResourceLedgerEntry[]): void {
    this.entries = [...entries];
    this.nextSeq = entries.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
  }

  usage(): { toolCallsUsed: number; wallMs: number; tokensUsed: number } {
    return usageFromLedger(this.entries);
  }

  /** Current budget projection under the given policy. Pure over the ledger. */
  budget(policy: ResourcePolicy, stage: ResourceStage = 'implement'): ResourceBudget {
    const usage = this.usage();
    return computeBudget(policy, { toolCallsUsed: usage.toolCallsUsed, elapsedMs: usage.wallMs, tokensUsed: usage.tokensUsed }, stage);
  }

  pressure(policy: ResourcePolicy): ReturnType<typeof budgetPressure> {
    return budgetPressure(this.budget(policy), policy);
  }
}

/**
 * Rebuild the ledger from a session log (resume path, doc §9.5):
 * one `tool-call` delta per `tool.call` event. Idempotent, order-preserving.
 */
export function rebuildLedgerFromEvents(events: readonly SessionEventEnvelope[]): ResourceLedger {
  const ledger = new ResourceLedger();
  for (const e of events) {
    if (e.kind === 'tool.call') {
      // Same delta shape a live host append produces — replay == live.
      ledger.record('tool-call', 1);
    } else if (e.kind === 'verification.run') {
      ledger.record('verification', 0);
    }
  }
  return ledger;
}
