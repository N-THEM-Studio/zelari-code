/**
 * commands/session — `zelari-code session validate [<sessionId>] [--json]`
 * and `zelari-code session waive-debt <sessionId> <taskId> [--note <text>]`.
 *
 * WHY THIS EXISTS: the spine reader is TOLERANT by contract — a corrupt line,
 * a seq gap, a duplicate or an unknown kind never throws, it becomes a
 * `ReplayIssue` and the rest of the log still replays (ADR-0016). That is the
 * right default for recovery, and the wrong default for "is this log sound?".
 * `validate` is the second half of the pair: it reads the same spine through
 * the SAME reader and reports the issues the reader collected, with `seq` and
 * reason, so an audit can act on them.
 *
 * `waive-debt` is the K1.5/F5 "or waive it" half of the verify-debt pair: the
 * debt cache hydrates un-cleared `verify.debt_open` slots at every turn start,
 * so a slot whose repair landed under a DIFFERENT taskId (a later repair
 * tentacle, a spot-check by the operator) would re-shout forever. This closes
 * the slot on the spine itself, through the same locked writer the runtime
 * uses. A waiver is an OPERATOR assertion, never a verification (ADR-0023).
 *
 *   zelari-code session validate           current marker → newest spine
 *   zelari-code session validate <id>      one explicit session
 *   zelari-code session validate --json    machine-readable report
 *   zelari-code session waive-debt <id> <taskId> [--note <text>]
 *
 * EXIT CODE IS THE VERDICT (unlike `replay`, which reports and exits 0):
 *   validate   — 0 clean / 1 issues (or no spine to validate);
 *   waive-debt — 0 cleared / 1 bad invocation or unknown taskId /
 *                2 spine locked by a live writer (never forced) /
 *                3 read or write error.
 *
 * `validate` is READ-ONLY; `waive-debt` appends exactly ONE event.
 *
 * @since v2.59.0 (WS7 / shadow replay; waive-debt K1.5/F5)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseSessionLogText,
  SessionLogLockedError,
  SessionLogWriter,
  type ReplayIssue,
  type ReplayReport,
} from '@zelari/core/session';
import { resolveSpineSession } from './spineSession.js';
import { replayOpenVerifyDebts } from '../tools/verifyDebtSpine.js';

export interface SessionFlags {
  help?: boolean;
  json?: boolean;
  cwd?: string;
  sessionId?: string;
  /** waive-debt: the debt slot id (second positional). */
  task?: string;
  /** waive-debt: why the slot is being waived (goes on the spine event). */
  note?: string;
}

/** Flags that take a value — the token after one is never a positional. */
const VALUE_FLAGS = new Set(['--cwd', '--note']);

/** Parse `session` flags. Never throws; unknown flags are ignored (acp parity). */
export function parseSessionFlags(argv: readonly string[]): SessionFlags {
  const args = argv[0] === 'session' ? argv.slice(1) : [...argv];
  const out: SessionFlags = {};
  if (args.includes('--help') || args.includes('-h')) out.help = true;
  out.json = args.includes('--json');
  const i = args.indexOf('--cwd');
  const cwd = i >= 0 ? args[i + 1] : undefined;
  if (cwd !== undefined && cwd.trim() !== '' && !cwd.startsWith('--')) out.cwd = cwd;
  const n = args.indexOf('--note');
  const note = n >= 0 ? args[n + 1] : undefined;
  if (note !== undefined && note.trim() !== '' && !note.startsWith('--')) out.note = note;
  const positional = args.filter((a, idx) => !a.startsWith('-') && !VALUE_FLAGS.has(args[idx - 1] ?? ''));
  // positional[0] is the subcommand itself (`validate` / `waive-debt`).
  if (positional[1] !== undefined) out.sessionId = positional[1];
  if (positional[2] !== undefined) out.task = positional[2];
  return out;
}

export function sessionHelpText(): string {
  return (
    'zelari-code session — inspect and curate one session spine\n' +
    '\n' +
    'Usage:\n' +
    '  zelari-code session validate [<sessionId>] [--json]\n' +
    '  zelari-code session waive-debt <sessionId> <taskId> [--note <text>]\n' +
    '\n' +
    'validate re-reads the log with the core tolerant reader and reports the\n' +
    'ReplayIssues it collected (corrupt lines, schema mismatches, seq gaps /\n' +
    'duplicates / non-monotonic seq) with line, seq and reason. With no\n' +
    '<sessionId>: the current-session marker, else the newest spine.\n' +
    '\n' +
    'waive-debt closes ONE open verify-debt slot (a verify.debt_open with no\n' +
    'matching verify.debt_cleared) by appending the cleared event through the\n' +
    'same locked writer the runtime uses. A waiver is an OPERATOR assertion,\n' +
    'not a verification (ADR-0023) — the event carries source=waiver plus the\n' +
    'optional --note, so replay can always tell the two apart.\n' +
    '\n' +
    'Options:\n' +
    '  --json             (validate) Print the report as JSON\n' +
    '  --note <text>      (waive-debt) Why the slot is being waived\n' +
    '  --cwd <path>       Workspace root for the sessions dir\n' +
    '                     (default: current directory;\n' +
    '                     ZELARI_SESSIONS_DIR overrides both)\n' +
    '  --help, -h         This text\n' +
    '\n' +
    'Exit codes: validate — 0 clean / 1 issues (or no spine). waive-debt —\n' +
    '0 cleared / 1 bad invocation or unknown taskId / 2 spine locked by a\n' +
    'live writer / 3 read or write error.\n'
  );
}

/** Human path (cwd-relative when possible) so the report stays readable. */
function shortPath(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') ? rel : p;
}

/** One issue → `line 12  seq-gap  seq=9  <detail>` (fields it actually carries). */
function formatIssue(issue: ReplayIssue): string {
  const seq = issue.seq === undefined ? '' : `  seq=${issue.seq}`;
  const detail = issue.detail === undefined ? '' : `  ${issue.detail}`;
  return `    line ${String(issue.line).padStart(5)}  ${issue.type}${seq}${detail}`;
}

/** Pure renderer — the parsed report → text. No I/O, no clock, no color. */
export function renderValidateReport(input: {
  sessionId: string;
  eventsPath: string;
  report: Pick<ReplayReport, 'events' | 'issues' | 'ok'>;
  cwd?: string;
}): string {
  const { report } = input;
  const last = report.events[report.events.length - 1];
  const lines: string[] = [];
  lines.push(`session validate — ${input.sessionId}`);
  lines.push(`  spine: ${shortPath(input.eventsPath, input.cwd ?? process.cwd())}`);
  lines.push(`  events: ${report.events.length}  last seq: ${last?.seq ?? 0}`);
  if (report.ok) {
    lines.push('  OK — every line parsed, seq 1..n gap-free');
    return lines.join('\n');
  }
  lines.push(`  ISSUES: ${report.issues.length} (the tolerant reader skipped these lines)`);
  for (const issue of report.issues) lines.push(formatIssue(issue));
  return lines.join('\n');
}

/**
 * `waive-debt` — close one open verify-debt slot with an operator waiver.
 *
 * Writes exactly ONE event (`verify.debt_cleared {taskId, source:'waiver',
 * note?}`, actor user/operator) through `SessionLogWriter.open`, which owns
 * the ADR-0016 single-writer lock: a live session refuses with exit 2 and
 * NOTHING is written — this command never forces a lock takeover.
 */
async function runWaiveDebt(opts: SessionFlags, cwd: string): Promise<number> {
  const sessionId = opts.sessionId?.trim() ?? '';
  const taskId = opts.task?.trim() ?? '';
  if (sessionId.length === 0 || taskId.length === 0) {
    process.stderr.write(
      '[session] usage: zelari-code session waive-debt <sessionId> <taskId> [--note <text>]\n',
    );
    return 1;
  }
  const resolved = resolveSpineSession({ sessionId, cwd });
  if ('error' in resolved) {
    process.stderr.write(`[session] ${resolved.error}\n`);
    return 3;
  }
  let report: ReplayReport;
  try {
    report = parseSessionLogText(resolved.eventsPath, readFileSync(resolved.eventsPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[session] ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
  const open = replayOpenVerifyDebts(report.events);
  const debt = open.get(taskId);
  if (debt === undefined) {
    process.stderr.write(
      `[session] taskId '${taskId}' is not an open verify debt on this spine\n`,
    );
    if (open.size === 0) {
      process.stdout.write('  no open verify debts\n');
    } else {
      process.stdout.write('  open verify debts:\n');
      for (const [id, rec] of open) process.stdout.write(`  ${id}  ${rec.description}\n`);
    }
    return 1;
  }
  const last = report.events[report.events.length - 1];
  const sessionDir = path.dirname(resolved.eventsPath);
  let writer: SessionLogWriter;
  try {
    writer = await SessionLogWriter.open(sessionDir, resolved.sessionId, (last?.seq ?? 0) + 1);
  } catch (err) {
    if (err instanceof SessionLogLockedError) {
      process.stderr.write(
        `[session] ${err.message} — close the live session first; nothing was written\n`,
      );
      return 2;
    }
    process.stderr.write(`[session] ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
  try {
    const envelope = await writer.append({
      kind: 'verify.debt_cleared',
      actor: { type: 'user', role: 'operator' },
      data: { taskId, source: 'waiver', ...(opts.note !== undefined ? { note: opts.note } : {}) },
    });
    await writer.close();
    process.stdout.write(`session waive-debt — ${resolved.sessionId}\n`);
    process.stdout.write(`  cleared: ${taskId} — ${debt.description}\n`);
    process.stdout.write(`  event: verify.debt_cleared seq=${envelope.seq} (source=waiver)\n`);
    if (opts.note !== undefined) process.stdout.write(`  note: ${opts.note}\n`);
    process.stdout.write(
      '  honesty: a waiver is an OPERATOR assertion, not a verification (ADR-0023: unknown ≠ pass)\n',
    );
    return 0;
  } catch (err) {
    await writer.close().catch(() => undefined);
    process.stderr.write(`[session] ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
}

/**
 * Entry point for `zelari-code session …`. Accepts argv WITH or WITHOUT the
 * leading `session` token. Never throws; the exit code is the return value.
 */
export async function runSessionCommand(argv: readonly string[]): Promise<number> {
  try {
    const args = argv[0] === 'session' ? argv.slice(1) : [...argv];
    const opts = parseSessionFlags(args);
    const subcommand = args.find((a, idx) => !a.startsWith('-') && !VALUE_FLAGS.has(args[idx - 1] ?? ''));
    if (opts.help === true) {
      process.stdout.write(sessionHelpText());
      return 0;
    }
    if (subcommand === undefined) {
      process.stderr.write('[session] missing subcommand\n\n');
      process.stdout.write(sessionHelpText());
      return 1;
    }
    if (subcommand === 'waive-debt') {
      return await runWaiveDebt(opts, path.resolve(opts.cwd ?? process.cwd()));
    }
    if (subcommand !== 'validate') {
      process.stderr.write(`[session] unknown subcommand '${subcommand}'\n\n`);
      process.stdout.write(sessionHelpText());
      return 1;
    }
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    const resolved = resolveSpineSession({
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      cwd,
    });
    if ('error' in resolved) {
      process.stderr.write(`[session] ${resolved.error}\n`);
      return 1;
    }
    const text = readFileSync(resolved.eventsPath, 'utf-8');
    const report = parseSessionLogText(resolved.eventsPath, text);
    const last = report.events[report.events.length - 1];
    if (opts.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            sessionId: resolved.sessionId,
            path: resolved.eventsPath,
            ok: report.ok,
            eventCount: report.events.length,
            lastSeq: last?.seq ?? 0,
            issues: report.issues,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(
        `${renderValidateReport({
          sessionId: resolved.sessionId,
          eventsPath: resolved.eventsPath,
          report,
          cwd,
        })}\n`,
      );
    }
    return report.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`[zelari-code session] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
