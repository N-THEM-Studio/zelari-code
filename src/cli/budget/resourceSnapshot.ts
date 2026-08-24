/**
 * src/cli/budget/resourceSnapshot.ts — emits `resource.snapshot` events and
 * the model-visible RESOURCE STATUS block (2.6 Track B, doc §10).
 *
 * Frequency rules (§10.4): after a tool batch, on stage change, when a
 * reserve threshold is crossed, and at verification/repair start. The ledger
 * keeps every snapshot; the host injects only the current value as a volatile
 * request tail, outside persistent model history.
 */

import type { ResourceBudget } from '@zelari/core';
import { budgetPressure, isVerificationReserveProtected } from '@zelari/core';
import type { ResourcePolicy } from '@zelari/core';

/** Payload of the `resource.snapshot` session event (state + surface). */
export interface ResourceSnapshotPayload {
  /** Monotone execution epoch within the durable session (0 = legacy/unscoped). */
  epoch?: number;
  /** Cumulative session telemetry; enforcement uses toolCallsUsed for this epoch. */
  sessionToolCallsUsed?: number;
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

export interface ResourceSnapshotContext {
  epoch?: number;
  sessionToolCallsUsed?: number;
}

/** Add execution-scope metadata without changing the pure budget projection. */
export function withResourceSnapshotContext(
  snapshot: ResourceSnapshotPayload,
  context: ResourceSnapshotContext,
): ResourceSnapshotPayload {
  return {
    ...snapshot,
    ...(context.epoch !== undefined ? { epoch: context.epoch } : {}),
    ...(context.sessionToolCallsUsed !== undefined
      ? { sessionToolCallsUsed: context.sessionToolCallsUsed }
      : {}),
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
