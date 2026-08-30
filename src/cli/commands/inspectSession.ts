/**
 * inspectSession.ts — `zelari-code inspect <session-id> [--json]` (v0.10).
 *
 * FIRST consumer of the NDJSON `harness_state` event: reads the ADR-0023
 * read-model for one spine session (`<sessionsDir>/<id>/events.jsonl`) and
 * prints a human-readable report — header (session id + turnsTotal), one
 * line per turn (verification verdict + completion contract with blocker
 * count), and a "support lens" section (context projections, memory
 * events, compactions). `--json` prints the raw state instead.
 *
 * Advisory-only: reads the session spine, writes nothing, emits no events,
 * never influences mission/run exit codes. The sessions dir resolves exactly
 * like the harness_state emitter (workspaceRoot + ZELARI_SESSIONS_DIR,
 * ADR-0016) so the read matches what the headless hosts wrote. The
 * reader/derivation are REUSED from harnessState.ts — no re-parsing here.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { resolveSessionsDir } from '@zelari/core/session';
import { readHarnessState, type ContextProjectionRecord, type HarnessState } from '../harnessState.js';

/** Token-budget limit → human size: 200000 → `200k`. */
function formatLimit(limit: number): string {
  return `${Math.round(limit / 1000)}k`;
}

/**
 * Pure renderer — HarnessState → report text. No I/O, no clock, no color,
 * so it is testable without spawning the CLI (same discipline as the
 * read-model it renders).
 */
export function renderInspectReport(state: HarnessState): string {
  const lines: string[] = [
    `session ${state.session.sessionId}  status=${state.session.status}  turns=${state.execution.turnsTotal}`,
  ];
  const contractByTurn = new Map(state.execution.contracts.map((c) => [c.turn, c]));
  for (const turn of state.turns) {
    const contract = contractByTurn.get(turn.index);
    const verification = turn.verification
      ? `${turn.verification.verdict}${turn.verification.strict ? '' : ' (non-strict)'}`
      : 'unknown'; // ADR-0023: no verification evidence ⇒ unknown ≠ pass.
    const blockers = contract?.blockers ?? [];
    const completion = contract?.complete
      ? 'complete'
      : blockers.length > 0
        ? `incomplete — ${blockers.length} blockers: ${blockers.join(', ')}`
        : 'incomplete';
    lines.push(
      `  turn ${turn.index}  [${turn.outcome}]  verification: ${verification}  contract: ${completion}`,
    );
  }
  lines.push('');
  lines.push('support lens:');
  const projections = state.support.contextProjections;
  const last = projections[projections.length - 1];
  // T4 (ADR-0032): a budget-side last record (occupancy + limit) replaces the
  // memory-side chars→items descriptor with the human budget occupancy.
  const tail = !last
    ? ''
    : last.occupancy !== undefined && last.contextLimit !== undefined
      ? `  (last: ${Math.round(last.occupancy * 100)}% ${last.policy ?? '?'} (limit ${formatLimit(last.contextLimit)}))`
      : `  (last: ${last.contextChars} chars → ${last.returnedCount} items)`;
  lines.push(`  context projections: ${projections.length}${tail}`);
  lines.push(`  memory events: ${state.support.memoryEvents}`);
  const saved = state.support.tokensSavedByCompaction;
  lines.push(
    `  compactions: ${state.support.compactions}${saved !== undefined ? ` (${saved} tokens saved)` : ''}`,
  );
  return lines.join('\n');
}

export interface InspectSessionOptions {
  /** Session folder name under the sessions dir (spine sessionId). */
  sessionId: string;
  /** Machine-readable output: the raw HarnessState, pretty-printed. */
  json?: boolean;
  /** Workspace root for the sessions-dir resolution (defaults to process.cwd()). */
  cwd?: string;
}

/** Run the session-inspect command. Prints to stdout/stderr; returns the exit code. */
export async function runInspectSession(opts: InspectSessionOptions): Promise<number> {
  const sessionsDir = resolveSessionsDir({ workspaceRoot: opts.cwd ?? process.cwd() });
  const sessionDir = path.join(sessionsDir, opts.sessionId);
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  // readHarnessState is tolerant by contract (missing log ⇒ empty pending
  // state), so "session not found" is checked HERE, before the read.
  if (!existsSync(sessionDir)) {
    // eslint-disable-next-line no-console
    console.error(`zelari-code inspect: no session directory at ${sessionDir}`);
    return 1;
  }
  if (!existsSync(eventsPath)) {
    // eslint-disable-next-line no-console
    console.error(`zelari-code inspect: session directory has no events.jsonl at ${eventsPath}`);
    return 1;
  }
  let state: HarnessState;
  try {
    state = await readHarnessState(sessionDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`zelari-code inspect: cannot read session at ${sessionDir}: ${msg}`);
    return 1;
  }
  // eslint-disable-next-line no-console
  console.log(opts.json ? JSON.stringify(state, null, 2) : renderInspectReport(state));
  return 0;
}
