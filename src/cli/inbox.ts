/**
 * inbox — `/inbox`: what is waiting on YOU, derived from the LOCAL spine.
 *
 * DERIVE-ONLY (ADR-0016/0024): this module READS
 * `<sessionsDir>/<id>/events.jsonl` and never writes, mutates or injects
 * anything (feeding a model is gated separately by ADR-0031 context.projection).
 *
 * WHAT IT LOOKS FOR ON THE SPINE — grounded on how ask_user is recorded today
 * (`src/cli/sessionSpine.ts` maps BrainEvents; there is NO dedicated ask_user
 * spine kind — the companion/serve `ask_user.request|settled` frames are
 * transport frames, not session events):
 *   - the QUESTION: `tool.call` with `data.tool === 'ask_user'`
 *     (`data.callId`, `data.args.question`, `data.args.choices`);
 *   - the SETTLEMENT: `tool.result` with the SAME `data.callId` — an answer, a
 *     cancel or a timeout all mean the ask is no longer waiting on you;
 *   - a DEAD RUN: `tool.interrupted` with the same `callId` (crash recovery
 *     classified the dangling call). The question was never settled, but the
 *     session that asked is gone ⇒ listed with `available: false`.
 *
 * TOLERANT BY CONTRACT: an unreadable/corrupt/empty spine is skipped and
 * counted, never thrown; a call without a `callId` is skipped too — it could
 * never be proven settled, so claiming it as pending would be a guess.
 *
 * Kill switch: `ZELARI_INBOX=0` ⇒ `renderInbox()` answers "disabled" (an
 * env-gated command reports its state, it does not vanish silently).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSessionLogText, resolveSessionsDir } from '@zelari/core/session';

/** Structural event view (a SessionEventEnvelope is assignable to it). */
export interface InboxEventLike {
  kind: string;
  seq: number;
  ts: number;
  data?: Record<string, unknown>;
}

/** One question that was asked locally and never settled. */
export interface InboxQuestion {
  sessionId: string;
  /** Human handle of the destination session: first user prompt, else `''`. */
  destination: string;
  question: string;
  choices: string[];
  callId: string;
  /** seq/ts of the `tool.call` that asked (ordering + age of the question). */
  seq: number;
  ts: number;
  /** false = crash recovery classified the call interrupted: resume, then re-ask. */
  available: boolean;
}

/** Most-recent questions kept (per scan, across all sessions). */
export const INBOX_LIMIT = 20;

/** Default-ON kill switch: only the exact `0` disables `/inbox`. */
export function inboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZELARI_INBOX !== '0';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Collapse to one short line — inbox rows stay readable. */
function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `data.args`, tolerating a JSON string (some hosts serialize tool args). */
function argsOf(data: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof data.args === 'string') {
    try {
      return asRecord(JSON.parse(data.args));
    } catch {
      return null;
    }
  }
  return asRecord(data.args);
}

interface AskCall {
  callId: string;
  question: string;
  choices: string[];
  seq: number;
  ts: number;
}

/** The `ask_user` question of one `tool.call`, or null when there is none. */
function askOf(ev: InboxEventLike): AskCall | null {
  if (ev.kind !== 'tool.call') return null;
  const data = asRecord(ev.data);
  if (!data || data.tool !== 'ask_user') return null;
  const callId = typeof data.callId === 'string' ? data.callId : '';
  if (callId.length === 0) return null; // unattributable: never claimed as pending
  const args = argsOf(data);
  const question = typeof args?.question === 'string' ? args.question.replace(/\s+/g, ' ').trim() : '';
  if (question.length === 0) return null; // no question text recorded ⇒ nothing to answer
  const choices = Array.isArray(args?.choices)
    ? args.choices.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  return { callId, question, choices, seq: ev.seq, ts: ev.ts };
}

/** callIds named by `kind` events (settlement / interruption). */
function callIdsOf(events: readonly InboxEventLike[], kind: string): Set<string> {
  const ids = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== kind) continue;
    const callId = asRecord(ev.data)?.callId;
    if (typeof callId === 'string' && callId.length > 0) ids.add(callId);
  }
  return ids;
}

/** First user prompt of the session — the human handle for `/resume`. */
function destinationOf(events: readonly InboxEventLike[]): string {
  for (const ev of events) {
    if (ev.kind !== 'user.message') continue;
    const text = asRecord(ev.data)?.text;
    if (typeof text === 'string' && text.trim().length > 0) return oneLine(text, 72);
  }
  return '';
}

export interface DeriveInboxOptions {
  sessionId: string;
  /** Human handle of the session (defaults to ''; the renderer falls back to the id). */
  destination?: string;
  /** false ⇒ every entry is marked unavailable (spine unreadable). */
  available?: boolean;
}

/**
 * Pending questions of ONE session, from its recorded events only: every
 * `ask_user` call with a callId and a question, minus the callIds a
 * `tool.result` settled. Pure — no I/O, no clock.
 */
export function deriveInboxQuestions(
  events: readonly InboxEventLike[],
  opts: DeriveInboxOptions,
): InboxQuestion[] {
  const settled = callIdsOf(events, 'tool.result');
  const interrupted = callIdsOf(events, 'tool.interrupted');
  const available = opts.available !== false;
  const out: InboxQuestion[] = [];
  for (const ev of events) {
    const ask = askOf(ev);
    if (!ask || settled.has(ask.callId)) continue;
    out.push({
      sessionId: opts.sessionId,
      destination: opts.destination ?? '',
      question: ask.question,
      choices: ask.choices,
      callId: ask.callId,
      seq: ask.seq,
      ts: ask.ts,
      available: available && !interrupted.has(ask.callId),
    });
  }
  return out;
}

export interface InboxScanOptions {
  /** Sessions dir override (tests); defaults to resolveSessionsDir({workspaceRoot, env}). */
  sessionsDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
}

export interface InboxScan {
  sessionsDir: string;
  /** Session spines that were read successfully. */
  sessions: number;
  /** Spines skipped: unreadable, empty or fully corrupt (never thrown). */
  skipped: number;
  /** Most recent first, capped at `limit`. */
  entries: InboxQuestion[];
  /** true when the cap hid older questions. */
  truncated: boolean;
}

/**
 * Scan every local session spine for unanswered `ask_user` questions. Most
 * recent first, capped at `INBOX_LIMIT`; a broken session is skipped and
 * counted — this command is diagnostics, never a gate.
 */
export function scanInbox(opts: InboxScanOptions = {}): InboxScan {
  const env = opts.env ?? process.env;
  const sessionsDir = opts.sessionsDir ?? resolveSessionsDir({ workspaceRoot: opts.cwd, env });
  const limit = opts.limit ?? INBOX_LIMIT;
  const found: InboxQuestion[] = [];
  let sessions = 0;
  let skipped = 0;
  let names: string[];
  try {
    names = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { sessionsDir, sessions: 0, skipped: 0, entries: [], truncated: false };
  }
  for (const name of names) {
    const file = path.join(sessionsDir, name, 'events.jsonl');
    try {
      if (!existsSync(file)) continue; // not a spine session dir
      const report = parseSessionLogText(file, readFileSync(file, 'utf-8'));
      if (report.events.length === 0) {
        skipped += 1; // empty or unreadable content: unknown, never "answered"
        continue;
      }
      sessions += 1;
      found.push(
        ...deriveInboxQuestions(report.events, { sessionId: name, destination: destinationOf(report.events) }),
      );
    } catch {
      skipped += 1;
    }
  }
  found.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
  const entries = found.slice(0, Math.max(0, limit));
  return { sessionsDir, sessions, skipped, entries, truncated: found.length > entries.length };
}

/** `2026-10-02 14:03` — minute precision is enough to judge staleness. */
function askedAt(ts: number): string {
  try {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
  } catch {
    return '';
  }
}

/** One inbox row: destination, question, and how to get back to it. */
function formatEntry(entry: InboxQuestion, index: number): string[] {
  const handle = entry.destination
    ? `${entry.sessionId.slice(0, 8)}… · "${oneLine(entry.destination, 60)}"`
    : `${entry.sessionId.slice(0, 8)}…`;
  const lines = [`  ${index}. ${handle}`, `     Q: ${oneLine(entry.question)}`];
  const when = askedAt(entry.ts);
  const resume = entry.available
    ? `     → /resume ${entry.sessionId}`
    : `     → /resume ${entry.sessionId} (the run that asked was interrupted — re-ask after resuming)`;
  lines.push(when ? `${resume}   (asked ${when})` : resume);
  return lines;
}

/** Pure text rendering of a scan (no I/O). `total` 0 ⇒ the friendly empty state. */
export function formatInbox(scan: InboxScan): string {
  if (scan.sessions === 0) {
    return `[inbox] no local sessions under ${scan.sessionsDir} — nothing waiting on you.`;
  }
  const notes: string[] = [];
  if (scan.skipped > 0) notes.push(`note: ${scan.skipped} unreadable/empty session spine(s) skipped`);
  if (scan.truncated) notes.push(`note: showing the ${scan.entries.length} most recent`);
  if (scan.entries.length === 0) {
    const head = `[inbox] nothing waiting on you — no unanswered ask_user question in ${scan.sessions} session(s).`;
    return [head, ...notes.map((n) => `  ${n}`)].join('\n');
  }
  const lines: string[] = [
    `[inbox] ${scan.entries.length} question(s) waiting on you (${scan.sessions} session(s) scanned)`,
    '',
  ];
  scan.entries.forEach((entry, i) => lines.push(...formatEntry(entry, i + 1)));
  if (notes.length > 0) lines.push('', ...notes.map((n) => `  ${n}`));
  return lines.join('\n');
}

/** `/inbox` — kill switch, scan, render. Never throws. */
export function renderInbox(opts: InboxScanOptions = {}): string {
  const env = opts.env ?? process.env;
  if (!inboxEnabled(env)) {
    return '[inbox] disabled — ZELARI_INBOX=0 (unset it to list the questions waiting on you).';
  }
  return formatInbox(scanInbox(opts));
}
