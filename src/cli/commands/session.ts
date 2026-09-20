/**
 * commands/session — `zelari-code session validate [<sessionId>] [--json]`.
 *
 * WHY THIS EXISTS: the spine reader is TOLERANT by contract — a corrupt line,
 * a seq gap, a duplicate or an unknown kind never throws, it becomes a
 * `ReplayIssue` and the rest of the log still replays (ADR-0016). That is the
 * right default for recovery, and the wrong default for "is this log sound?".
 * This command is the second half of the pair: it reads the same spine through
 * the SAME reader and reports the issues the reader collected, with `seq` and
 * reason, so an audit can act on them.
 *
 *   zelari-code session validate           current marker → newest spine
 *   zelari-code session validate <id>      one explicit session
 *   zelari-code session validate --json    machine-readable report
 *
 * EXIT CODE IS THE VERDICT (unlike `replay`, which reports and exits 0):
 *   0 — the spine parsed clean (or is empty), seq 1..n gap-free;
 *   1 — issues found, or there was no spine to validate.
 *
 * READ-ONLY: opens the log for reading, writes nothing, no network.
 *
 * @since v2.59.0 (WS7 / shadow replay)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSessionLogText, type ReplayIssue, type ReplayReport } from '@zelari/core/session';
import { resolveSpineSession } from './spineSession.js';

export interface SessionFlags {
  help?: boolean;
  json?: boolean;
  cwd?: string;
  sessionId?: string;
}

/** Parse `session` flags. Never throws; unknown flags are ignored (acp parity). */
export function parseSessionFlags(argv: readonly string[]): SessionFlags {
  const args = argv[0] === 'session' ? argv.slice(1) : [...argv];
  const out: SessionFlags = {};
  if (args.includes('--help') || args.includes('-h')) out.help = true;
  out.json = args.includes('--json');
  const i = args.indexOf('--cwd');
  const cwd = i >= 0 ? args[i + 1] : undefined;
  if (cwd !== undefined && cwd.trim() !== '' && !cwd.startsWith('--')) out.cwd = cwd;
  const positional = args.filter((a, idx) => !a.startsWith('-') && args[idx - 1] !== '--cwd');
  // positional[0] is the subcommand itself (`validate`).
  if (positional[1] !== undefined) out.sessionId = positional[1];
  return out;
}

export function sessionHelpText(): string {
  return (
    'zelari-code session — inspect one session spine (read-only)\n' +
    '\n' +
    'Usage:\n' +
    '  zelari-code session validate [<sessionId>] [--json]\n' +
    '\n' +
    'validate re-reads the log with the core tolerant reader and reports the\n' +
    'ReplayIssues it collected (corrupt lines, schema mismatches, seq gaps /\n' +
    'duplicates / non-monotonic seq) with line, seq and reason. With no\n' +
    '<sessionId>: the current-session marker, else the newest spine.\n' +
    '\n' +
    'Options:\n' +
    '  --json             Print {schemaVersion, sessionId, path, ok,\n' +
    '                     eventCount, lastSeq, issues} as JSON\n' +
    '  --cwd <path>       Workspace root for the sessions dir\n' +
    '                     (default: current directory;\n' +
    '                     ZELARI_SESSIONS_DIR overrides both)\n' +
    '  --help, -h         This text\n' +
    '\n' +
    'Exit code: 0 when the spine parsed clean, 1 when issues were found (or\n' +
    'when there was no spine to validate).\n'
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
 * Entry point for `zelari-code session …`. Accepts argv WITH or WITHOUT the
 * leading `session` token. Never throws; the exit code is the return value.
 */
export async function runSessionCommand(argv: readonly string[]): Promise<number> {
  try {
    const args = argv[0] === 'session' ? argv.slice(1) : [...argv];
    const opts = parseSessionFlags(args);
    const subcommand = args.find((a, idx) => !a.startsWith('-') && args[idx - 1] !== '--cwd');
    if (opts.help === true) {
      process.stdout.write(sessionHelpText());
      return 0;
    }
    if (subcommand === undefined) {
      process.stderr.write('[session] missing subcommand\n\n');
      process.stdout.write(sessionHelpText());
      return 1;
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
