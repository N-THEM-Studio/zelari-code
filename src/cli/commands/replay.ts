/**
 * commands/replay — `zelari-code replay [<sessionId>] [--json]` (WS7 slice 2).
 *
 * WHAT IT READS: one spine (`<sessionsDir>/<sessionId>/events.jsonl`, ADR-0016)
 * parsed with the CORE reader (`parseSessionLogText` → `buildProjection`,
 * @zelari/core/session). Nothing is parsed by hand here and nothing is
 * re-derived: replay is a RENDERER over pure projections.
 *
 * WHAT IT PRINTS (deterministic order):
 *   - header: session, spine path, event count, last seq, spine issues;
 *   - tool calls: totals + per-tool tally + dangling calls (crash recovery);
 *   - verify debt: the K1.5/F5 open/cleared pairs (open ones named);
 *   - verify runs: count + the last run's criterion tally;
 *   - decision events: every `permission.asked` / `auto_approve.granted` /
 *     `jail.blocked` / `ask_user.fired` / `verify.requested` /
 *     `permission.denied` on the spine, in log order.
 *
 * `--json` prints the WHOLE projection (`{schemaVersion, sessionId, path, ok,
 * projection}`) for Desktop / shadow-replay tooling.
 *
 * READ-ONLY, absolutely: it opens the spine for reading and writes NOTHING —
 * no spine append, no cache, no state file, no network. That is the property
 * the whole slice rests on (a replay that mutates the log it reads is not a
 * replay), and it is pinned by tests.
 *
 * Exit code: 0 when the spine was found and replayed (even with issues — the
 * tolerant reader already skipped them and the report says so). 1 only when
 * there was nothing to replay (unknown id / no sessions). `session validate`
 * is the command that GATES on issues.
 *
 * @since v2.59.0 (WS7 / shadow replay)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildProjection,
  parseSessionLogText,
  type ReplayReport,
  type SessionProjection,
} from '@zelari/core/session';
import { resolveSpineSession } from './spineSession.js';

export interface ReplayFlags {
  help?: boolean;
  json?: boolean;
  cwd?: string;
  /** First positional after the command token, when present. */
  sessionId?: string;
}

/** Parse `replay` flags. Never throws; unknown flags are ignored (acp parity). */
export function parseReplayFlags(argv: readonly string[]): ReplayFlags {
  const args = argv[0] === 'replay' ? argv.slice(1) : [...argv];
  const out: ReplayFlags = {};
  if (args.includes('--help') || args.includes('-h')) out.help = true;
  out.json = args.includes('--json');
  const i = args.indexOf('--cwd');
  const cwd = i >= 0 ? args[i + 1] : undefined;
  if (cwd !== undefined && cwd.trim() !== '' && !cwd.startsWith('--')) out.cwd = cwd;
  // Positional args, minus the value consumed by `--cwd`.
  const sessionId = args.find((a, idx) => !a.startsWith('-') && args[idx - 1] !== '--cwd');
  if (sessionId !== undefined) out.sessionId = sessionId;
  return out;
}

export function replayHelpText(): string {
  return (
    'zelari-code replay — replay a session spine (read-only, no LLM, no network)\n' +
    '\n' +
    'Re-reads one session log with the core tolerant reader and prints what it\n' +
    'contains: tool calls, verify debt, verify runs and decision events\n' +
    '(permission asks/denials, auto-approvals, jail blocks, ask_user, verify\n' +
    'requests). Nothing is written: the log it reads is never modified.\n' +
    '\n' +
    'Usage:\n' +
    '  zelari-code replay [<sessionId>] [--json]\n' +
    '\n' +
    'With no <sessionId>: the current-session marker, else the newest spine.\n' +
    '\n' +
    'Options:\n' +
    '  --json             Print the full projection as JSON\n' +
    '  --cwd <path>       Workspace root for the sessions dir\n' +
    '                     (default: current directory;\n' +
    '                     ZELARI_SESSIONS_DIR overrides both)\n' +
    '  --help, -h         This text\n' +
    '\n' +
    'Exit code: 0 on a successful replay (spine issues are reported, not\n' +
    'fatal — see `zelari-code session validate` to fail on them), 1 when there\n' +
    'was nothing to replay.\n'
  );
}

/** Human path (cwd-relative when possible) so the report stays readable. */
function shortPath(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') ? rel : p;
}

/**
 * Pure renderer — ReplayReport + projection → text. No I/O, no clock, no
 * color, so it is testable without touching a filesystem.
 */
export function renderReplayReport(input: {
  sessionId: string;
  eventsPath: string;
  report: Pick<ReplayReport, 'events' | 'issues' | 'ok'>;
  projection: SessionProjection;
  cwd?: string;
}): string {
  const { projection, report, sessionId } = input;
  const lines: string[] = [];
  lines.push(`replay — session ${sessionId}`);
  lines.push(`  spine: ${shortPath(input.eventsPath, input.cwd ?? process.cwd())}`);
  lines.push(
    `  events: ${projection.eventCount}  last seq: ${projection.lastSeq}  ` +
      (report.ok ? 'spine OK' : `spine ISSUES: ${report.issues.length}`),
  );
  if (projection.startedAt !== undefined) lines.push(`  started: ${new Date(projection.startedAt).toISOString()}`);
  if (projection.endedAt !== undefined) lines.push(`  ended:   ${new Date(projection.endedAt).toISOString()}`);
  if (projection.resumedCount > 0) lines.push(`  resumed: ${projection.resumedCount}×`);
  if (projection.fork !== undefined) {
    lines.push(`  fork of: ${projection.fork.parentSessionId}@${projection.fork.parentSeq}`);
  }

  lines.push('');
  lines.push(`tool calls: ${projection.toolCalls}  results: ${projection.toolResults}`);
  for (const row of projection.toolCallBreakdown) {
    lines.push(`  ${row.tool.padEnd(20)} ${row.calls} call(s) / ${row.results} result(s)`);
  }
  if (projection.toolCallBreakdown.length === 0) lines.push('  (no tool calls on this spine)');
  if (projection.interruptedTools.length > 0) {
    lines.push(`  dangling (no tool.result): ${projection.interruptedTools.length}`);
    for (const t of projection.interruptedTools) {
      lines.push(`    ${t.tool} (${t.callId}) — ${t.state}, retry ${t.retrySafety} [seq ${t.toolCallSeq}]`);
    }
  }

  const openDebt = projection.verifyDebts.filter((d) => d.clearedSeq === undefined);
  lines.push('');
  lines.push(
    `verify debt: ${openDebt.length} open / ${projection.verifyDebts.length - openDebt.length} cleared`,
  );
  for (const debt of projection.verifyDebts) {
    const state = debt.clearedSeq === undefined ? 'OPEN   ' : 'cleared';
    const closed = debt.clearedSeq === undefined ? '' : ` (cleared seq ${debt.clearedSeq})`;
    lines.push(`  ${state} ${debt.taskId} — ${debt.description || '(no description)'} [seq ${debt.openedSeq}]${closed}`);
  }

  lines.push('');
  lines.push(`verify runs: ${projection.verifications.length}`);
  const lastRun = projection.verifications[projection.verifications.length - 1];
  if (lastRun !== undefined) {
    const pass = lastRun.results.filter((r) => r.status === 'pass').length;
    lines.push(
      `  last run: ${pass}/${lastRun.results.length} pass` +
        (lastRun.complete === undefined ? '' : `, complete=${lastRun.complete}`),
    );
  }

  lines.push('');
  lines.push(`decision events: ${projection.decisionEvents.length}`);
  for (const d of projection.decisionEvents) {
    const who = d.tool ? ` ${d.tool}` : '';
    const why = d.detail ? `  — ${d.detail}` : '';
    lines.push(`  seq ${String(d.seq).padStart(4)}  ${d.kind.padEnd(20)}${who}${why}`);
  }
  if (projection.decisionEvents.length === 0) {
    lines.push('  (no decision events on this spine)');
  }

  if (report.issues.length > 0) {
    const kinds = new Map<string, number>();
    for (const issue of report.issues) kinds.set(issue.type, (kinds.get(issue.type) ?? 0) + 1);
    lines.push('');
    lines.push(
      `spine issues: ${report.issues.length} (` +
        [...kinds.entries()].map(([t, n]) => `${t}×${n}`).join(', ') +
        ') — ignored by the tolerant reader (run: zelari-code session validate)',
    );
  }
  return lines.join('\n');
}

/**
 * Entry point for `zelari-code replay …`. Accepts argv WITH or WITHOUT the
 * leading `replay` token. Never throws; the exit code is the return value so
 * main.ts owns process teardown (and tests can assert it).
 */
export async function runReplayCommand(argv: readonly string[]): Promise<number> {
  try {
    const opts = parseReplayFlags(argv);
    if (opts.help === true) {
      process.stdout.write(replayHelpText());
      return 0;
    }
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    const resolved = resolveSpineSession({
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      cwd,
    });
    if ('error' in resolved) {
      process.stderr.write(`[replay] ${resolved.error}\n`);
      return 1;
    }
    const text = readFileSync(resolved.eventsPath, 'utf-8');
    const report = parseSessionLogText(resolved.eventsPath, text);
    const projection = buildProjection(report.events, report.issues);
    if (opts.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            sessionId: resolved.sessionId,
            path: resolved.eventsPath,
            ok: report.ok,
            projection,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(
        `${renderReplayReport({
          sessionId: resolved.sessionId,
          eventsPath: resolved.eventsPath,
          report,
          projection,
          cwd,
        })}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`[zelari-code replay] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
