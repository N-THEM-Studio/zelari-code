/**
 * verifyReport — structured per-check verification results (Fase 7, ADR-0020).
 *
 * A verify tentacle whose acceptance includes the turn's required checks
 * (Fase 6 routing) ends its conclusion with ONE `<verify-report>` block per
 * criterion:
 *
 *   <verify-report>
 *   check: unit test for session refresh passes
 *   status: pass
 *   note: vitest 41/41
 *   </verify-report>
 *
 * Parsing is LENIENT and deterministic:
 *   - missing/invalid status word  → `unknown`
 *   - criterion without a block    → `unknown` (no report ≠ pass)
 *   - failed tentacle              → all `unknown` (allUnknownCheckResults)
 *   - later duplicate blocks win   (the tentacle may correct itself)
 *
 * Observation integrity (§23 of the plan): `unknown` is a first-class
 * outcome. A degraded observation (timeout, broken tool) must never be
 * recorded as `pass` — the completion gate (Fase 8) treats only `pass` as
 * satisfied.
 */

/** Outcome of one required check as reported by the verify tentacle. */
export type KrakenCheckStatus = 'pass' | 'fail' | 'unknown';

/** Per-check result stored in the turn registry (candidateRegistry). */
export interface KrakenCheckResult {
  /** Required-check text exactly as produced by kraken_select. */
  check: string;
  status: KrakenCheckStatus;
  /** One-line evidence note from the tentacle (optional). */
  note?: string;
}

interface RawBlock {
  check: string;
  status: string;
  note?: string;
}

const OPEN = '<verify-report>';
const CLOSE = '</verify-report>';
const VALID_STATUSES: ReadonlySet<string> = new Set(['pass', 'fail', 'unknown']);

/** Lowercase + collapse whitespace (matching is wording-tolerant). */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract raw `<verify-report>` blocks in order of appearance. Blocks
 * without a `check:` line are skipped (nothing to match on); a missing or
 * invalid `status:` is kept as '' and sanitized to `unknown` at match time.
 */
export function extractVerifyReportBlocks(raw: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let cursor = 0;
  for (;;) {
    const open = raw.indexOf(OPEN, cursor);
    if (open === -1) break;
    const close = raw.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) break;
    const block: RawBlock = { check: '', status: '' };
    for (const line of raw.slice(open + OPEN.length, close).split(/\r?\n/)) {
      const m = /^(check|status|note)\s*:\s*(.*)$/i.exec(line.trim());
      if (!m) continue;
      const value = m[2].trim();
      const key = m[1].toLowerCase();
      if (key === 'check' && !block.check) block.check = value;
      else if (key === 'status' && !block.status) block.status = value;
      else if (key === 'note' && block.note === undefined) block.note = value;
    }
    if (block.check) blocks.push(block);
    cursor = close + CLOSE.length;
  }
  return blocks;
}

/**
 * Map the turn's required checks onto per-check results.
 *
 * Matching: normalized equality first, then containment (either direction)
 * so a tentacle that lightly rewords a criterion still matches; later
 * blocks for the same criterion override earlier ones.
 */
export function parseVerifyReport(
  raw: string,
  requiredChecks: readonly string[],
): KrakenCheckResult[] {
  const byCriterion = new Map<string, RawBlock>();
  for (const block of extractVerifyReportBlocks(raw)) {
    byCriterion.set(normalize(block.check), block);
  }
  const keys = [...byCriterion.keys()];
  return requiredChecks.map((check) => {
    const norm = normalize(check);
    let block: RawBlock | null = byCriterion.get(norm) ?? null;
    if (!block) {
      for (const key of keys) {
        if (key.length >= 8 && (key.includes(norm) || norm.includes(key))) {
          block = byCriterion.get(key) ?? null;
          break;
        }
      }
    }
    if (!block) {
      return {
        check,
        status: 'unknown' as const,
        note: 'no verify-report block for this check',
      };
    }
    const status: KrakenCheckStatus = VALID_STATUSES.has(block.status)
      ? (block.status as KrakenCheckStatus)
      : 'unknown';
    return { check, status, ...(block.note ? { note: block.note } : {}) };
  });
}

/**
 * All-unknown results for a verify tentacle that never produced a usable
 * conclusion (failure, abort, empty output). Degraded ≠ proof of anything.
 */
/**
 * One tool execution captured mechanically from a tentacle run (2.1 T5
 * provenance): the RAW tool output as the process saw it, not the agent's
 * note about it. Used to anchor verify-report evidence to real tool output.
 */
export interface TentacleToolTrace {
  tool: string;
  callId: string;
  ok: boolean;
  /** Best-effort command/path hint extracted from the call args. */
  command?: string;
  /** Bounded output excerpt (raw tool result, not the agent's note). */
  output: string;
  durationMs?: number;
  endedAt?: number;
}

/**
 * All-unknown results for a verify tentacle that never produced a usable
 * conclusion (failure, abort, empty output). Degraded ≠ proof of anything.
 */
export function allUnknownCheckResults(
  requiredChecks: readonly string[],
  reason: string,
): KrakenCheckResult[] {
  return requiredChecks.map((check) => ({
    check,
    status: 'unknown' as const,
    note: reason,
  }));
}
