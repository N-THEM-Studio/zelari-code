import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteMemoryBackend } from '../../src/cli/memory/sqliteBackend.js';
import { SqliteWorkerRpc } from '../../src/cli/memory/sqliteRpc.js';
import { getMemoryService } from '../../src/cli/memory/serviceFactory.js';

const roots: string[] = [];
const V1_SCHEMA = `
  PRAGMA foreign_keys=ON;
  CREATE TABLE memory_nodes (
    id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, project_id TEXT NOT NULL,
    kind TEXT NOT NULL, content TEXT NOT NULL, importance REAL NOT NULL,
    confidence REAL NOT NULL, status TEXT NOT NULL, tags_json TEXT NOT NULL,
    source_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    valid_from TEXT, valid_until TEXT, recorded_at TEXT NOT NULL, retracted_at TEXT,
    embedding_ref TEXT, metadata_json TEXT NOT NULL
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
  PRAGMA user_version=1;
`;

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-migration-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function v1Database(root: string): Promise<string> {
  const dir = path.join(root, '.zelari', 'memory');
  await fs.mkdir(dir, { recursive: true });
  const dbPath = path.join(dir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  db.exec(V1_SCHEMA);
  const at = '2026-01-01T00:00:00.000Z';
  const snapshot = {
    id: 'legacy-node', schemaVersion: 1, projectId: 'legacy-project', kind: 'fact',
    content: 'Legacy schema memory.', importance: 0.5, confidence: 0.7,
    status: 'active', tags: [], source: { agent: 'legacy' }, createdAt: at,
    updatedAt: at, recordedAt: at, metadata: {},
  };
  db.prepare(`INSERT INTO memory_nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'legacy-node', 1, 'legacy-project', 'fact', 'Legacy schema memory.', 0.5, 0.7,
    'active', '[]', '{"agent":"legacy"}', at, at, null, null, at, null, null, '{}',
  );
  db.prepare('INSERT INTO memory_versions VALUES (?,?,?,?,?,?,?)').run(
    'legacy-version', 'legacy-node', 1, JSON.stringify(snapshot), at, 'legacy', 'created',
  );
  db.close();
  return dbPath;
}

describe('SQLite memory migrations', () => {
  it('migrates v1 forward under a lock and preserves an automatic backup', async () => {
    const root = await project();
    const dbPath = await v1Database(root);
    const backend = new SQLiteMemoryBackend();
    await backend.init(root);
    expect((await backend.get('legacy-node'))?.visibility).toBe('project');
    expect((await backend.doctor()).checks.find((check) => check.name === 'schema')?.ok).toBe(true);
    await backend.close();

    const migrated = new DatabaseSync(dbPath);
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name='memory_embeddings'").get())
      .toBeTruthy();
    migrated.close();
    const backupPath = `${dbPath}.v1.bak`;
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    expect(backup.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    backup.close();
    await expect(fs.stat(`${dbPath}.migration.lock`)).rejects.toThrow();
  });

  it('rolls back a failed migration and leaves the source database recoverable', async () => {
    const root = await project();
    const dbPath = await v1Database(root);
    const rpc = new SqliteWorkerRpc();
    await expect(rpc.open({
      dbPath,
      schemaSql: V1_SCHEMA,
      ftsSql: '',
      schemaVersion: 2,
      migrations: [{ version: 2, sql: 'CREATE TABLE partial(id TEXT); INVALID SQL;' }],
    })).rejects.toThrow();
    await rpc.close();
    const db = new DatabaseSync(dbPath);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get()).toBeUndefined();
    expect(db.prepare('SELECT content FROM memory_nodes WHERE id=?').get('legacy-node'))
      .toEqual({ content: 'Legacy schema memory.' });
    db.close();
    await fs.access(`${dbPath}.v1.bak`);
  });

  it('emits identifier-only migration observability through the service factory', async () => {
    const root = await project();
    await v1Database(root);
    const events: Array<{ type: string; reason?: string }> = [];
    const warnings: string[] = [];
    const memory = await getMemoryService(
      root,
      { ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv,
      {
        force: true,
        onEvent: (event) => { events.push(event); },
        onWarning: (warning) => warnings.push(warning),
      },
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'memory_migration', reason: 'v1->v2' }));
    expect(JSON.stringify(events)).not.toContain('Legacy schema memory');
    expect(warnings.join('\n')).toMatch(/backup/i);
    await memory.close();
  });
});
