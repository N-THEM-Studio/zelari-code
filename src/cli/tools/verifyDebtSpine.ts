/**
 * K1.5 / F5 — persist the runtime general⇒verify obligation on the session spine.
 *
 * `globalThis.__zelariGeneralVerifyDebt` is the process cache. The spine is
 * durability: `verify.debt_open` when a slot is registered, `verify.debt_cleared`
 * when a verify PASS drops that slot. Replay of un-cleared opens hydrates the
 * cache at the start of the next TUI/headless turn so the debt cannot evaporate.
 *
 * Emit follows the K1.4 `strictWaiver.ts` pattern (append-only, fail-open on
 * a missing/throwing sink — the in-memory cache still owns the live gate).
 */
import path from 'node:path';
import {
  readSessionLog,
  type SessionEventInput,
  type SessionEventKind,
} from '@zelari/core/session';

export const VERIFY_DEBT_OPEN = 'verify.debt_open' as const;
export const VERIFY_DEBT_CLEARED = 'verify.debt_cleared' as const;

export type SpineEmit = (input: SessionEventInput) => Promise<unknown>;

export interface VerifyDebtOpenPayload {
  taskId: string;
  description: string;
  detail?: string;
  timestamp: number;
}

export interface VerifyDebtClearedPayload {
  taskId: string;
}

export interface VerifyDebtSpineRecord {
  recorded: boolean;
  seq?: number;
}

export interface VerifyDebtReplayRecord {
  description: string;
  detail?: string;
}

export interface SpineEventLike {
  kind: string;
  data?: Record<string, unknown> | null;
}

let boundEmit: SpineEmit | undefined;
const clearedOnce = new Set<string>();
let persistQueue: Promise<unknown> = Promise.resolve();

export function bindVerifyDebtSpineEmit(emit: SpineEmit | undefined): void {
  boundEmit = emit;
}

export function resetVerifyDebtSpineState(): void {
  boundEmit = undefined;
  clearedOnce.clear();
  persistQueue = Promise.resolve();
}

export function enqueueVerifyDebtPersist(work: () => Promise<unknown>): void {
  persistQueue = persistQueue.then(work, work);
}

export function flushVerifyDebtSpine(): Promise<unknown> {
  return persistQueue;
}

function seqFrom(result: unknown): number | undefined {
  const raw =
    result && typeof result === 'object' && 'seq' in result
      ? (result as { seq: unknown }).seq
      : undefined;
  const seq = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(seq) && seq > 0 ? seq : undefined;
}

async function emitKind(
  emit: SpineEmit | undefined,
  kind: typeof VERIFY_DEBT_OPEN | typeof VERIFY_DEBT_CLEARED,
  data: Record<string, unknown>,
): Promise<VerifyDebtSpineRecord> {
  const sink = emit ?? boundEmit;
  if (!sink) return { recorded: false };
  try {
    const result = await sink({
      kind: kind as SessionEventKind,
      actor: { type: 'system', role: 'verification' },
      data,
    });
    const seq = seqFrom(result);
    if (seq !== undefined) return { recorded: true, seq };
    return { recorded: true };
  } catch {
    return { recorded: false };
  }
}

export async function emitVerifyDebtOpen(
  emit: SpineEmit | undefined,
  payload: VerifyDebtOpenPayload,
): Promise<VerifyDebtSpineRecord> {
  clearedOnce.delete(payload.taskId);
  const data: Record<string, unknown> = {
    taskId: payload.taskId,
    description: payload.description,
    timestamp: payload.timestamp,
  };
  if (payload.detail !== undefined) data.detail = payload.detail;
  return emitKind(emit, VERIFY_DEBT_OPEN, data);
}

export async function emitVerifyDebtCleared(
  emit: SpineEmit | undefined,
  payload: VerifyDebtClearedPayload,
): Promise<VerifyDebtSpineRecord> {
  if (clearedOnce.has(payload.taskId)) return { recorded: false };
  const rec = await emitKind(emit, VERIFY_DEBT_CLEARED, { taskId: payload.taskId });
  if (rec.recorded) clearedOnce.add(payload.taskId);
  return rec;
}

export function replayOpenVerifyDebts(
  events: readonly SpineEventLike[],
): Map<string, VerifyDebtReplayRecord> {
  const open = new Map<string, VerifyDebtReplayRecord>();
  for (const event of events) {
    const taskId = typeof event.data?.taskId === 'string' ? event.data.taskId : '';
    if (!taskId) continue;
    if (event.kind === VERIFY_DEBT_OPEN) {
      const description =
        typeof event.data?.description === 'string' ? event.data.description : '';
      const detail =
        typeof event.data?.detail === 'string' ? event.data.detail : undefined;
      open.set(taskId, { description, ...(detail !== undefined ? { detail } : {}) });
    } else if (event.kind === VERIFY_DEBT_CLEARED) {
      open.delete(taskId);
    }
  }
  return open;
}

export async function loadSessionEventsForVerifyDebt(opts: {
  sessionsDir: string;
  sessionId: string;
}): Promise<readonly SpineEventLike[]> {
  try {
    const file = path.join(opts.sessionsDir, opts.sessionId, 'events.jsonl');
    const report = await readSessionLog(file);
    return report.events;
  } catch {
    return [];
  }
}

export function formatOpenVerifyDebtMessage(debt: {
  description: string;
  detail?: string;
}): string {
  return `task general "${debt.description}" finished without a passing verify (${debt.detail ?? 'unverified work'})`;
}

export function formatTuiVerifyDebtNotice(debt: {
  description: string;
  detail?: string;
}): string {
  return `[kraken] strict done: ${formatOpenVerifyDebtMessage(debt)} — turn is NOT verified-complete`;
}

export function formatHeadlessVerifyDebtNotice(
  debt: { description: string; detail?: string },
  exitCode: number,
): string {
  return `[headless] Kraken BUILD: ${formatOpenVerifyDebtMessage(debt)} — strict done blocked (exit ${exitCode})`;
}
