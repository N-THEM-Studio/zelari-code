/**
 * inboxFeed — the `inbox` status-line item: "what is waiting on YOU", derived
 * from the CURRENT session spine (derive-only, ADR-0016/0024).
 *
 * Same discipline as verdictFeed (t124): this module READS entries.jsonl, never
 * writes and never feeds the model. The item is OPT-IN (`/statusline on inbox`),
 * so the default bar is unchanged; the counts come from the very same
 * projections `/inbox` prints:
 *   - `questions` — unanswered `ask_user` calls (inbox.ts, t125);
 *   - `needs`     — open needs: un-cleared verify debt + permission denials;
 *   - `finished`  — tentacle completions you have not spoken past yet.
 *
 * Kill switch: `ZELARI_INBOX=0` (the t125 switch, reused — one switch for the
 * whole inbox surface, not a second knob) ⇒ `inboxFeedText()` returns null and
 * the item paints nothing.
 *
 * HONESTY: nothing recorded (or an unreadable spine) ⇒ zero rows ⇒ no item
 * text. A zero is never printed as if it were a measurement of "all clear".
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSessionLogText, resolveSessionsDir } from '@zelari/core/session';
import { getCurrentSessionId } from '../sessionManager.js';
import { deriveInboxQuestions, inboxEnabled, type InboxEventLike } from '../inbox.js';
import { deriveInboxSourceRows } from '../inboxSources.js';

export interface InboxFeed {
  /** Unanswered `ask_user` questions of the current session. */
  questions: number;
  /** Open needs: un-cleared verify debt + permission denials. */
  needs: number;
  /** Tentacle completions not yet spoken past. */
  finished: number;
  /** Sum of the three sources. */
  total: number;
}

/** The honest "nothing derived" feed. */
export function emptyInboxFeed(): InboxFeed {
  return { questions: 0, needs: 0, finished: 0, total: 0 };
}

/**
 * Project ONE session's events into the feed. Pure: no I/O, no clock. The
 * session id is a label here (the rows are counted, not reported), hence the
 * neutral `current` handle.
 */
export function deriveInboxFeed(events: readonly InboxEventLike[]): InboxFeed {
  const questions = deriveInboxQuestions(events, { sessionId: 'current' }).length;
  const rows = deriveInboxSourceRows(events);
  const needs = rows.filter((r) => r.source === 'needs-input').length;
  return { questions, needs, finished: rows.length - needs, total: questions + rows.length };
}

/**
 * Item text for the `inbox` statusline item, or null when there is nothing
 * honest to say (kill switch off, or nothing waiting). Terse on purpose: the
 * bar is one line. `inbox 3` / `inbox 3 (1 need)`.
 */
export function inboxFeedText(feed: InboxFeed | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!inboxEnabled(env)) return null;
  if (!feed || feed.total === 0) return null;
  return feed.needs > 0 ? `inbox ${feed.total} (${feed.needs} need)` : `inbox ${feed.total}`;
}

export interface InboxFeedReadOptions {
  /** Spine session id; defaults to the current-session marker. */
  sessionId?: string;
  /** Sessions dir override (tests); defaults to resolveSessionsDir({workspaceRoot, env}). */
  sessionsDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Read the inbox feed of the CURRENT run from its spine log. Tolerant by
 * contract: a missing marker/file, a corrupt log or a kill-switched inbox all
 * return the empty feed.
 */
export function readInboxFeed(opts: InboxFeedReadOptions = {}): InboxFeed {
  const env = opts.env ?? process.env;
  if (!inboxEnabled(env)) return emptyInboxFeed();
  const sessionId = opts.sessionId ?? getCurrentSessionId();
  if (!sessionId) return emptyInboxFeed();
  const dir = opts.sessionsDir ?? resolveSessionsDir({ workspaceRoot: opts.cwd, env });
  const file = path.join(dir, sessionId, 'events.jsonl');
  try {
    if (!existsSync(file)) return emptyInboxFeed();
    return deriveInboxFeed(parseSessionLogText(file, readFileSync(file, 'utf-8')).events);
  } catch {
    return emptyInboxFeed();
  }
}
