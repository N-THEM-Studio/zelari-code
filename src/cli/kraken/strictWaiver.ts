/**
 * K1.4 / F6 — spine-recorded strict-done waiver.
 *
 * Opt-outs (`--allow-unverified`, `ZELARI_STRICT_DONE=0`) are indistinguishable
 * from a verified PASS unless they append an event. Fail-closed: if the
 * event cannot be recorded, the waiver does not take effect.
 */
import type { SessionEventInput } from '@zelari/core/session';
import type { StrictDoneSurface } from './verificationBridge.js';

export type StrictWaiverReason =
  | 'allow-unverified'
  | 'strict-done-opt-out'
  | 'mission-strict-opt-out';

export interface StrictWaiverPayload {
  reason: StrictWaiverReason;
  flag: string;
  value: string;
  surface: StrictDoneSurface;
  ts: number;
}

export interface StrictWaiverRecord {
  recorded: boolean;
  seq?: number;
}

export async function emitStrictWaiver(
  emit: ((input: SessionEventInput) => Promise<unknown>) | undefined,
  payload: StrictWaiverPayload,
): Promise<StrictWaiverRecord> {
  if (!emit) return { recorded: false };
  try {
    const result = await emit({
      kind: 'strict.waived',
      actor: { type: 'system', role: 'verification' },
      data: { ...payload },
    });
    const raw =
      result && typeof result === 'object' && 'seq' in result
        ? (result as { seq: unknown }).seq
        : undefined;
    const seq = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(seq) && seq > 0) return { recorded: true, seq };
    return { recorded: true };
  } catch {
    return { recorded: false };
  }
}
