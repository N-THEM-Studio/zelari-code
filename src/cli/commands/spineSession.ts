/**
 * commands/spineSession — which spine session a read-only command means.
 *
 * `replay` and `session validate` both answer "give me ONE session's
 * events.jsonl" and must agree on the answer, so the selection lives here once:
 *
 *   1. an explicit session id (must have an events.jsonl), else
 *   2. the current-session marker (`getCurrentSessionId()`), else
 *   3. the NEWEST session dir that actually holds an events.jsonl.
 *
 * The directory resolves exactly like every other spine writer/reader
 * (`resolveSessionsDir`: ZELARI_SESSIONS_DIR → `<workspaceRoot>/.zelari/sessions`,
 * ADR-0016), so commands/replay sees what the hosts wrote. Step 3 mirrors
 * commands/report.ts's `newestSessionId` ("newest by LAST event ts") so
 * `report`, `replay` and `session validate` never disagree about the newest run.
 *
 * READ-ONLY by construction: stat/readdir/read of the spine, nothing else.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseSessionLogText, resolveSessionsDir } from '@zelari/core/session';
import { getCurrentSessionId } from '../sessionManager.js';

export interface ResolvedSpineSession {
  sessionId: string;
  sessionsDir: string;
  eventsPath: string;
}

export interface SpineSessionQuery {
  /** Explicit session id; omitted ⇒ marker, then newest. */
  sessionId?: string;
  /** Workspace root for the sessions-dir resolution (default: process.cwd()). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Newest session dir holding an events.jsonl (by last event ts), or null. */
export function newestSpineSessionId(sessionsDir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(sessionsDir).filter((n) => existsSync(path.join(sessionsDir, n, 'events.jsonl')));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const scored = names.map((n) => {
    try {
      const text = readFileSync(path.join(sessionsDir, n, 'events.jsonl'), 'utf-8');
      const events = parseSessionLogText('events.jsonl', text).events;
      return { n, ts: events[events.length - 1]?.ts ?? 0 };
    } catch {
      return { n, ts: 0 };
    }
  });
  scored.sort((a, b) => b.ts - a.ts);
  return scored[0]?.n ?? null;
}

/**
 * Resolve the one session a read-only command targets. Never throws: every
 * failure mode comes back as `{ error }` naming the path it looked at.
 */
export function resolveSpineSession(
  query: SpineSessionQuery = {},
): ResolvedSpineSession | { error: string } {
  const cwd = query.cwd ?? process.cwd();
  const sessionsDir = resolveSessionsDir({ workspaceRoot: cwd, env: query.env });
  const at = (sessionId: string) => ({
    sessionId,
    sessionsDir,
    eventsPath: path.join(sessionsDir, sessionId, 'events.jsonl'),
  });

  if (query.sessionId !== undefined && query.sessionId !== '') {
    const candidate = at(query.sessionId);
    return existsSync(candidate.eventsPath)
      ? candidate
      : { error: `no session spine at ${candidate.eventsPath}` };
  }
  const marker = getCurrentSessionId();
  if (marker !== null) {
    const candidate = at(marker);
    if (existsSync(candidate.eventsPath)) return candidate;
  }
  const newest = newestSpineSessionId(sessionsDir);
  if (newest === null) {
    return { error: `no session spine found under ${sessionsDir}` };
  }
  return at(newest);
}
