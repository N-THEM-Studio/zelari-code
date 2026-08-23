import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DefaultMemoryService, MemoryPolicyError } from '@zelari/core/memory';
import { SQLiteMemoryBackend } from '../../src/cli/memory/sqliteBackend.js';
import {
  canonicalProjectId,
  getMemoryService,
  isMemoryAutoWriteEnabled,
  isMemoryV2Enabled,
} from '../../src/cli/memory/serviceFactory.js';

const dirs: string[] = [];
async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-v2-'));
  dirs.push(root);
  return root;
}

afterEach(async () => {
  for (const root of dirs.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function service(root: string): Promise<{ backend: SQLiteMemoryBackend; memory: DefaultMemoryService }> {
  const backend = new SQLiteMemoryBackend();
  await backend.init(root);
  const memory = new DefaultMemoryService(await canonicalProjectId(root), backend);
  return { backend, memory };
}

describe('SQLite cognitive memory', () => {
  it('persists typed memories and recalls them after restart', async () => {
    const root = await project();
    const first = await service(root);
    const stored = await first.memory.remember({
      kind: 'decision',
      content: 'Use SQLite WAL for shared project memory.',
      importance: 0.9,
      confidence: 0.95,
      source: { agent: 'council', sessionId: 'session-a' },
      tags: ['architecture', 'sqlite'],
      writeClass: 'auto',
    });
    await first.memory.close();

    const second = await service(root);
    const hits = await second.memory.recall({ text: 'sqlite shared memory', limit: 5 });
    expect(hits[0]?.node.id).toBe(stored.id);
    expect(hits[0]?.node.source.sessionId).toBe('session-a');
    expect((await second.memory.stats()).backend).toBe('sqlite');
    await second.memory.close();
  });

  it('preserves versions and reconstructs state before retraction', async () => {
    const root = await project();
    const { memory } = await service(root);
    const stored = await memory.remember({
      kind: 'fact', content: 'The build command is npm run build.',
      source: { agent: 'source-inspector' }, writeClass: 'auto',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const beforeRetraction = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await memory.retract(stored.id, 'package scripts changed');
    const current = await memory.get(stored.id);
    expect(current?.status).toBe('retracted');
    expect((await memory.history(stored.id)).length).toBe(2);
    expect((await memory.getAt(stored.id, beforeRetraction))?.status).toBe('active');
    expect((await memory.recall({ text: 'build command', asOf: beforeRetraction }))[0]?.node.status)
      .toBe('active');
    expect(await memory.recall({ text: 'build command' })).toEqual([]);
    await memory.close();
  });

  it('creates typed edges and supersedes obsolete knowledge without losing history', async () => {
    const root = await project();
    const { memory } = await service(root);
    const old = await memory.remember({
      kind: 'decision', content: 'Use the JSONL backend by default.',
      source: { agent: 'council' }, writeClass: 'auto',
    });
    const current = await memory.remember({
      kind: 'decision', content: 'Use SQLite as the native memory V2 backend.',
      source: { agent: 'council', verificationId: 'v-2' }, writeClass: 'auto',
    });
    await memory.connect({ from: current.id, to: old.id, relation: 'supersedes' });
    expect((await memory.get(old.id))?.status).toBe('superseded');
    expect((await memory.related(current.id))[0]?.node.id).toBe(old.id);
    expect((await memory.history(old.id)).length).toBe(2);
    const hits = await memory.recall({ text: 'backend default native memory', limit: 10 });
    expect(hits.some((hit) => hit.node.id === old.id)).toBe(false);
    await memory.close();
  });

  it('redacts secrets before persistence and rejects private keys', async () => {
    const root = await project();
    const { memory } = await service(root);
    const node = await memory.remember({
      kind: 'failure',
      content: 'Request failed with api_key=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      source: { agent: 'test' },
      metadata: { password: 'super-secret-password', nested: { token: 'xoxb-12345678901234567890' } },
    });
    expect(node.content).toContain('[REDACTED]');
    expect(node.metadata.password).toBe('[REDACTED]');
    expect(JSON.stringify(node.metadata)).not.toContain('xoxb-');
    const evidence = await memory.remember({
      kind: 'verification', content: 'The sanitized memory policy test passed.',
      source: { agent: 'test' },
    });
    const edge = await memory.connect({
      from: node.id,
      to: evidence.id,
      relation: 'validated_by',
      metadata: { access_token: 'xoxb-12345678901234567890' },
    });
    expect(JSON.stringify(edge.metadata)).not.toContain('xoxb-');
    await expect(memory.remember({
      kind: 'fact', content: '-----BEGIN PRIVATE KEY-----\nabc', source: { agent: 'test' },
    })).rejects.toBeInstanceOf(MemoryPolicyError);
    await expect(memory.remember({
      projectId: 'project_spoofed', kind: 'fact', content: 'Cross-project write.',
      source: { agent: 'test' },
    })).rejects.toBeInstanceOf(MemoryPolicyError);
    await memory.close();
  });

  it('deduplicates exact content and versions stronger evidence', async () => {
    const root = await project();
    const { memory } = await service(root);
    const first = await memory.remember({
      kind: 'constraint', content: 'Never downgrade a newer memory schema.',
      confidence: 0.6, source: { agent: 'tentacle-a' }, writeClass: 'candidate',
    });
    const second = await memory.remember({
      kind: 'constraint', content: '  Never downgrade a newer memory schema.  ',
      confidence: 0.95, source: { agent: 'verifier', verificationId: 'verify-1' },
      tags: ['verified'], writeClass: 'auto',
    });
    expect(second.id).toBe(first.id);
    expect(second.confidence).toBe(0.95);
    expect((await memory.history(first.id))).toHaveLength(2);
    expect((await memory.stats()).nodes).toBe(1);
    await memory.close();
  });

  it('supports concurrent writers through WAL and a busy timeout', async () => {
    const root = await project();
    const [a, b] = await Promise.all([service(root), service(root)]);
    await Promise.all(Array.from({ length: 30 }, (_, index) =>
      (index % 2 ? a.memory : b.memory).remember({
        kind: 'finding', content: `Concurrent unique finding number ${index}`,
        source: { agent: index % 2 ? 'tentacle-a' : 'tentacle-b' },
        writeClass: 'candidate',
      }),
    ));
    expect((await a.memory.stats()).nodes).toBe(30);
    await Promise.all([a.memory.close(), b.memory.close()]);
  });

  it('imports legacy JSONL idempotently without deleting the source', async () => {
    const root = await project();
    const memoryDir = path.join(root, '.zelari', 'memory');
    await fs.mkdir(memoryDir, { recursive: true });
    const logPath = path.join(memoryDir, 'log.jsonl');
    await fs.writeFile(logPath, JSON.stringify({
      id: 'legacy-1', content: 'Legacy mission chose deterministic verification.',
      metadata: { source: 'council', memoryKind: 'decision' },
      createdAt: '2026-08-01T00:00:00.000Z',
    }) + '\n', 'utf8');
    const env = { ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv;
    const first = await getMemoryService(root, env);
    const imported = await first.recall({ text: 'deterministic verification' });
    expect(imported).toHaveLength(1);
    expect(imported[0]?.node.createdAt).toBe('2026-08-01T00:00:00.000Z');
    await first.close();
    const second = await getMemoryService(root, env);
    expect((await second.stats()).nodes).toBe(1);
    expect(await fs.readFile(logPath, 'utf8')).toContain('legacy-1');
    await second.close();
  });

  it('enforces a hard context budget and reports database health', async () => {
    const root = await project();
    const { memory } = await service(root);
    const subjects = ['authentication', 'database', 'compiler', 'desktop', 'network', 'sessions', 'permissions', 'verification'];
    for (let index = 0; index < subjects.length; index++) {
      await memory.remember({
        kind: 'finding', content: `Budgeted context finding ${index} concerns ${subjects[index]} ${(`${subjects[index]} detail `).repeat(30)}`,
        source: { agent: `tentacle-${index}` }, writeClass: 'candidate',
      });
    }
    const context = await memory.buildContext({ text: 'budgeted context finding', maxChars: 500 });
    expect(context.usedChars).toBeLessThanOrEqual(500);
    expect(context.truncated).toBe(true);
    const doctor = await memory.doctor();
    expect(doctor.ok).toBe(true);
    expect(doctor.checks.find((check) => check.name === 'integrity')?.ok).toBe(true);
    await memory.close();
  });

  it('consolidates repeated candidates while retaining derived provenance', async () => {
    const root = await project();
    const { memory } = await service(root);
    const first = await memory.remember({
      kind: 'finding',
      content: 'Provider X requires organization header for workspace requests.',
      source: { agent: 'tentacle-a' },
      writeClass: 'candidate',
    });
    const second = await memory.remember({
      kind: 'finding',
      content: 'Provider X requires organization header for all workspace requests.',
      source: { agent: 'tentacle-b' },
      writeClass: 'candidate',
    });
    const consolidated = await memory.consolidate({
      memoryIds: [first.id, second.id],
      source: { agent: 'test-consolidator' },
    });
    expect(consolidated.created).toHaveLength(1);
    expect(consolidated.created[0]?.kind).toBe('fact');
    expect(consolidated.archivedSourceIds).toHaveLength(1);
    const related = await memory.related(consolidated.created[0]!.id, {
      relations: ['derived_from'],
    });
    expect(related).toHaveLength(1);
    expect((await memory.history(related[0]!.node.id)).at(-1)?.snapshot.status).toBe('archived');
    await memory.close();
  });

  it('refuses a newer schema without downgrading it or leaking the worker', async () => {
    const root = await project();
    const seeded = await service(root);
    const databasePath = seeded.backend.databasePath;
    await seeded.memory.close();
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA user_version = 99');
    database.close();

    const future = new SQLiteMemoryBackend();
    await expect(future.init(root)).rejects.toThrow(/newer than runtime/i);
    await future.close();
    const unchanged = new DatabaseSync(databasePath);
    const version = unchanged.prepare('PRAGMA user_version').get() as { user_version: number };
    unchanged.close();
    expect(version.user_version).toBe(99);
  });

  it('keeps V2 opt-in and honors explicit disable/auto-write flags', () => {
    expect(isMemoryV2Enabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isMemoryV2Enabled({ ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isMemoryV2Enabled({
      ZELARI_MEMORY_V2: '1', ZELARI_MEMORY_BACKEND: 'file',
    } as NodeJS.ProcessEnv)).toBe(false);
    expect(isMemoryV2Enabled({
      ZELARI_MEMORY: '0', ZELARI_MEMORY_BACKEND: 'sqlite',
    } as NodeJS.ProcessEnv)).toBe(false);
    expect(isMemoryAutoWriteEnabled({
      ZELARI_MEMORY_V2: '1', ZELARI_MEMORY_AUTO_WRITE: '0',
    } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('preserves a corrupt database and degrades to a warning', async () => {
    const root = await project();
    const directory = path.join(root, '.zelari', 'memory');
    const databasePath = path.join(directory, 'memory.db');
    await fs.mkdir(directory, { recursive: true });
    const corrupt = Buffer.from('not-a-sqlite-database');
    await fs.writeFile(databasePath, corrupt);
    const warnings: string[] = [];
    const memory = await getMemoryService(
      root,
      { ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv,
      { onWarning: (warning) => warnings.push(warning) },
    );
    expect((await memory.stats()).backend).toBe('unavailable');
    expect((await memory.doctor()).ok).toBe(false);
    expect(warnings.join('\n')).toMatch(/SQLite unavailable/i);
    await memory.close();
    expect(await fs.readFile(databasePath)).toEqual(corrupt);
  });

  it('rejects a symlinked memory directory outside the project boundary', async () => {
    const root = await project();
    const outside = await project();
    const link = path.join(root, '.zelari');
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    const backend = new SQLiteMemoryBackend();
    await expect(backend.init(root)).rejects.toThrow(/not a real directory/i);
    await backend.close();
    await expect(fs.stat(path.join(outside, 'memory', 'memory.db'))).rejects.toThrow();
  });
});
