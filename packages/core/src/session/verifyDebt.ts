/**
 * session/verifyDebt.ts — the K1.5/F5 obligation pairs, projected.
 *
 * `verify.debt_open` binds a task slot that must end in a passing verify (or an
 * explicit waiver); `verify.debt_cleared` closes it. The runtime keeps the LIVE
 * cache in `taskTool`/`runOneTurn` and WS2 renders the operator-facing view
 * with an acknowledgement boundary (`src/cli/inboxSources.ts`: a debt older
 * than your last reply is not an inbox item anymore).
 *
 * This module answers the REPLAY question instead, and answers it raw: what do
 * the events on this spine say, in log order, with no operator in the loop?
 * Same derive-only discipline, deliberately NO ack boundary — a shadow replay
 * must see the obligation the harness carried, not the one the human still
 * cares about. The two views coexist: `inboxSources` = "what still needs YOU",
 * `projectVerifyDebts` = "what did the run leave unfinished".
 */
import type { SessionEventEnvelope } from './types.js';

/** One debt slot, from its open (last-wins) to its first clear. */
export interface VerifyDebtSummary {
  /** Slot id (`verify.debt_open`.data.taskId). */
  taskId: string;
  /** What the obligation was about, verbatim. */
  description: string;
  /** Optional one-line detail the writer attached. */
  detail?: string;
  openedSeq: number;
  openedAt: number;
  /** Absent ⇒ still OPEN at the end of the spine. */
  clearedSeq?: number;
  clearedAt?: number;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Pair the debt events of a spine. Pure: no I/O, no clock, no acknowledgement
 * boundary. Re-opening a cleared slot opens it again; a `debt_cleared` with no
 * matching open is ignored; a debt whose `taskId` is missing/empty is skipped
 * (it cannot be paired, so claiming it would invent a slot).
 */
export function projectVerifyDebts(events: readonly SessionEventEnvelope[]): VerifyDebtSummary[] {
  const byTask = new Map<string, VerifyDebtSummary>();
  for (const e of events) {
    const taskId = str(e.data.taskId);
    if (taskId.length === 0) continue;
    if (e.kind === 'verify.debt_open') {
      const detail = str(e.data.detail);
      byTask.set(taskId, {
        taskId,
        description: str(e.data.description),
        ...(detail ? { detail } : {}),
        openedSeq: e.seq,
        openedAt: e.ts,
      });
    } else if (e.kind === 'verify.debt_cleared') {
      const open = byTask.get(taskId);
      if (!open || open.clearedSeq !== undefined) continue;
      open.clearedSeq = e.seq;
      open.clearedAt = e.ts;
    }
  }
  return [...byTask.values()].sort((a, b) => a.openedSeq - b.openedSeq);
}

/** Debts never cleared by the end of the spine (`[]` ⇒ the run left nothing open). */
export function openVerifyDebts(debts: readonly VerifyDebtSummary[]): VerifyDebtSummary[] {
  return debts.filter((d) => d.clearedSeq === undefined);
}
