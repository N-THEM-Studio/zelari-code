import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createBranch,
  listBranches,
  branchExists,
  checkoutBranch,
  deleteBranch,
  getBranchInfo,
  getBranchSessionPath,
  BranchAlreadyExistsError,
  BranchNotFoundError,
  SessionNotFoundError,
} from '../../src/cli/branchManager.js';
import { SessionJsonlWriter } from '@zelari/core/harness';
import { createBrainEvent } from '@zelari/core/events';

describe('branchManager (Task 17.1)', () => {
  let branchesDir: string;
  let sessionsDir: string;
  let savedBranchEnv: string | undefined;
  let savedSessionsEnv: string | undefined;

  beforeEach(async () => {
    const base = path.join(
      os.tmpdir(),
      `anathema-bm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    branchesDir = path.join(base, 'branches');
    sessionsDir = path.join(base, 'sessions');
    await fs.mkdir(branchesDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    savedBranchEnv = process.env.ANATHEMA_BRANCHES_DIR;
    savedSessionsEnv = process.env.ANATHEMA_SESSIONS_DIR;
    process.env.ANATHEMA_BRANCHES_DIR = branchesDir;
    process.env.ANATHEMA_SESSIONS_DIR = sessionsDir;
  });

  afterEach(async () => {
    if (savedBranchEnv === undefined) delete process.env.ANATHEMA_BRANCHES_DIR;
    else process.env.ANATHEMA_BRANCHES_DIR = savedBranchEnv;
    if (savedSessionsEnv === undefined) delete process.env.ANATHEMA_SESSIONS_DIR;
    else process.env.ANATHEMA_SESSIONS_DIR = savedSessionsEnv;
    await fs.rm(path.dirname(branchesDir), { recursive: true, force: true });
  });

  async function seedSession(sessionId: string): Promise<string> {
    const writer = new SessionJsonlWriter(sessionId, { baseDir: sessionsDir });
    await writer.append(createBrainEvent('agent_start', sessionId, { model: 'test', provider: 'test' }));
    return path.join(sessionsDir, `${sessionId}.jsonl`);
  }

  it('createBranch + listBranches round-trip', async () => {
    await seedSession('sess-1');
    const branch = await createBranch('experiment-x', 'sess-1');
    expect(branch.name).toBe('experiment-x');
    expect(branch.fromSessionId).toBe('sess-1');
    expect(branch.sessionCount).toBe(1);
    expect(branch.createdAt).toBeGreaterThan(0);

    const list = await listBranches();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('experiment-x');
    expect(list[0].fromSessionId).toBe('sess-1');
  });

  it('createBranch throws BranchAlreadyExistsError on duplicate name', async () => {
    await seedSession('sess-2');
    await createBranch('dup', 'sess-2');
    await expect(createBranch('dup', 'sess-2')).rejects.toBeInstanceOf(BranchAlreadyExistsError);
  });

  it('createBranch throws SessionNotFoundError on missing source session', async () => {
    await expect(createBranch('no-src', 'nonexistent-session')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('createBranch throws on invalid branch name (path traversal)', async () => {
    await seedSession('sess-3');
    await expect(createBranch('../escape', 'sess-3')).rejects.toThrow(/Invalid branch name/);
    await expect(createBranch('with/slash', 'sess-3')).rejects.toThrow(/Invalid branch name/);
    await expect(createBranch('', 'sess-3')).rejects.toThrow(/cannot be empty/);
  });

  it('listBranches returns [] when no branches exist', async () => {
    const list = await listBranches();
    expect(list).toEqual([]);
  });

  it('listBranches sorted by createdAt desc (most recent first)', async () => {
    await seedSession('sess-A');
    await createBranch('older', 'sess-A');
    await new Promise((r) => setTimeout(r, 30)); // ensure different createdAt
    await seedSession('sess-B');
    await createBranch('newer', 'sess-B');

    const list = await listBranches();
    expect(list.map((b) => b.name)).toEqual(['newer', 'older']);
  });

  it('branchExists returns true after creation, false before', async () => {
    expect(branchExists('not-yet')).toBe(false);
    await seedSession('sess-exists');
    await createBranch('not-yet', 'sess-exists');
    expect(branchExists('not-yet')).toBe(true);
  });

  it('checkoutBranch throws BranchNotFoundError for missing branch', async () => {
    await expect(checkoutBranch('never-existed')).rejects.toBeInstanceOf(BranchNotFoundError);
  });

  it('checkoutBranch returns BranchInfo for existing branch', async () => {
    await seedSession('sess-co');
    await createBranch('co-test', 'sess-co');
    const info = await checkoutBranch('co-test');
    expect(info.name).toBe('co-test');
    expect(info.fromSessionId).toBe('sess-co');
  });

  it('getBranchInfo throws BranchNotFoundError for missing', async () => {
    await expect(getBranchInfo('missing')).rejects.toBeInstanceOf(BranchNotFoundError);
  });

  it('getBranchSessionPath returns path inside branch', async () => {
    await seedSession('sess-p');
    await createBranch('path-test', 'sess-p');
    const branchSessionPath = await getBranchSessionPath('path-test', 'new-session-id');
    expect(branchSessionPath).toContain(path.join('path-test', 'sessions', 'new-session-id.jsonl'));
  });

  it('getBranchSessionPath throws BranchNotFoundError for missing branch', async () => {
    await expect(getBranchSessionPath('missing-branch', 's')).rejects.toBeInstanceOf(BranchNotFoundError);
  });

  it('deleteBranch removes branch directory', async () => {
    await seedSession('sess-del');
    await createBranch('to-delete', 'sess-del');
    expect(branchExists('to-delete')).toBe(true);
    await deleteBranch('to-delete');
    expect(branchExists('to-delete')).toBe(false);
    // Idempotent: deleting again is a no-op.
    await expect(deleteBranch('to-delete')).resolves.toBeUndefined();
  });

  it('createBranch copies the source JSONL verbatim', async () => {
    const sourcePath = await seedSession('sess-copy');
    await createBranch('copy-test', 'sess-copy');
    const branchSessionPath = path.join(branchesDir, 'copy-test', 'sessions', 'sess-copy.jsonl');
    const source = await fs.readFile(sourcePath, 'utf-8');
    const copied = await fs.readFile(branchSessionPath, 'utf-8');
    expect(copied).toBe(source);
  });
});