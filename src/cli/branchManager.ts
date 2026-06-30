/**
 * branchManager — snapshot-based session branching (Tau pattern).
 *
 * Branches are independent snapshots of a session stored under
 * `~/.tmp/anathema-coder/branches/<name>/`. No Git-style merging, no
 * conflict resolution — just file copies. Each branch has its own JSONL
 * session files and a meta.json describing when it was branched.
 *
 * Storage layout:
 *   ~/.tmp/anathema-coder/
 *     sessions/<id>.jsonl         ← main sessions (managed by sessionManager)
 *     branches/
 *       <name>/
 *         meta.json                ← { createdAt, fromSessionId }
 *         sessions/<id>.jsonl      ← branch sessions
 *
 * Pure node:fs — no Electron deps, browser-importable for jsdom tests.
 * Env override: ANATHEMA_BRANCHES_DIR.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v2.md (Task 17.1)
 */

import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface BranchInfo {
  /** Branch name (filesystem-safe identifier). */
  name: string;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Session id the branch was created from. */
  fromSessionId: string;
  /** Number of session files in this branch. */
  sessionCount: number;
  /** Absolute path to the branch directory. */
  branchPath: string;
}

interface BranchMeta {
  name: string;
  createdAt: number;
  fromSessionId: string;
}

const META_FILENAME = 'meta.json';
const SESSIONS_SUBDIR = 'sessions';

export function getBranchesBaseDir(): string {
  return process.env.ANATHEMA_BRANCHES_DIR
    ?? path.join(os.homedir(), '.tmp', 'anathema-coder', 'branches');
}

export function getSessionsBaseDir(): string {
  return process.env.ANATHEMA_SESSIONS_DIR
    ?? path.join(os.homedir(), '.tmp', 'anathema-coder', 'sessions');
}

function branchPathFor(name: string, baseDir: string): string {
  return path.join(baseDir, name);
}

function metaPathFor(name: string, baseDir: string): string {
  return path.join(baseDir, name, META_FILENAME);
}

function sessionsPathFor(name: string, baseDir: string): string {
  return path.join(baseDir, name, SESSIONS_SUBDIR);
}

function readBranchMeta(name: string, baseDir: string): BranchMeta {
  const metaPath = metaPathFor(name, baseDir);
  if (!existsSync(metaPath)) {
    throw new BranchNotFoundError(`Branch "${name}" not found`);
  }
  try {
    const raw = readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BranchMeta>;
    if (!parsed || typeof parsed !== 'object'
      || typeof parsed.name !== 'string'
      || typeof parsed.createdAt !== 'number'
      || typeof parsed.fromSessionId !== 'string') {
      throw new BranchCorruptError(`Branch "${name}" meta.json is malformed`);
    }
    return {
      name: parsed.name,
      createdAt: parsed.createdAt,
      fromSessionId: parsed.fromSessionId,
    };
  } catch (err) {
    if (err instanceof BranchCorruptError) throw err;
    throw new BranchCorruptError(`Failed to read branch "${name}" meta: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeBranchMeta(name: string, baseDir: string, meta: BranchMeta): void {
  const metaPath = metaPathFor(name, baseDir);
  mkdirSync(path.dirname(metaPath), { recursive: true });
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

/** Count session files in a branch's sessions/ subdir (async). */
async function countSessions(name: string, baseDir: string): Promise<number> {
  const sessionsPath = sessionsPathFor(name, baseDir);
  try {
    const entries = await fs.readdir(sessionsPath);
    return entries.filter((e) => e.endsWith('.jsonl')).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

export class BranchAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`Branch "${name}" already exists`);
    this.name = 'BranchAlreadyExistsError';
  }
}

export class BranchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BranchNotFoundError';
  }
}

export class BranchCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BranchCorruptError';
  }
}

export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Check if a branch exists (sync, for callers that don't need async I/O).
 */
export function branchExists(name: string, baseDir: string = getBranchesBaseDir()): boolean {
  const bp = branchPathFor(name, baseDir);
  return existsSync(bp) && existsSync(metaPathFor(name, baseDir));
}

/**
 * Create a new branch by snapshotting the source session's JSONL file.
 *
 * Steps:
 *   1. Verify branch name doesn't already exist
 *   2. Verify source session JSONL exists
 *   3. Copy the JSONL file to branches/<name>/sessions/<id>.jsonl
 *   4. Write branches/<name>/meta.json
 *
 * @returns BranchInfo for the newly created branch.
 */
export async function createBranch(
  name: string,
  fromSessionId: string,
  baseDir: string = getBranchesBaseDir(),
  sessionsBaseDir: string = getSessionsBaseDir(),
): Promise<BranchInfo> {
  if (!name || name.trim().length === 0) {
    throw new Error('Branch name cannot be empty');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid branch name: "${name}" (no path separators or "..")`);
  }
  if (branchExists(name, baseDir)) {
    throw new BranchAlreadyExistsError(name);
  }
  const sourcePath = path.join(sessionsBaseDir, `${fromSessionId}.jsonl`);
  if (!existsSync(sourcePath)) {
    throw new SessionNotFoundError(`Source session "${fromSessionId}" not found at ${sourcePath}`);
  }

  const branchPath = branchPathFor(name, baseDir);
  const branchSessionsPath = sessionsPathFor(name, baseDir);
  mkdirSync(branchSessionsPath, { recursive: true });

  const destPath = path.join(branchSessionsPath, `${fromSessionId}.jsonl`);
  await fs.copyFile(sourcePath, destPath);

  const meta: BranchMeta = {
    name,
    createdAt: Date.now(),
    fromSessionId,
  };
  writeBranchMeta(name, baseDir, meta);

  return {
    name,
    createdAt: meta.createdAt,
    fromSessionId: meta.fromSessionId,
    sessionCount: 1,
    branchPath,
  };
}

/**
 * List all branches, sorted by createdAt desc (most recent first).
 */
export async function listBranches(baseDir: string = getBranchesBaseDir()): Promise<BranchInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const results: BranchInfo[] = [];
  for (const entry of entries) {
    const metaPath = metaPathFor(entry, baseDir);
    if (!existsSync(metaPath)) continue; // not a branch
    try {
      const meta = readBranchMeta(entry, baseDir);
      const sessionCount = await countSessions(entry, baseDir);
      results.push({
        name: meta.name,
        createdAt: meta.createdAt,
        fromSessionId: meta.fromSessionId,
        sessionCount,
        branchPath: branchPathFor(entry, baseDir),
      });
    } catch {
      // Skip corrupt branches but don't fail the whole list.
    }
  }
  results.sort((a, b) => b.createdAt - a.createdAt);
  return results;
}

/**
 * Get info for a specific branch. Throws BranchNotFoundError if missing.
 */
export async function getBranchInfo(
  name: string,
  baseDir: string = getBranchesBaseDir(),
): Promise<BranchInfo> {
  if (!branchExists(name, baseDir)) {
    throw new BranchNotFoundError(`Branch "${name}" not found`);
  }
  const meta = readBranchMeta(name, baseDir);
  return {
    name: meta.name,
    createdAt: meta.createdAt,
    fromSessionId: meta.fromSessionId,
    sessionCount: await countSessions(name, baseDir),
    branchPath: branchPathFor(name, baseDir),
  };
}

/**
 * "Checkout" a branch — returns the branch info. The actual session
 * switching is the caller's responsibility (e.g. set current.txt or
 * sessionManager integration).
 */
export async function checkoutBranch(
  name: string,
  baseDir: string = getBranchesBaseDir(),
): Promise<BranchInfo> {
  return getBranchInfo(name, baseDir);
}

/**
 * Delete a branch and all its session files. Idempotent on missing branches.
 */
export async function deleteBranch(
  name: string,
  baseDir: string = getBranchesBaseDir(),
): Promise<void> {
  if (!branchExists(name, baseDir)) return;
  rmSync(branchPathFor(name, baseDir), { recursive: true, force: true });
}

/**
 * Add a session to an existing branch (used when continuing a branch
 * session — the JSONL writer should append events to the branch copy).
 *
 * Returns the destination path inside the branch.
 */
export async function getBranchSessionPath(
  branchName: string,
  sessionId: string,
  baseDir: string = getBranchesBaseDir(),
): Promise<string> {
  if (!branchExists(branchName, baseDir)) {
    throw new BranchNotFoundError(`Branch "${branchName}" not found`);
  }
  const sessionsPath = sessionsPathFor(branchName, baseDir);
  mkdirSync(sessionsPath, { recursive: true });
  return path.join(sessionsPath, `${sessionId}.jsonl`);
}

/** Sync helper: get branch dir (for callers that need immediate path access). */
export function getBranchDir(name: string, baseDir: string = getBranchesBaseDir()): string {
  return branchPathFor(name, baseDir);
}

/** Sync helper: stat a branch directory (for lastModified display). */
export function getBranchMtimeMs(name: string, baseDir: string = getBranchesBaseDir()): number {
  const bp = branchPathFor(name, baseDir);
  if (!existsSync(bp)) return 0;
  try {
    return statSync(bp).mtimeMs;
  } catch {
    return 0;
  }
}
/**
 * Current-branch helpers (stubs).
 *
 * These were referenced from app.tsx but never implemented in v3-L.
 * The CLI doesn't actually persist a "current branch" between sessions
 * (it's a workspace-level concept handled by the store). Provided here
 * so the bundler + tsc emit succeed. Returning null/empty is safe.
 *
 * @see docs/anathema-coder-mission-status.md for the v3-L deferred items.
 */
export function getCurrentBranch(_baseDir?: string): string | null {
  return null;
}

export function setCurrentBranch(_name: string, _baseDir?: string): void {
  // no-op stub — see comment above
}

export function clearCurrentBranch(_baseDir?: string): void {
  // no-op stub — see comment above
}
