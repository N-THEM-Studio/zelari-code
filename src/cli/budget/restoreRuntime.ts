/**
 * src/cli/budget/restoreRuntime.ts — host-parity resume helper (2.6.1
 * closure plan §10). ONE path rebuilds the live BudgetRuntime from the
 * durable session log so TUI, headless and the Desktop bridge reconstruct
 * the SAME cumulative ResourceLedger and active execution epoch after a
 * resume. A new user turn then advances the epoch and starts again at 0:
 *
 *   interrupted 12/40 → resume same epoch → remaining 28
 *   completed 40/40 → new user turn → 0/40 (session total stays 40)
 */

import { readSessionLog, resolveSessionsDir } from '@zelari/core/session';
import path from 'node:path';
import type { BudgetRuntime } from './budgetRuntime.js';

/**
 * Rebuild `budget` usage from `<sessionsDir>/<sessionId>/events.jsonl`.
 * Returns false when there is nothing to resume from (fresh session).
 */
export async function restoreBudgetRuntimeFromSession(
  budget: BudgetRuntime,
  sessionId: string,
  baseDir?: string,
): Promise<boolean> {
  const eventsPath = path.join(resolveSessionsDir({ baseDir }), sessionId, 'events.jsonl');
  const report = await readSessionLog(eventsPath).catch(() => null);
  if (!report || report.events.length === 0) return false;
  budget.adoptLedgerFromEvents(report.events);
  return true;
}

/**
 * 2.6.1 (plan §6): hash of the LAST persisted session.harness_manifest
 * (null when the log has none) — the resume-time drift baseline.
 */
export async function lastHarnessManifestHash(
  sessionId: string,
  baseDir?: string,
): Promise<string | null> {
  const eventsPath = path.join(resolveSessionsDir({ baseDir }), sessionId, 'events.jsonl');
  const report = await readSessionLog(eventsPath).catch(() => null);
  if (!report) return null;
  for (let i = report.events.length - 1; i >= 0; i--) {
    const e = report.events[i]!;
    if (e.kind === 'session.harness_manifest') {
      const h = (e.data as { manifestHash?: unknown }).manifestHash;
      return typeof h === 'string' ? h : null;
    }
  }
  return null;
}
