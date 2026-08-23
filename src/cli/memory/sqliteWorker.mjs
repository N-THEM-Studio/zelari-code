import { parentPort } from 'node:worker_threads';
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

if (!parentPort) throw new Error('sqliteWorker must run inside a worker thread');

let database = null;

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireMigrationLock(dbPath, timeoutMs = 10_000) {
  if (!dbPath || dbPath === ':memory:') return { path: null, fd: null };
  const lockPath = `${dbPath}.migration.lock`;
  const started = Date.now();
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return { path: lockPath, fd };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 300_000) {
          let ownerAlive = false;
          try {
            const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
            if (Number.isInteger(owner?.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0); ownerAlive = true; } catch {}
            }
          } catch {}
          if (!ownerAlive) unlinkSync(lockPath);
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
      if (Date.now() - started >= timeoutMs) {
        const locked = new Error(`Timed out waiting for memory migration lock: ${lockPath}`);
        locked.code = 'ZELARI_MEMORY_MIGRATION_LOCKED';
        throw locked;
      }
      waitSync(50);
    }
  }
}

function releaseMigrationLock(lock) {
  if (lock.fd !== null) {
    try { closeSync(lock.fd); } catch {}
  }
  if (lock.path) {
    try { unlinkSync(lock.path); } catch {}
  }
}

function invoke(statement, mode, params = []) {
  const fn = statement[mode];
  if (typeof fn !== 'function') throw new Error(`Unsupported SQLite statement mode: ${mode}`);
  return Array.isArray(params) ? fn.call(statement, ...params) : fn.call(statement, params);
}

function executeStep(step) {
  const statement = database.prepare(step.sql);
  const result = invoke(statement, step.mode ?? 'run', step.params ?? []);
  if (step.mode === 'run' || !step.mode) {
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: String(result.lastInsertRowid ?? ''),
    };
  }
  return result;
}

function hashContent(content) {
  return createHash('sha256').update(String(content ?? '')).digest('hex');
}

function decodeVector(value, dimensions) {
  if (typeof value !== 'string') return null;
  try {
    const vector = JSON.parse(value);
    const expected = Number(dimensions);
    return Array.isArray(vector) && vector.length === expected && vector.length > 0 &&
      vector.every((item) => typeof item === 'number' && Number.isFinite(item))
      ? vector
      : null;
  } catch { return null; }
}

function cosine(left, right) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

const handlers = {
  async open(args) {
    if (database) return { fts: true };
    const lock = acquireMigrationLock(args.dbPath, args.migrationLockTimeoutMs ?? 30_000);
    try {
      database = new DatabaseSync(args.dbPath, {
        timeout: args.timeoutMs ?? 5_000,
        enableForeignKeyConstraints: true,
      });
      const row = database.prepare('PRAGMA user_version').get();
      const currentVersion = Number(row?.user_version ?? 0);
      if (currentVersion > args.schemaVersion) {
        const error = new Error(
          `Memory database schema v${currentVersion} is newer than runtime v${args.schemaVersion}; refusing to downgrade.`,
        );
        error.code = 'ZELARI_MEMORY_SCHEMA_NEWER';
        throw error;
      }
      let migratedFrom;
      let backupPath;
      if (currentVersion === 0) {
        database.exec(args.schemaSql);
        database.exec(`PRAGMA user_version = ${Number(args.schemaVersion)}`);
      } else if (currentVersion < args.schemaVersion) {
        migratedFrom = currentVersion;
        const baseBackupPath = `${args.dbPath}.v${currentVersion}.bak`;
        backupPath = existsSync(baseBackupPath)
          ? `${baseBackupPath}.${Date.now()}`
          : baseBackupPath;
        await backup(database, backupPath);
        const migrations = [...(args.migrations ?? [])]
          .filter((migration) => migration.version > currentVersion && migration.version <= args.schemaVersion)
          .sort((a, b) => a.version - b.version);
        let expected = currentVersion + 1;
        for (const migration of migrations) {
          if (migration.version !== expected) {
            const error = new Error(`Missing memory migration v${expected} -> v${migration.version}.`);
            error.code = 'ZELARI_MEMORY_MIGRATION_GAP';
            throw error;
          }
          database.exec('BEGIN EXCLUSIVE');
          try {
            database.exec(migration.sql);
            database.exec(`PRAGMA user_version = ${Number(migration.version)}`);
            database.exec('COMMIT');
          } catch (error) {
            try { database.exec('ROLLBACK'); } catch {}
            throw error;
          }
          expected += 1;
        }
        if (expected - 1 !== args.schemaVersion) {
          const error = new Error(`No complete migration path from v${currentVersion} to v${args.schemaVersion}.`);
          error.code = 'ZELARI_MEMORY_MIGRATION_GAP';
          throw error;
        }
        database.exec(args.schemaSql);
      } else {
        database.exec(args.schemaSql);
      }
      let fts = true;
      try {
        database.exec(args.ftsSql);
      } catch {
        fts = false;
      }
      return { fts, migratedFrom, backupPath };
    } catch (error) {
      try { database?.close(); } catch {}
      database = null;
      throw error;
    } finally {
      releaseMigrationLock(lock);
    }
  },
  exec(args) {
    database.exec(args.sql);
    return null;
  },
  statement(args) {
    return executeStep(args);
  },
  vectorSearch(args) {
    const rows = invoke(database.prepare(args.sql), 'all', args.params ?? []);
    const scored = [];
    for (const row of rows) {
      const vector = decodeVector(row.vector_json, row.dimensions);
      if (!vector || vector.length !== args.vector.length) continue;
      if (row.content_hash !== hashContent(row.content)) continue;
      scored.push({
        ...row,
        semantic_relevance: Math.max(0, Math.min(1, cosine(args.vector, vector))),
      });
    }
    scored.sort((left, right) =>
      right.semantic_relevance - left.semantic_relevance ||
      Number(right.importance ?? 0) - Number(left.importance ?? 0));
    return scored.slice(0, Math.max(1, Number(args.limit) || 1));
  },
  semanticStatus(args) {
    const rows = database.prepare(`SELECT n.content, e.content_hash, e.dimensions,
      e.vector_json, e.indexed_at FROM memory_nodes n LEFT JOIN memory_embeddings e
      ON e.memory_id=n.id AND e.model=? WHERE n.project_id=? AND n.status='active'`)
      .all(args.model, args.projectId);
    let indexed = 0;
    let stale = 0;
    let corrupt = 0;
    let lastIndexedAt;
    for (const row of rows) {
      const vector = decodeVector(row.vector_json, row.dimensions);
      const fresh = vector && row.content_hash === hashContent(row.content);
      if (fresh) {
        indexed += 1;
        if (typeof row.indexed_at === 'string' && (!lastIndexedAt || row.indexed_at > lastIndexedAt)) {
          lastIndexedAt = row.indexed_at;
        }
      } else {
        stale += 1;
        if (row.vector_json !== null && row.vector_json !== undefined) corrupt += 1;
      }
    }
    return { indexed, stale, corrupt, lastIndexedAt };
  },
  batch(args) {
    database.exec(args.immediate === false ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const results = args.steps.map(executeStep);
      database.exec('COMMIT');
      return results;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  },
  close() {
    database?.close();
    database = null;
    return null;
  },
};

parentPort.on('message', async ({ id, operation, args }) => {
  try {
    const handler = handlers[operation];
    if (!handler) throw new Error(`Unknown SQLite worker operation: ${operation}`);
    parentPort.postMessage({ id, ok: true, value: await handler(args ?? {}) });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        stack: error?.stack,
        code: error?.code,
        errcode: error?.errcode,
      },
    });
  }
});
