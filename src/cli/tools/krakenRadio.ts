/**
 * krakenRadio — lightweight parent↔tentacle progress bus (Fractal-inspired).
 *
 * File-backed JSONL under `.zelari/radio/<sessionId>.jsonl`.
 * No SQLite. Best-effort; never throws to callers of append.
 *
 * @since Kraken v1.x slice 2
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export type KrakenRadioKind =
  | 'spawn'
  | 'progress'
  | 'done'
  | 'error'
  | 'verify_hint';

export interface KrakenRadioEvent {
  ts: string;
  kind: KrakenRadioKind;
  agent: string;
  thoroughness?: string;
  description: string;
  /** Short summary / result excerpt */
  detail?: string;
  model?: string;
  worktree?: string | null;
  durationMs?: number;
  ok?: boolean;
}

function radioDir(cwd: string): string {
  return path.join(cwd, '.zelari', 'radio');
}

function radioPath(cwd: string, sessionId: string): string {
  const safe = (sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return path.join(radioDir(cwd), `${safe}.jsonl`);
}

/** Append one radio event (best-effort, sync — sub-agent exit path). */
export function appendKrakenRadio(
  cwd: string,
  sessionId: string,
  event: Omit<KrakenRadioEvent, 'ts'> & { ts?: string },
): void {
  try {
    const dir = radioDir(cwd);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const row: KrakenRadioEvent = {
      ts: event.ts ?? new Date().toISOString(),
      kind: event.kind,
      agent: event.agent,
      description: event.description,
      ...(event.thoroughness !== undefined ? { thoroughness: event.thoroughness } : {}),
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      ...(event.model !== undefined ? { model: event.model } : {}),
      ...(event.worktree !== undefined ? { worktree: event.worktree } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.ok !== undefined ? { ok: event.ok } : {}),
    };
    appendFileSync(radioPath(cwd, sessionId), `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // never break the agent loop for telemetry
  }
}

/** Read recent radio events (newest last). */
export function readKrakenRadio(
  cwd: string,
  sessionId: string,
  limit = 50,
): KrakenRadioEvent[] {
  try {
    const file = radioPath(cwd, sessionId);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const slice = lines.slice(-Math.max(1, limit));
    const out: KrakenRadioEvent[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as KrakenRadioEvent);
      } catch {
        // skip bad lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** List session radio files under .zelari/radio. */
export function listKrakenRadioSessions(cwd: string): string[] {
  try {
    const dir = radioDir(cwd);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''));
  } catch {
    return [];
  }
}

/** Human-readable status block for slash / doctor. */
export function formatKrakenRadioStatus(
  cwd: string,
  sessionId: string,
  limit = 12,
): string {
  const events = readKrakenRadio(cwd, sessionId, limit);
  if (events.length === 0) {
    return `Kraken radio: no events yet for session "${sessionId}" (path .zelari/radio/).`;
  }
  const lines = events.map((e) => {
    const flag = e.ok === false ? '✗' : e.ok === true ? '✓' : '·';
    const ms = e.durationMs != null ? ` ${e.durationMs}ms` : '';
    const model = e.model ? ` [${e.model}]` : '';
    const wt = e.worktree ? ` wt=${path.basename(e.worktree)}` : '';
    const detail = e.detail ? ` — ${e.detail.slice(0, 120)}` : '';
    return `${flag} ${e.ts.slice(11, 19)} ${e.kind} ${e.agent} "${e.description}"${model}${wt}${ms}${detail}`;
  });
  return [`Kraken radio (last ${events.length}) session=${sessionId}:`, ...lines].join('\n');
}
