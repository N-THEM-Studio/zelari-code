/**
 * fileEvents — ADR-0033 (t75) spine emission for the core write path.
 *
 * Three state-only (never model-surface) kinds with a FIXED wire contract:
 *   file.read     data = {path, snapshotId}
 *   file.applied  data = {path, snapshotId, bytes}
 *   file.rejected data = {path, reason, hint?}  reason = WriteReject.status
 *
 * Emission rides the optional `ToolContext.emitSessionEvent` seam (same
 * signature as `ExecutionContext.appendSessionEvent`): hosts without a spine
 * writer omit it and tools skip telemetry entirely. Emission is best-effort —
 * a spine failure (lock, closed writer) never alters the tool result.
 */

import type { SessionEventInput } from '../../../session/types.js';
import type { WriteReject } from './edit.js';

/** Same shape as ExecutionContext.appendSessionEvent / VerificationEngine.emit. */
export type FileEventEmitter = (input: SessionEventInput) => Promise<unknown>;

export function fileReadEvent(path: string, snapshotId: string): SessionEventInput {
  return { kind: 'file.read', actor: { type: 'tool' }, data: { path, snapshotId } };
}

export function fileAppliedEvent(path: string, snapshotId: string, bytes: number): SessionEventInput {
  return { kind: 'file.applied', actor: { type: 'tool' }, data: { path, snapshotId, bytes } };
}

export function fileRejectedEvent(
  path: string,
  reason: WriteReject['status'],
  hint?: string,
): SessionEventInput {
  return {
    kind: 'file.rejected',
    actor: { type: 'tool' },
    data: hint === undefined ? { path, reason } : { path, reason, hint },
  };
}

/** Deterministic re-read suggestion from a WriteReject's machine action (ADR-0033). */
export function reReadHint(reject: WriteReject): string {
  return `re-read ${reject.next.path}, then retry with the fresh snapshotId`;
}

/** Best-effort emit: spine unavailability never fails the tool call. */
export async function emitFileEvent(
  emit: FileEventEmitter | undefined,
  input: SessionEventInput,
): Promise<void> {
  if (!emit) return;
  try {
    await emit(input);
  } catch {
    // telemetry only — swallow and let the tool result speak
  }
}
