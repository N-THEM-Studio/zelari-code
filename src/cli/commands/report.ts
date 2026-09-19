/**
 * commands/report — `/report`: one aggregate view of the ACTIVE session spine.
 *
 * WHAT IT READS: the session spine (`<sessionsDir>/<sessionId>/events.jsonl`,
 * ADR-0016 — `resolveSessionsDir` honors ZELARI_SESSIONS_DIR + workspaceRoot),
 * parsed with the CORE reader (`parseSessionLogText` → `buildProjection`,
 * @zelari/core/session). Nothing is re-parsed by hand: the tolerant reader
 * already reports corrupt lines as `ReplayIssue`s and skips retired kinds.
 *
 * WHAT IT PRINTS (markdown-ish text, deterministic order):
 *   - header: session id, event count, issues (corrupt/unknown lines);
 *   - files touched: unique paths + per-kind counters (`file.read`,
 *     `file.applied`, `file.rejected` — the ADR-0033 spine SSOT). Spines that
 *     predate ADR-0033 fall back to the `tool.call` args of the file tools,
 *     and the header SAYS SO (never a silent different source);
 *   - tool calls per tool (`tool.call`), with the result count;
 *   - verify outcomes: the LAST `verification.run` per criterion + totals;
 *   - tokens/cost: ONLY when those numbers are already on the spine
 *     (compaction projections + any event carrying usage/cost fields).
 *
 * FAIL-SOFT: a missing sessions dir, an unknown session id, an unreadable
 * file, or a spine with no events all produce a clear message and exit 0 —
 * this command is diagnostics, never a gate.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildProjection, parseSessionLogText, resolveSessionsDir } from '@zelari/core/session';
import { getCurrentSessionId } from '../sessionManager.js';

export interface ReportOptions {
  /** Explicit spine session id; defaults to the current marker, then newest. */
  sessionId?: string;
  /** Workspace root used for the sessions-dir resolution (default cwd). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface FileTally {
  path: string;
  read: number;
  applied: number;
  rejected: number;
}

export interface SessionReport {
  ok: boolean;
  sessionId: string;
  markdown: string;
}

const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit']);

/** Newest spine session dir that actually holds an events.jsonl (null when none). */
function newestSessionId(sessionsDir: string): string | null {
  try {
    const names = readdirSync(sessionsDir).filter((n) => existsSync(path.join(sessionsDir, n, 'events.jsonl')));
    if (names.length === 0) return null;
    const scored = names.map((n) => {
      try {
        const text = readFileSync(path.join(sessionsDir, n, 'events.jsonl'), 'utf-8');
        const last = parseSessionLogText('events.jsonl', text).events;
        return { n, ts: last[last.length - 1]?.ts ?? 0 };
      } catch {
        return { n, ts: 0 };
      }
    });
    scored.sort((a, b) => b.ts - a.ts);
    return scored[0]?.n ?? null;
  } catch {
    return null;
  }
}

/** Human path (cwd-relative when possible) so the report stays readable. */
function shortPath(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') ? rel : p;
}

function render(report: ReturnType<typeof parseSessionLogText>, cwd: string, sessionId: string): string {
  const projection = buildProjection(report.events, report.issues);
  const lines: string[] = [];
  lines.push(`# session report — ${sessionId}`);
  lines.push('');
  lines.push(`events: ${projection.eventCount}  tool calls: ${projection.toolCalls}  results: ${projection.toolResults}`);
  if (report.issues.length > 0) {
    const kinds = new Map<string, number>();
    for (const issue of report.issues) kinds.set(issue.type, (kinds.get(issue.type) ?? 0) + 1);
    lines.push(
      `spine issues: ${report.issues.length} (` +
        [...kinds.entries()].map(([t, n]) => `${t}×${n}`).join(', ') +
        ') — corrupt/unknown lines were skipped by the tolerant reader',
    );
  }
  if (projection.startedAt !== undefined) {
    lines.push(`started: ${new Date(projection.startedAt).toISOString()}`);
  }
  if (projection.endedAt !== undefined) {
    lines.push(`ended:   ${new Date(projection.endedAt).toISOString()}`);
  }

  // ── files ───────────────────────────────────────────────────────────────
  const files = new Map<string, FileTally>();
  const touch = (p: string): FileTally => {
    const key = p;
    const found = files.get(key);
    if (found) return found;
    const created: FileTally = { path: p, read: 0, applied: 0, rejected: 0 };
    files.set(key, created);
    return created;
  };
  let fileEvents = 0;
  for (const e of report.events) {
    const p = typeof e.data.path === 'string' ? e.data.path : null;
    if (!p) continue;
    if (e.kind === 'file.read') {
      touch(p).read += 1;
      fileEvents += 1;
    } else if (e.kind === 'file.applied') {
      touch(p).applied += 1;
      fileEvents += 1;
    } else if (e.kind === 'file.rejected') {
      touch(p).rejected += 1;
      fileEvents += 1;
    }
  }
  let filesSource = 'file.* spine events (ADR-0033)';
  if (fileEvents === 0) {
    // Pre-ADR-0033 spine: derive from the tool.call args instead, and say so.
    filesSource = 'tool.call args (legacy spine: no file.* events)';
    for (const e of report.events) {
      if (e.kind !== 'tool.call') continue;
      const tool = typeof e.data.tool === 'string' ? e.data.tool : '';
      if (!FILE_TOOLS.has(tool)) continue;
      const args = e.data.args as Record<string, unknown> | undefined;
      const p = typeof args?.path === 'string' ? args.path : null;
      if (p) touch(p).applied += 1;
    }
  }
  lines.push('');
  lines.push(`## files touched — ${files.size} unique (${filesSource})`);
  if (files.size === 0) {
    lines.push('  (none)');
  } else {
    const sorted = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const f of sorted) {
      const marks = [
        f.read > 0 ? `read×${f.read}` : '',
        f.applied > 0 ? `write×${f.applied}` : '',
        f.rejected > 0 ? `rejected×${f.rejected}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`  ${shortPath(f.path, cwd)}  ${marks}`);
    }
  }

  // ── tools ───────────────────────────────────────────────────────────────
  const byTool = new Map<string, number>();
  for (const e of report.events) {
    if (e.kind !== 'tool.call') continue;
    const tool = typeof e.data.tool === 'string' && e.data.tool.length > 0 ? e.data.tool : '(unknown)';
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
  }
  lines.push('');
  lines.push('## tool calls');
  if (byTool.size === 0) {
    lines.push('  (none)');
  } else {
    const sorted = [...byTool.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [tool, count] of sorted) lines.push(`  ${String(count).padStart(4)}  ${tool}`);
  }

  // ── verify ──────────────────────────────────────────────────────────────
  lines.push('');
  lines.push('## verify');
  if (projection.verifications.length === 0) {
    lines.push('  (no verification.run events on this spine)');
  } else {
    const last = projection.verifications[projection.verifications.length - 1];
    const pass = last.results.filter((r) => r.status === 'pass').length;
    const fail = last.results.filter((r) => r.status !== 'pass').length;
    lines.push(
      `  runs: ${projection.verifications.length}  last: ${new Date(last.at).toISOString()} — ` +
        `${pass} pass / ${fail} fail${last.complete === undefined ? '' : last.complete ? ' (complete)' : ' (incomplete)'}`,
    );
    for (const r of last.results) {
      lines.push(`  ${r.status.padEnd(8)} ${r.criterionId} (evidence ${r.evidenceCount})`);
    }
  }

  // ── tokens / cost (only what the spine already carries) ─────────────────
  let inputTokens = 0;
  let outputTokens = 0;
  let savedTokens = 0;
  let costUsd = 0;
  let sawTokens = false;
  let sawCost = false;
  for (const e of report.events) {
    const d = e.data as Record<string, unknown>;
    if (e.kind === 'session.compacted') {
      if (typeof d.inputTokens === 'number') {
        inputTokens += d.inputTokens;
        sawTokens = true;
      }
      if (typeof d.outputTokens === 'number') {
        outputTokens += d.outputTokens;
        sawTokens = true;
      }
      if (typeof d.savedTokens === 'number') {
        savedTokens += d.savedTokens;
        sawTokens = true;
      }
    }
    if (typeof d.costUsd === 'number') {
      costUsd += d.costUsd;
      sawCost = true;
    }
    const usage = d.usage;
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>;
      if (typeof u.inputTokens === 'number') {
        inputTokens += u.inputTokens;
        sawTokens = true;
      }
      if (typeof u.outputTokens === 'number') {
        outputTokens += u.outputTokens;
        sawTokens = true;
      }
      if (typeof u.costUsd === 'number') {
        costUsd += u.costUsd;
        sawCost = true;
      }
    }
  }
  if (sawTokens || sawCost) {
    lines.push('');
    lines.push('## tokens / cost (as recorded on the spine)');
    if (sawTokens) {
      lines.push(`  compaction tokens: in ${inputTokens} / out ${outputTokens} / saved ${savedTokens}`);
    }
    if (sawCost) lines.push(`  cost: $${costUsd.toFixed(4)}`);
  }
  return lines.join('\n');
}

/**
 * Build the report. Never throws: every failure mode returns
 * `{ ok: false, markdown: <clear message> }` (exit 0 by design).
 */
export function buildSessionReport(opts: ReportOptions = {}): SessionReport {
  const cwd = opts.cwd ?? process.cwd();
  const sessionsDir = resolveSessionsDir({ workspaceRoot: cwd, env: opts.env });
  const marker = opts.sessionId ?? getCurrentSessionId() ?? undefined;
  const marked = marker ? path.join(sessionsDir, marker, 'events.jsonl') : null;
  const sessionId = marker && marked && existsSync(marked) ? marker : newestSessionId(sessionsDir);
  if (!sessionId) {
    return {
      ok: false,
      sessionId: '',
      markdown: `no session spine found under ${sessionsDir} — nothing to report (this is not an error).`,
    };
  }
  const eventsPath = path.join(sessionsDir, sessionId, 'events.jsonl');
  let text: string;
  try {
    text = readFileSync(eventsPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, sessionId, markdown: `cannot read the session spine at ${eventsPath}: ${msg}` };
  }
  const parsed = parseSessionLogText(eventsPath, text);
  if (parsed.events.length === 0) {
    return {
      ok: false,
      sessionId,
      markdown: `session ${sessionId}: the spine holds no readable events (${parsed.issues.length} issue(s)) — ${eventsPath}`,
    };
  }
  return { ok: true, sessionId, markdown: render(parsed, cwd, sessionId) };
}

/** CLI entry: print the report to stdout; ALWAYS exit 0 (fail-soft). */
export function runReport(opts: ReportOptions = {}): number {
  const report = buildSessionReport(opts);
  // eslint-disable-next-line no-console
  console.log(report.markdown);
  return 0;
}
