/**
 * src/cli/budget/resourceSnapshot.ts — emits `resource.snapshot` events and
 * the model-visible RESOURCE STATUS block (2.6 Track B, doc §10).
 *
 * Frequency rules (§10.4): after a tool batch, on stage change, when a
 * reserve threshold is crossed, and at verification/repair start. The event
 * is model-surface LATEST-ONLY (modelSurface.ts projection) — the ledger
 * keeps every snapshot, the model sees the last.
 */

import type { ResourceBudget } from '@zelari/core';
import { budgetPressure, isVerificationReserveProtected } from '@zelari/core';
import type { ResourcePolicy } from '@zelari/core';

/** Payload of the `resource.snapshot` session event (state + surface). */
export interface ResourceSnapshotPayload {
  toolCallsLimit: number;
  toolCallsUsed: number;
  toolCallsRemaining: number;
  /** 2.6.1 (plan §9): real spend past the hard limit (0 within budget). */
  overrun: number;
  wallMsRemaining?: number;
  verificationReserve: number;
  repairReserve: number;
  stage: ResourceBudget['stage'];
  pressure: ReturnType<typeof budgetPressure>;
  /** True once remaining <= verificationReserve (protected zone entered). */
  reserveProtected: boolean;
}

export function buildResourceSnapshot(budget: ResourceBudget, policy: ResourcePolicy): ResourceSnapshotPayload {
  return {
    toolCallsLimit: budget.toolCalls.limit,
    toolCallsUsed: budget.toolCalls.used,
    toolCallsRemaining: budget.toolCalls.remaining,
    overrun: budget.toolCalls.overrun,
    ...(budget.wallTime.remainingMs !== undefined ? { wallMsRemaining: budget.wallTime.remainingMs } : {}),
    verificationReserve: budget.reserve.verification,
    repairReserve: budget.reserve.repair,
    stage: budget.stage,
    pressure: budgetPressure(budget, policy),
    reserveProtected: isVerificationReserveProtected(budget),
  };
}

/** Decide whether a new snapshot must be emitted after a state change. */
export function shouldEmitSnapshot(
  previous: ResourceSnapshotPayload | undefined,
  next: ResourceSnapshotPayload,
): boolean {
  if (!previous) return true;
  if (previous.stage !== next.stage) return true;
  if (previous.pressure !== next.pressure) return true;
  if (previous.reserveProtected !== next.reserveProtected) return true;
  // After every tool batch: any usage delta.
  if (previous.toolCallsUsed !== next.toolCallsUsed) return true;
  return false;
}

/** Event data payload — keys the invariant checker validates. */
export function snapshotEventData(s: ResourceSnapshotPayload): Record<string, unknown> {
  return { ...s };
}
