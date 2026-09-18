/**
 * K1.7 / F7 — honest verification.run when a turn never evaluated.
 *
 * Non-strict turns used to write nothing, so replay could not tell
 * "never verified" from "session never started". Emit UNEVALUATED
 * instead of silence (or a fake PASS).
 */
import type { SessionVerificationRunSnapshot } from '@zelari/core/verification';
import type { StrictDoneSurface } from './verificationBridge.js';

export const UNEVALUATED_STATUS = 'UNEVALUATED' as const;
export const UNVERIFIED_OPEN = 'unverified-open' as const;
export const STRICT_OFF_REASON = 'strict-off' as const;

/** Machine-readable spine payload for a turn that did not evaluate. */
export interface HonestUnevaluatedPayload {
  engine: string;
  strict: false;
  verdict: null;
  status: typeof UNEVALUATED_STATUS;
  reason: typeof STRICT_OFF_REASON;
  surface: StrictDoneSurface;
  summary: typeof UNVERIFIED_OPEN;
  evidence: null;
  native: null;
  verifier: null;
}

export function honestUnevaluatedPayload(
  surface: StrictDoneSurface = 'kraken',
): Record<string, unknown> {
  const payload: HonestUnevaluatedPayload = {
    engine: 'kraken-legacy+completion-policy',
    strict: false,
    verdict: null,
    status: UNEVALUATED_STATUS,
    reason: STRICT_OFF_REASON,
    surface,
    summary: UNVERIFIED_OPEN,
    evidence: null,
    native: null,
    verifier: null,
  };
  return { ...payload };
}

/**
 * Resume/TUI flag: last record UNEVALUATED → `unverified-open`.
 * Relies on the payload summary (copied by lastVerificationRun).
 */
export function replayVerificationFlag(
  snap: Pick<SessionVerificationRunSnapshot, 'summary' | 'strict'> | null,
): typeof UNVERIFIED_OPEN | null {
  if (!snap) return null;
  if (snap.summary === UNVERIFIED_OPEN && snap.strict === false) return UNVERIFIED_OPEN;
  return null;
}
