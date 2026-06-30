/**
 * sessionManager — CLI session lifecycle helpers.
 *
 * Wraps the JSONL sidecar writer (`electron/main/core/sessionJsonl.ts`) with
 * filesystem helpers for the CLI:
 *
 *   - resolve base directory (`~/.tmp/anathema-coder/sessions/`, overridable
 *     via `ANATHEMA_SESSIONS_DIR`)
 *   - track the "current" session via a small text file (`current.txt`,
 *     overridable via `ANATHEMA_CURRENT_SESSION_FILE`)
 *   - list past sessions sorted by mtime desc
 *   - load a session's events from JSONL
 *
 * Pure node:fs — no Electron deps, browser-importable for jsdom tests.
 *
 * @see docs/plans/2026-06-28-zelari-code.md (Task 14.10)
 */

import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BrainEvent } from '../shared/events.js';
import { readSession } from '../main/core/sessionJsonl.js';

export interface SessionInfo {
  /** Session UUID. */
  id: string;
  /** Number of events in the JSONL file. */
  eventCount: number;
  /** First event timestamp (epoch ms), or 0 if empty. */
  firstTs: number;
  /** Last event timestamp (epoch ms), or 0 if empty. */
  lastTs: number;
  /** File modification time (epoch ms). */
  mtimeMs: number;
  /** Absolute path to the session JSONL file. */
  filePath: string;
}

/** Resolve the base directory where session JSONL files live. */
export function getSessionBaseDir(): string {
  return process.env.ANATHEMA_SESSIONS_DIR
    ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'sessions');
}

/** Resolve the file used to track the current session id. */
export function getCurrentSessionFile(): string {
  return process.env.ANATHEMA_CURRENT_SESSION_FILE
    ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'current.txt');
}

/** Ensure the base directory exists. Creates parent dirs as needed. */
export async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(getSessionBaseDir(), { recursive: true });
}

/** Read the current session id from disk. Returns null if missing/empty. */
export function getCurrentSessionId(): string | null {
  const file = getCurrentSessionFile();
  if (!existsSync(file)) return null;
  try {
    const content = readFileSync(file, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/** Write the current session id to disk. Creates parent dirs as needed. */
export function setCurrentSessionId(id: string): void {
  const file = getCurrentSessionFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, id, 'utf-8');
}

/** Remove the current session marker (does not delete the JSONL file). */
export function clearCurrentSessionId(): void {
  const file = getCurrentSessionFile();
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** File used to track the currently active branch (Task 17.2). */
export function getCurrentBranchFile(): string {
  return process.env.ANATHEMA_CURRENT_BRANCH_FILE
    ?? path.join(path.dirname(getCurrentSessionFile()), 'currentBranch.txt');
}

/** Read the current branch name. Returns null if no branch is active. */
export function getCurrentBranch(): string | null {
  const file = getCurrentBranchFile();
  if (!existsSync(file)) return null;
  try {
    const content = readFileSync(file, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/** Set the current branch name (used after `/checkout <name>`). */
export function setCurrentBranch(name: string): void {
  const file = getCurrentBranchFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, name, 'utf-8');
}

/** Clear the current branch marker (used after `/branch <name>` on main). */
export function clearCurrentBranch(): void {
  const file = getCurrentBranchFile();
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Generate a new session UUID. */
export function newSessionId(): string {
  return randomUUID();
}

/** List all sessions in the base directory, sorted by mtime desc. */
export async function listSessions(): Promise<SessionInfo[]> {
  const baseDir = getSessionBaseDir();
  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const results: SessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const id = entry.replace(/\.jsonl$/, '');
    const filePath = path.join(baseDir, entry);
    try {
      const events = await readSession(filePath);
      let firstTs = 0;
      let lastTs = 0;
      for (const e of events) {
        if (firstTs === 0 || e.ts < firstTs) firstTs = e.ts;
        if (e.ts > lastTs) lastTs = e.ts;
      }
      const mtimeMs = statSync(filePath).mtimeMs;
      results.push({ id, eventCount: events.length, firstTs, lastTs, mtimeMs, filePath });
    } catch {
      // Skip unreadable sessions.
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

/** Load all events from a session's JSONL file by id. */
export async function loadSessionEvents(id: string): Promise<BrainEvent[]> {
  const filePath = path.join(getSessionBaseDir(), `${id}.jsonl`);
  return readSession(filePath);
}