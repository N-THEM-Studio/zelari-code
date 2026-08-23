export const SQLITE_MEMORY_SCHEMA_VERSION = 2;

export interface SqliteMemoryMigration {
  version: number;
  sql: string;
}

export const SQLITE_MEMORY_BASE_SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS memory_nodes (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL CHECK (status IN ('active','superseded','retracted','archived')),
  visibility TEXT NOT NULL DEFAULT 'project' CHECK (visibility IN ('project','private')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  recorded_at TEXT NOT NULL,
  retracted_at TEXT,
  embedding_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  strength REAL NOT NULL CHECK (strength >= 0 AND strength <= 1),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  created_by TEXT,
  valid_from TEXT,
  valid_until TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  CHECK (from_id <> to_id)
);

CREATE TABLE IF NOT EXISTS memory_versions (
  version_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor TEXT,
  reason TEXT,
  UNIQUE(memory_id, revision)
);

CREATE TABLE IF NOT EXISTS memory_imports (
  source_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  model TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_json TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY(memory_id, model)
);

CREATE TABLE IF NOT EXISTS memory_access (
  memory_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'project' CHECK (visibility IN ('project','private')),
  owner_client TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_project_status
  ON memory_nodes(project_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_project_kind
  ON memory_nodes(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_importance
  ON memory_nodes(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_updated
  ON memory_nodes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(to_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_relation ON memory_edges(relation);
CREATE INDEX IF NOT EXISTS idx_memory_versions_memory_revision
  ON memory_versions(memory_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_project_model
  ON memory_embeddings(project_id, model);
CREATE INDEX IF NOT EXISTS idx_memory_access_visibility
  ON memory_access(visibility);

CREATE TRIGGER IF NOT EXISTS memory_nodes_access_insert AFTER INSERT ON memory_nodes BEGIN
  INSERT OR REPLACE INTO memory_access(memory_id, visibility, owner_client, updated_at)
  VALUES (new.id, new.visibility, json_extract(new.source_json, '$.client'), new.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS memory_nodes_access_update
AFTER UPDATE OF visibility, source_json ON memory_nodes BEGIN
  INSERT OR REPLACE INTO memory_access(memory_id, visibility, owner_client, updated_at)
  VALUES (new.id, new.visibility, json_extract(new.source_json, '$.client'), new.updated_at);
END;

INSERT OR IGNORE INTO memory_access(memory_id, visibility, owner_client, updated_at)
SELECT id, visibility, json_extract(source_json, '$.client'), updated_at FROM memory_nodes;
`;

/** Ordered, forward-only migrations for databases that already have user_version. */
export const SQLITE_MEMORY_MIGRATIONS: readonly SqliteMemoryMigration[] = [
  {
    version: 2,
    sql: `
      ALTER TABLE memory_nodes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'project'
        CHECK (visibility IN ('project','private'));
      CREATE TABLE memory_embeddings (
        memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        model TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        vector_json TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY(memory_id, model)
      );
      CREATE TABLE memory_access (
        memory_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,
        visibility TEXT NOT NULL DEFAULT 'project' CHECK (visibility IN ('project','private')),
        owner_client TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_memory_embeddings_project_model
        ON memory_embeddings(project_id, model);
      CREATE INDEX idx_memory_access_visibility ON memory_access(visibility);
      CREATE TRIGGER memory_nodes_access_insert AFTER INSERT ON memory_nodes BEGIN
        INSERT OR REPLACE INTO memory_access(memory_id, visibility, owner_client, updated_at)
        VALUES (new.id, new.visibility, json_extract(new.source_json, '$.client'), new.updated_at);
      END;
      CREATE TRIGGER memory_nodes_access_update
      AFTER UPDATE OF visibility, source_json ON memory_nodes BEGIN
        INSERT OR REPLACE INTO memory_access(memory_id, visibility, owner_client, updated_at)
        VALUES (new.id, new.visibility, json_extract(new.source_json, '$.client'), new.updated_at);
      END;
      INSERT INTO memory_access(memory_id, visibility, owner_client, updated_at)
      SELECT id, visibility, json_extract(source_json, '$.client'), updated_at FROM memory_nodes;
    `,
  },
];

export const SQLITE_MEMORY_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  node_id UNINDEXED,
  content,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_nodes_fts_insert AFTER INSERT ON memory_nodes BEGIN
  INSERT INTO memory_fts(node_id, content, tags)
  VALUES (new.id, new.content, new.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS memory_nodes_fts_delete AFTER DELETE ON memory_nodes BEGIN
  DELETE FROM memory_fts WHERE node_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS memory_nodes_fts_update
AFTER UPDATE OF content, tags_json ON memory_nodes BEGIN
  DELETE FROM memory_fts WHERE node_id = old.id;
  INSERT INTO memory_fts(node_id, content, tags)
  VALUES (new.id, new.content, new.tags_json);
END;

INSERT INTO memory_fts(node_id, content, tags)
SELECT n.id, n.content, n.tags_json
FROM memory_nodes n
WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.node_id = n.id);
`;
