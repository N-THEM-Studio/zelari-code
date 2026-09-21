import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultMemoryService } from '@zelari/core/memory';
import { SQLiteMemoryBackend } from '../../src/cli/memory/sqliteBackend.js';
import {
  canonicalProjectId,
  getMemoryService,
  isMemoryTriggersEnabled,
} from '../../src/cli/memory/serviceFactory.js';

// node:sqlite ships with Node >= 22.5 (still experimental). Import it lazily so
// this suite skips gracefully on the Node 20 floor instead of failing at load.
const nodeSqlite = (await import('node:sqlite').catch(() => null)) as typeof import('node:sqlite') | null;

const roots: string[] = [];
async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-triggers-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function open(root: string, relevantWhen?: boolean) {
  const backend = new SQLiteMemoryBackend();
  await backend.init(root);
  const projectId = await canonicalProjectId(root);
  const memory = new DefaultMemoryService(projectId, backend, { relevantWhen });
  return { backend, memory, projectId };
}

const V2_SCHEMA = `
  PRAGMA foreign_keys=ON;
  CREATE TABLE memory_nodes (
    id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, project_id TEXT NOT NULL,
    kind TEXT NOT NULL, content TEXT NOT NULL, importance REAL NOT NULL,
    confidence REAL NOT NULL, status TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'project',
    tags_json TEXT NOT NULL, source_json TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, valid_from TEXT, valid_until TEXT, recorded_at TEXT NOT NULL,
    retracted_at TEXT, embedding_ref TEXT, metadata_json TEXT NOT NULL
  );
  CREATE TABLE memory_edges (
    id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE, relation TEXT NOT NULL,
    strength REAL NOT NULL, confidence REAL NOT NULL, created_at TEXT NOT NULL,
    created_by TEXT, valid_from TEXT, valid_until TEXT, metadata_json TEXT NOT NULL
  );
  CREATE TABLE memory_versions (
    version_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
    actor TEXT, reason TEXT, UNIQUE(memory_id, revision)
  );
  CREATE TABLE memory_imports (
    source_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    imported_at TEXT NOT NULL
  );
  CREATE TABLE memory_embeddings (
    memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL, model TEXT NOT NULL, content_hash TEXT NOT NULL,
    dimensions INTEGER NOT NULL, vector_json TEXT NOT NULL, indexed_at TEXT NOT NULL,
    PRIMARY KEY(memory_id, model)
  );
  CREATE TABLE memory_access (
    memory_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'project', owner_client TEXT, updated_at TEXT NOT NULL
  );
  PRAGMA user_version=2;
`;

describe.skipIf(!nodeSqlite)('memory relevantWhen triggers (T-Mem lite)', () => {
  it('derives triggers on write and unions them on a duplicate', async () => {
    const root = await project();
    const { memory } = await open(root);
    const first = await memory.remember({
      kind: 'failure', content: 'npm test failed with ETIMEDOUT', source: { agent: 'test' },
    });
    expect(first.relevantWhen).toEqual(['when npm fails with etimedout']);

    const merged = await memory.remember({
      kind: 'failure', content: 'npm test failed with ETIMEDOUT',
      relevantWhen: ['when running npm'], source: { agent: 'test' },
    });
    expect(merged.id).toBe(first.id);
    expect([...(merged.relevantWhen ?? [])].sort()).toEqual(
      ['when npm fails with etimedout', 'when running npm'],
    );
    await memory.close();
  });

  it('surfaces a trigger-only hit that the similarity prefilter would drop', async () => {
    const root = await project();
    const { memory } = await open(root);
    const weak = await memory.remember({
      kind: 'fact', content: 'timeout handling notes.', source: { agent: 'test' },
    });
    const triggered = await memory.remember({
      kind: 'fact', content: 'Widget inventory reconciliation.',
      relevantWhen: ['when sqlite lock timeout'], source: { agent: 'test' },
    });
    const hits = await memory.recall({ text: 'sqlite lock timeout', limit: 10 });
    const ids = hits.map((hit) => hit.node.id);
    expect(ids[0]).toBe(triggered.id);
    expect(ids).toContain(weak.id);
    expect(hits.find((hit) => hit.node.id === triggered.id)?.signals.triggerMatch).toBe(1);
    await memory.close();
  });

  it('still respects content diversity among trigger hits', async () => {
    const root = await project();
    const { backend, memory, projectId } = await open(root);
    for (const id of ['dup-a', 'dup-b']) {
      await backend.add({
        projectId, id, kind: 'fact', content: 'Identical trigger note.',
        relevantWhen: ['when sqlite lock timeout'],
      });
    }
    const hits = await memory.recall({ text: 'sqlite lock timeout', limit: 10 });
    expect(hits.filter((hit) => hit.node.content === 'Identical trigger note.')).toHaveLength(1);
    await memory.close();
  });

  it('migrates a v2 database additively and keeps FTS healthy on an empty trigger list', async () => {
    const root = await project();
    const dir = path.join(root, '.zelari', 'memory');
    await fs.mkdir(dir, { recursive: true });
    const dbPath = path.join(dir, 'memory.db');
    const seed = new nodeSqlite!.DatabaseSync(dbPath);
    seed.exec(V2_SCHEMA);
    const at = '2026-01-01T00:00:00.000Z';
    seed.prepare(`INSERT INTO memory_nodes (
      id,schema_version,project_id,kind,content,importance,confidence,status,visibility,
      tags_json,source_json,created_at,updated_at,valid_from,valid_until,recorded_at,
      retracted_at,embedding_ref,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'v2-node', 1, 'legacy-project', 'fact', 'Legacy sqlite note.', 0.5, 0.7,
      'active', 'project', '[]', '{"agent":"legacy"}', at, at, null, null, at, null, null, '{}',
    );
    seed.close();

    const backend = new SQLiteMemoryBackend();
    await backend.init(root);
    expect((await backend.get('v2-node'))?.relevantWhen).toEqual([]);
    expect(await backend.searchRelevantWhen!({ text: 'legacy sqlite', limit: 5 })).toEqual([]);
    expect((await backend.doctor()).checks.find((check) => check.name === 'schema')?.ok).toBe(true);
    await backend.close();

    const migrated = new nodeSqlite!.DatabaseSync(dbPath);
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    expect(migrated.prepare(
      "SELECT relevant_when_json FROM memory_nodes WHERE id='v2-node'",
    ).get()).toEqual({ relevant_when_json: '[]' });
    expect(migrated.prepare(
      "SELECT count(*) n FROM memory_fts WHERE node_id='v2-node'",
    ).get()).toEqual({ n: 1 });
    migrated.close();
    await expect(fs.stat(`${dbPath}.migration.lock`)).rejects.toThrow();
  });

  it('honors ZELARI_MEMORY_TRIGGERS=0 for both derive and match', async () => {
    const root = await project();
    const { backend, memory, projectId } = await open(root, false);
    const stored = await memory.remember({
      kind: 'failure', content: 'npm test failed with ETIMEDOUT', source: { agent: 'test' },
    });
    expect(stored.relevantWhen ?? []).toEqual([]);
    await backend.add({
      projectId, id: 'trigger-only', kind: 'fact', content: 'Widget inventory.',
      relevantWhen: ['when sqlite lock timeout'],
    });
    expect(await memory.recall({ text: 'sqlite lock timeout' })).toEqual([]);
    await memory.close();

    expect(isMemoryTriggersEnabled({ ZELARI_MEMORY_V2: '1', ZELARI_MEMORY_TRIGGERS: '0' } as NodeJS.ProcessEnv))
      .toBe(false);
    expect(isMemoryTriggersEnabled({ ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isMemoryTriggersEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is a no-op when memory V2 is off', async () => {
    const root = await project();
    const memory = await getMemoryService(root, {} as NodeJS.ProcessEnv);
    expect(await memory.recall({ text: 'anything' })).toEqual([]);
    expect((await memory.stats()).backend).toBe('disabled');
    await memory.close();
  });
});
