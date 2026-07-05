import type { VerificationCheckResult } from './types.js';

export const DEGRADED_RUN_BANNER = 'DEGRADED_RUN';

export interface DegradedRunInput {
  chairmanErrored?: boolean;
  councilAborted?: boolean;
  /**
   * Total project-file writes (write_file/edit_file) this run — implementer
   * agnostic. Named `lucifer*` for history; implementation runs now have a
   * single implementer (specialists are read-only), so "0 writes" reliably
   * means nobody implemented, not merely that the chairman didn't.
   */
  luciferWriteCount?: number;
  synthesisText?: string;
  runMode?: 'implementation' | 'design-phase';
}

export interface DegradedRunResult {
  degraded: boolean;
  reasons: string[];
}

const DONE_CLAIM_RE =
  /\b(pronto\s+al\s+commit|complet[oa]|hand[- ]?off|implementat[oi]|tutto\s+fatto)\b/i;

/**
 * Detect council runs that should not be treated as a clean hand-off.
 */
export function detectDegradedRun(input: DegradedRunInput): DegradedRunResult {
  if (input.runMode === 'design-phase') {
    return { degraded: false, reasons: [] };
  }
  const reasons: string[] = [];
  if (input.chairmanErrored) reasons.push('chairman errored');
  if (input.councilAborted) reasons.push('council aborted');
  const writes = input.luciferWriteCount ?? 0;
  if (DONE_CLAIM_RE.test(input.synthesisText ?? '') && writes === 0) {
    reasons.push('synthesis claims done but no files were written');
  }
  return { degraded: reasons.length > 0, reasons };
}

/** Warn when a degraded run omits the mandatory banner in synthesis. */
export function auditDegradedBanner(
  synthesisText: string | undefined,
  degraded: boolean,
): VerificationCheckResult[] {
  if (!degraded || !synthesisText?.trim()) return [];
  if (synthesisText.includes(DEGRADED_RUN_BANNER)) return [];
  return [{
    id: 'synthesis.degraded-banner',
    severity: 'warn',
    ok: false,
    tier: 'grep',
    message: `Degraded council run must include ${DEGRADED_RUN_BANNER} banner in synthesis`,
  }];
}
