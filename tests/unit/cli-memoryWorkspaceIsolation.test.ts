/**
 * cli-memoryWorkspaceIsolation.test.ts — `memory.db` is PER WORKSPACE.
 *
 * Reported symptom: every Desktop conversation (and every opened folder) read
 * and wrote ONE `.zelari/memory/memory.db`, because the memory service was
 * initialized from the sidecar's process.cwd() (the app install dir) instead
 * of the session workspaceRoot threaded as `opts.cwd`. Recall/write
 * cross-contamination follows directly from that shared file.
 *
 * The path resolution is `sqliteBackend.init(projectRoot)` — the contract is
 * `<projectRoot>/.zelari/memory/memory.db`, realpath-canonical, and refused
 * whenever it would escape the project. These tests pin that contract for two
 * distinct workspaces plus the absence of any cwd()-derived fallback.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteMemoryBackend } from '../../src/cli/memory/sqliteBackend.js';
import { canonicalProjectId, getMemoryService } from '../../src/cli/memory/serviceFactory.js';

const roots: string[] = [];

async function workspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** The canonical workspace path the backend stores (realpath, no trailing sep). */
async function canonical(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    return path.resolve(root);
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('memory.db resolution is workspace-scoped', () => {
  it('opens one database per workspace root — never a shared or cwd-derived file', async () => {
    const a = await workspace('zelari-mem-ws-a-');
    const b = await workspace('zelari-mem-ws-b-');
    const backendA = new SQLiteMemoryBackend();
    const backendB = new SQLiteMemoryBackend();
    try {
      await backendA.init(a);
      await backendB.init(b);

      expect(backendA.databasePath).toBe(path.join(await canonical(a), '.zelari', 'memory', 'memory.db'));
      expect(backendB.databasePath).toBe(path.join(await canonical(b), '.zelari', 'memory', 'memory.db'));
      expect(backendA.databasePath).not.toBe(backendB.databasePath);
      // The 2.16.0/2.38 leak shape: a cwd()-derived store shared by all chats.
      expect(backendA.databasePath).not.toBe(
        path.join(await canonical(process.cwd()), '.zelari', 'memory', 'memory.db'),
      );
      expect(backendB.databasePath).not.toBe(
        path.join(await canonical(process.cwd()), '.zelari', 'memory', 'memory.db'),
      );
    } finally {
      await backendA.close();
      await backendB.close();
    }
  });

  it('keeps a memory written in workspace A invisible from workspace B', async () => {
    const a = await workspace('zelari-mem-iso-a-');
    const b = await workspace('zelari-mem-iso-b-');
    const env = { ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv;
    const serviceA = await getMemoryService(a, env, { force: true });
    const serviceB = await getMemoryService(b, env, { force: true });
    try {
      expect(serviceA.projectId).not.toBe(serviceB.projectId);
      await serviceA.remember({
        kind: 'decision',
        content: 'Workspace A only: bounded native recall per workspace.',
        source: { agent: 'test' },
      });
      expect((await serviceA.recall({ text: 'bounded native recall' })).length).toBeGreaterThan(0);
      // B shares nothing: same query, empty store, different project id.
      expect((await serviceB.recall({ text: 'bounded native recall' })).length).toBe(0);
      expect((await serviceB.stats()).nodes).toBe(0);
    } finally {
      await serviceA.close().catch(() => undefined);
      await serviceB.close().catch(() => undefined);
    }
  });

  it('derives a distinct project id per workspace root', async () => {
    const a = await workspace('zelari-mem-id-a-');
    const b = await workspace('zelari-mem-id-b-');
    expect(await canonicalProjectId(a)).not.toBe(await canonicalProjectId(b));
    // Stable across calls for the SAME root (no clock/random in the id).
    expect(await canonicalProjectId(a)).toBe(await canonicalProjectId(a));
  });
});
