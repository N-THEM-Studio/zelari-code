/** Native SQLite cognitive-memory backend (Node 24 `node:sqlite`). */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  MemoryEdgeInputSchema,
  MemoryEdgeSchema,
  MemoryNodeSchema,
  lexicalRelevance,
} from '@zelari/core/memory';
import type {
  CognitiveMemoryBackend,
  EdgeQuery,
  MemoryCandidate,
  MemoryDoctorResult,
  MemoryEdge,
  MemoryEdgeInput,
  MemoryExport,
  MemoryEmbeddingRecord,
  MemoryNode,
  MemoryNodeInput,
  MemoryPatch,
  MemoryQuery,
  MemorySemanticSource,
  MemorySemanticStatus,
  MemoryStats,
  MemoryVersion,
} from '@zelari/core/memory';
import {
  decodeEdge,
  decodeNode,
  decodeVersion,
  edgeSqlValues,
  nodeSqlValues,
  type SqlRow,
} from './sqliteCodec.js';
import { SqliteWorkerRpc, type SqlStep, type SqlValue } from './sqliteRpc.js';
import {
  SQLITE_MEMORY_BASE_SCHEMA,
  SQLITE_MEMORY_FTS_SCHEMA,
  SQLITE_MEMORY_MIGRATIONS,
  SQLITE_MEMORY_SCHEMA_VERSION,
} from './sqliteSchema.js';

const NODE_COLUMNS = `
  id, schema_version, project_id, kind, content, importance, confidence,
  status, visibility, tags_json, source_json, created_at, updated_at, valid_from,
  valid_until, recorded_at, retracted_at, embedding_ref, metadata_json`;

const INSERT_NODE_SQL = `INSERT INTO memory_nodes (${NODE_COLUMNS})
VALUES (${Array.from({ length: 19 }, () => '?').join(',')})`;

const SOURCE_COLUMNS: Record<string, string> = {
  agent: 'agent', sessionId: 'sessionId', missionId: 'missionId',
  sliceId: 'sliceId', tentacleId: 'tentacleId', councilMemberId: 'councilMemberId',
  skillId: 'skillId', verificationId: 'verificationId', file: 'file', symbol: 'symbol',
  commit: 'commit', branch: 'branch', worktree: 'worktree', toolCallId: 'toolCallId',
  client: 'client',
};

export interface SQLiteMemoryBackendOptions {
  filename?: string;
  busyTimeoutMs?: number;
}

function boundedLimit(value: number | undefined, fallback = 50): number {
  return Math.max(1, Math.min(Math.floor(value ?? fallback), 100_000));
}

function ftsExpression(text: string): string {
  const terms = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return [...new Set(terms)].slice(0, 32).map((term) => `"${term.replace(/"/g, '')}"*`).join(' OR ');
}

function withOptional<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | null | undefined,
): T & Partial<Record<K, V>> {
  if (value === null || value === undefined || value === '') return target;
  return { ...target, [key]: value } as T & Record<K, V>;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class SQLiteMemoryBackend implements CognitiveMemoryBackend {
  private readonly rpc = new SqliteWorkerRpc();
  private initialized = false;
  private fts = false;
  private projectRoot = '';
  readonly options: SQLiteMemoryBackendOptions;
  databasePath = '';
  lastMigration?: { from: number; to: number; backupPath?: string };

  constructor(options: SQLiteMemoryBackendOptions = {}) {
    this.options = options;
  }

  async init(projectRoot: string): Promise<void> {
    let resolved: string;
    try { resolved = await fs.realpath(projectRoot); }
    catch { resolved = path.resolve(projectRoot); }
    if (this.initialized && resolved === this.projectRoot) return;
    if (this.initialized) await this.close();
    const filename = this.options.filename ?? 'memory.db';
    if (path.basename(filename) !== filename || filename === '.' || filename === '..') {
      throw new Error('SQLite memory filename must not contain a path.');
    }
    const zelariDirectory = path.join(resolved, '.zelari');
    const directory = path.join(zelariDirectory, 'memory');
    for (const candidate of [zelariDirectory, directory]) {
      let stat;
      try {
        stat = await fs.lstat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { await fs.mkdir(candidate); }
        catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        stat = await fs.lstat(candidate);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Memory directory is not a real directory: ${candidate}`);
      }
    }
    const canonicalDirectory = await fs.realpath(directory);
    const relativeDirectory = path.relative(resolved, canonicalDirectory);
    if (relativeDirectory.startsWith('..') || path.isAbsolute(relativeDirectory)) {
      throw new Error('SQLite memory directory resolves outside the active project.');
    }
    this.projectRoot = resolved;
    this.databasePath = path.join(canonicalDirectory, filename);
    const opened = await this.rpc.open({
      dbPath: this.databasePath,
      schemaSql: SQLITE_MEMORY_BASE_SCHEMA,
      ftsSql: SQLITE_MEMORY_FTS_SCHEMA,
      schemaVersion: SQLITE_MEMORY_SCHEMA_VERSION,
      migrations: SQLITE_MEMORY_MIGRATIONS,
      timeoutMs: this.options.busyTimeoutMs ?? 5_000,
    });
    this.fts = opened.fts;
    this.lastMigration = opened.migratedFrom === undefined
      ? undefined
      : {
          from: opened.migratedFrom,
          to: SQLITE_MEMORY_SCHEMA_VERSION,
          ...(opened.backupPath ? { backupPath: opened.backupPath } : {}),
        };
    this.initialized = true;
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error('SQLiteMemoryBackend.init(projectRoot) must be called first.');
  }

  async add(input: MemoryNodeInput & { projectId: string }): Promise<MemoryNode> {
    this.assertReady();
    const now = new Date().toISOString();
    const createdAt = input.createdAt ?? now;
    const recordedAt = input.recordedAt ?? createdAt;
    const node = MemoryNodeSchema.parse({
      id: input.id ?? `mem_${randomUUID()}`,
      schemaVersion: 1,
      projectId: input.projectId,
      kind: input.kind,
      content: input.content,
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.5,
      status: input.status ?? 'active',
      visibility: input.visibility ?? 'project',
      tags: input.tags ?? [],
      source: input.source ?? {},
      createdAt,
      updatedAt: now,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      recordedAt,
      embeddingRef: input.embeddingRef,
      metadata: input.metadata ?? {},
    });
    await this.rpc.batch([
      { sql: INSERT_NODE_SQL, params: nodeSqlValues(node) },
      {
        sql: `INSERT INTO memory_versions
          (version_id, memory_id, revision, snapshot_json, recorded_at, actor, reason)
          VALUES (?, ?, 1, ?, ?, ?, ?)`,
        params: [
          `ver_${randomUUID()}`, node.id, JSON.stringify(node), recordedAt,
          node.source.agent ?? null, 'created',
        ],
      },
    ]);
    return node;
  }

  async get(id: string): Promise<MemoryNode | null> {
    this.assertReady();
    const row = await this.rpc.statement<SqlRow | undefined>({
      sql: 'SELECT * FROM memory_nodes WHERE id = ?', params: [id], mode: 'get',
    });
    return decodeNode(row);
  }

  async update(id: string, patch: MemoryPatch): Promise<MemoryNode> {
    const current = await this.get(id);
    if (!current) throw new Error(`Memory ${id} was not found.`);
    const now = new Date().toISOString();
    let updated: MemoryNode = {
      ...current,
      ...(patch.kind ? { kind: patch.kind } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.visibility ? { visibility: patch.visibility } : {}),
      ...(patch.tags ? { tags: patch.tags } : {}),
      ...(patch.source ? { source: patch.source } : {}),
      ...(patch.metadata ? { metadata: patch.metadata } : {}),
      updatedAt: now,
      recordedAt: now,
    };
    updated = withOptional(updated, 'validFrom', patch.validFrom ?? current.validFrom) as MemoryNode;
    updated = withOptional(updated, 'validUntil', patch.validUntil ?? current.validUntil) as MemoryNode;
    updated = withOptional(updated, 'embeddingRef', patch.embeddingRef ?? current.embeddingRef) as MemoryNode;
    if (patch.validFrom === null) delete updated.validFrom;
    if (patch.validUntil === null) delete updated.validUntil;
    if (patch.embeddingRef === null) delete updated.embeddingRef;
    if (updated.status === 'retracted') updated.retractedAt = current.retractedAt ?? now;
    else delete updated.retractedAt;
    updated = MemoryNodeSchema.parse(updated);

    await this.rpc.batch([
      {
        sql: `UPDATE memory_nodes SET
          schema_version=?, project_id=?, kind=?, content=?, importance=?, confidence=?,
          status=?, visibility=?, tags_json=?, source_json=?, created_at=?, updated_at=?, valid_from=?,
          valid_until=?, recorded_at=?, retracted_at=?, embedding_ref=?, metadata_json=?
          WHERE id=?`,
        params: [...nodeSqlValues(updated).slice(1), updated.id],
      },
      {
        sql: `INSERT INTO memory_versions
          (version_id, memory_id, revision, snapshot_json, recorded_at, actor, reason)
          VALUES (?, ?, (SELECT COALESCE(MAX(revision), 0) + 1 FROM memory_versions WHERE memory_id=?), ?, ?, ?, ?)`,
        params: [
          `ver_${randomUUID()}`, updated.id, updated.id, JSON.stringify(updated), now,
          patch.actor ?? null, patch.reason ?? 'updated',
        ],
      },
      ...(patch.content !== undefined && patch.content !== current.content
        ? [{ sql: 'DELETE FROM memory_embeddings WHERE memory_id=?', params: [updated.id] }]
        : []),
    ]);
    return updated;
  }

  async search(query: MemoryQuery): Promise<MemoryCandidate[]> {
    this.assertReady();
    if (query.asOf) return this.searchAsOf(query);
    const text = query.text?.trim() ?? '';
    const expression = text ? ftsExpression(text) : '';
    try {
      return await this.searchCurrent(query, text, expression, this.fts && Boolean(expression));
    } catch (error) {
      if (!this.fts) throw error;
      this.fts = false;
      return this.searchCurrent(query, text, expression, false);
    }
  }

  private async searchCurrent(
    query: MemoryQuery,
    text: string,
    expression: string,
    useFts: boolean,
  ): Promise<MemoryCandidate[]> {
    const params: SqlValue[] = [];
    const where: string[] = [];
    if (useFts) {
      where.push('memory_fts MATCH ?');
      params.push(expression);
    } else if (text) {
      const terms = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
      if (terms.length === 0) return [];
      where.push(`(${terms.slice(0, 16).map(() => '(LOWER(n.content) LIKE ? OR LOWER(n.tags_json) LIKE ?)').join(' OR ')})`);
      for (const term of terms.slice(0, 16)) params.push(`%${term}%`, `%${term}%`);
    }
    this.addFilters(query, where, params, 'n');
    const from = useFts
      ? 'memory_fts JOIN memory_nodes n ON n.id = memory_fts.node_id'
      : 'memory_nodes n';
    const order = useFts ? 'bm25(memory_fts), n.importance DESC' : 'n.updated_at DESC';
    params.push(boundedLimit(query.limit));
    const rows = await this.rpc.statement<SqlRow[]>({
      sql: `SELECT n.* FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`,
      params,
      mode: 'all',
    });
    return rows
      .map(decodeNode)
      .filter((node): node is MemoryNode => Boolean(node))
      .map((node) => ({ node, lexicalRelevance: text ? lexicalRelevance(text, node) : 0 }));
  }

  private addFilters(query: MemoryQuery, where: string[], params: SqlValue[], alias: string): void {
    if (query.projectId) { where.push(`${alias}.project_id = ?`); params.push(query.projectId); }
    const inFilter = (column: string, values: readonly string[] | undefined) => {
      if (!values?.length) return;
      where.push(`${alias}.${column} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    };
    inFilter('kind', query.kinds);
    inFilter('status', query.statuses);
    inFilter('visibility', query.visibilities);
    if (query.externalClient) {
      where.push(`(${alias}.visibility='project' OR (${alias}.visibility='private' AND json_extract(${alias}.source_json,'$.client')=?))`);
      params.push(query.externalClient);
    }
    if (query.minImportance !== undefined) { where.push(`${alias}.importance >= ?`); params.push(query.minImportance); }
    if (query.minConfidence !== undefined) { where.push(`${alias}.confidence >= ?`); params.push(query.minConfidence); }
    if (query.createdAfter) { where.push(`${alias}.created_at >= ?`); params.push(query.createdAfter); }
    if (query.createdBefore) { where.push(`${alias}.created_at <= ?`); params.push(query.createdBefore); }
    if (!query.includeHistorical && !query.asOf) {
      const now = new Date().toISOString();
      where.push(`(${alias}.valid_from IS NULL OR ${alias}.valid_from <= ?)`);
      where.push(`(${alias}.valid_until IS NULL OR ${alias}.valid_until > ?)`);
      params.push(now, now);
    }
    for (const tag of query.tags ?? []) {
      where.push(`EXISTS (SELECT 1 FROM json_each(${alias}.tags_json) WHERE value = ?)`);
      params.push(tag);
    }
    for (const [key, value] of Object.entries(query.source ?? {})) {
      const jsonKey = SOURCE_COLUMNS[key];
      if (!jsonKey || value === undefined) continue;
      where.push(`json_extract(${alias}.source_json, '$.${jsonKey}') = ?`);
      params.push(String(value));
    }
  }

  async listSemanticSources(
    projectId: string,
    model: string,
    options: { force?: boolean; limit?: number; cursor?: string } = {},
  ): Promise<MemorySemanticSource[]> {
    this.assertReady();
    const params: SqlValue[] = [model, projectId];
    const missing = options.force ? '' : ' AND e.memory_id IS NULL';
    const cursor = options.cursor ? ' AND n.id > ?' : '';
    if (options.cursor) params.push(options.cursor);
    params.push(boundedLimit(options.limit, 1_000));
    const rows = await this.rpc.statement<SqlRow[]>({
      sql: `SELECT n.* FROM memory_nodes n
        LEFT JOIN memory_embeddings e ON e.memory_id=n.id AND e.model=?
        WHERE n.project_id=? AND n.status='active'${missing}${cursor}
        ORDER BY n.id ASC LIMIT ?`,
      params,
      mode: 'all',
    });
    return rows
      .map(decodeNode)
      .filter((node): node is MemoryNode => Boolean(node))
      .map((node) => ({ node, contentHash: contentHash(node.content) }));
  }

  async upsertSemanticEmbeddings(records: MemoryEmbeddingRecord[]): Promise<void> {
    this.assertReady();
    if (records.length === 0) return;
    const steps: SqlStep[] = records.map((record) => {
      if (!record.vector.length || !record.vector.every(Number.isFinite)) {
        throw new Error(`Invalid embedding vector for ${record.memoryId}.`);
      }
      return {
        sql: `INSERT INTO memory_embeddings
          (memory_id,project_id,model,content_hash,dimensions,vector_json,indexed_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(memory_id,model) DO UPDATE SET
            project_id=excluded.project_id,
            content_hash=excluded.content_hash,
            dimensions=excluded.dimensions,
            vector_json=excluded.vector_json,
            indexed_at=excluded.indexed_at`,
        params: [
          record.memoryId, record.projectId, record.model, record.contentHash,
          record.vector.length, JSON.stringify(record.vector), record.indexedAt,
        ],
      };
    });
    await this.rpc.batch(steps);
  }

  async semanticSearch(
    query: MemoryQuery,
    vector: number[],
    model: string,
  ): Promise<MemoryCandidate[]> {
    this.assertReady();
    if (!vector.length || !vector.every(Number.isFinite)) return [];
    const params: SqlValue[] = [model];
    const where: string[] = ['e.model=?'];
    this.addFilters(query, where, params, 'n');
    params.push(100_000);
    const rows = await this.rpc.vectorSearch<SqlRow[]>({
      sql: `SELECT n.*, e.content_hash, e.dimensions, e.vector_json
        FROM memory_embeddings e JOIN memory_nodes n ON n.id=e.memory_id
        WHERE ${where.join(' AND ')} ORDER BY n.updated_at DESC LIMIT ?`,
      params,
      vector,
      limit: boundedLimit(query.limit),
    });
    return rows
      .map((row): MemoryCandidate | null => {
        const node = decodeNode(row);
        if (!node) return null;
        return {
          node,
          semanticRelevance: Number(row.semantic_relevance ?? 0),
        };
      })
      .filter((candidate): candidate is MemoryCandidate => Boolean(candidate))
      .slice(0, boundedLimit(query.limit));
  }

  async semanticStatus(projectId: string, model?: string): Promise<MemorySemanticStatus> {
    this.assertReady();
    if (!model) return { state: 'disabled', indexed: 0, stale: 0 };
    const { indexed, stale, corrupt, lastIndexedAt } = await this.rpc.semanticStatus<{
      indexed: number;
      stale: number;
      corrupt: number;
      lastIndexedAt?: string;
    }>({ model, projectId });
    return {
      state: corrupt > 0 || stale > 0 ? 'degraded' : 'ready',
      model,
      indexed,
      stale,
      ...(lastIndexedAt ? { lastIndexedAt } : {}),
      ...(corrupt > 0 ? { detail: `${corrupt} corrupt or stale embedding record(s)` } : {}),
    };
  }

  private async searchAsOf(query: MemoryQuery): Promise<MemoryCandidate[]> {
    const rows = await this.rpc.statement<SqlRow[]>({
      sql: `SELECT v.snapshot_json FROM memory_versions v
        JOIN (
          SELECT memory_id, MAX(revision) revision
          FROM memory_versions WHERE recorded_at <= ? GROUP BY memory_id
        ) latest ON latest.memory_id=v.memory_id AND latest.revision=v.revision`,
      params: [query.asOf!], mode: 'all',
    });
    const text = query.text?.trim() ?? '';
    const matches = rows
      .map((row) => {
        try {
          const parsed = MemoryNodeSchema.safeParse(JSON.parse(String(row.snapshot_json)));
          return parsed.success ? parsed.data as MemoryNode : undefined;
        }
        catch { return undefined; }
      })
      .filter((node): node is MemoryNode => Boolean(node))
      .filter((node) => this.matchesInMemory(node, query))
      .map((node) => ({ node, lexicalRelevance: text ? lexicalRelevance(text, node) : 0 }))
      .filter((candidate) => !text || candidate.lexicalRelevance > 0)
      .sort((a, b) => b.lexicalRelevance - a.lexicalRelevance || b.node.importance - a.node.importance);
    return matches.slice(0, boundedLimit(query.limit));
  }

  private matchesInMemory(node: MemoryNode, query: MemoryQuery): boolean {
    if (query.projectId && node.projectId !== query.projectId) return false;
    if (query.kinds?.length && !query.kinds.includes(node.kind)) return false;
    if (query.statuses?.length && !query.statuses.includes(node.status)) return false;
    if (query.visibilities?.length && !query.visibilities.includes(node.visibility ?? 'project')) return false;
    if (query.externalClient && node.visibility === 'private' && node.source.client !== query.externalClient) return false;
    if (query.tags?.some((tag) => !node.tags.includes(tag))) return false;
    if (query.minImportance !== undefined && node.importance < query.minImportance) return false;
    if (query.minConfidence !== undefined && node.confidence < query.minConfidence) return false;
    if (query.createdAfter && node.createdAt < query.createdAfter) return false;
    if (query.createdBefore && node.createdAt > query.createdBefore) return false;
    const at = query.asOf ?? new Date().toISOString();
    if ((query.asOf || !query.includeHistorical) && node.validFrom && node.validFrom > at) return false;
    if ((query.asOf || !query.includeHistorical) && node.validUntil && node.validUntil <= at) return false;
    return Object.entries(query.source ?? {}).every(([key, value]) =>
      value === undefined || node.source[key as keyof typeof node.source] === value,
    );
  }

  async addEdge(raw: MemoryEdgeInput): Promise<MemoryEdge> {
    this.assertReady();
    const input = MemoryEdgeInputSchema.parse(raw);
    const existing = await this.rpc.statement<SqlRow | undefined>({
      sql: 'SELECT * FROM memory_edges WHERE from_id=? AND to_id=? AND relation=? AND valid_until IS NULL LIMIT 1',
      params: [input.from, input.to, input.relation], mode: 'get',
    });
    const decoded = decodeEdge(existing);
    if (decoded) return decoded;
    const edge = MemoryEdgeSchema.parse({
      ...input,
      id: input.id ?? `edge_${randomUUID()}`,
      strength: input.strength ?? 1,
      confidence: input.confidence ?? 0.8,
      createdAt: new Date().toISOString(),
      metadata: input.metadata ?? {},
    });
    await this.rpc.statement({
      sql: `INSERT INTO memory_edges
        (id, from_id, to_id, relation, strength, confidence, created_at, created_by, valid_from, valid_until, metadata_json)
        VALUES (${Array.from({ length: 11 }, () => '?').join(',')})`,
      params: edgeSqlValues(edge), mode: 'run',
    });
    return edge;
  }

  async edges(nodeId: string, options: EdgeQuery = {}): Promise<MemoryEdge[]> {
    this.assertReady();
    const params: SqlValue[] = [];
    const direction = options.direction ?? 'both';
    if (direction === 'in') { params.push(nodeId); }
    else if (direction === 'out') { params.push(nodeId); }
    else { params.push(nodeId, nodeId); }
    const where = [direction === 'in' ? 'to_id=?' : direction === 'out' ? 'from_id=?' : '(from_id=? OR to_id=?)'];
    if (options.relations?.length) {
      where.push(`relation IN (${options.relations.map(() => '?').join(',')})`);
      params.push(...options.relations);
    }
    if (options.asOf) {
      where.push('(valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)');
      params.push(options.asOf, options.asOf);
    } else {
      const now = new Date().toISOString();
      where.push('(valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)');
      params.push(now, now);
    }
    params.push(boundedLimit(options.limit, 100));
    const rows = await this.rpc.statement<SqlRow[]>({
      sql: `SELECT * FROM memory_edges WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params, mode: 'all',
    });
    return rows.map(decodeEdge).filter((edge): edge is MemoryEdge => Boolean(edge));
  }

  async history(id: string): Promise<MemoryVersion[]> {
    this.assertReady();
    const rows = await this.rpc.statement<SqlRow[]>({
      sql: 'SELECT * FROM memory_versions WHERE memory_id=? ORDER BY revision ASC',
      params: [id], mode: 'all',
    });
    return rows.map(decodeVersion).filter((version): version is MemoryVersion => Boolean(version));
  }

  async getAt(id: string, timestamp: string): Promise<MemoryNode | null> {
    this.assertReady();
    const row = await this.rpc.statement<SqlRow | undefined>({
      sql: 'SELECT snapshot_json FROM memory_versions WHERE memory_id=? AND recorded_at<=? ORDER BY revision DESC LIMIT 1',
      params: [id, timestamp], mode: 'get',
    });
    if (!row) return null;
    try {
      const parsed = MemoryNodeSchema.safeParse(JSON.parse(String(row.snapshot_json)));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }

  async retract(id: string, reason?: string, actor?: string): Promise<void> {
    await this.update(id, { status: 'retracted', reason: reason ?? 'retracted', actor });
  }

  async delete(id: string): Promise<boolean> {
    this.assertReady();
    const result = await this.rpc.statement<{ changes: number }>({
      sql: 'DELETE FROM memory_nodes WHERE id=?', params: [id], mode: 'run',
    });
    return result.changes > 0;
  }

  async stats(): Promise<MemoryStats> {
    this.assertReady();
    const [nodes, edges] = await Promise.all([
      this.rpc.statement<SqlRow>({
        sql: `SELECT COUNT(*) nodes,
          COALESCE(SUM(status='active'),0) active,
          COALESCE(SUM(status='superseded'),0) superseded,
          COALESCE(SUM(status='retracted'),0) retracted,
          COALESCE(SUM(status='archived'),0) archived,
          COALESCE(SUM(status='active' AND json_extract(metadata_json,'$.writeClass')='candidate'),0) candidates
          FROM memory_nodes`, mode: 'get',
      }),
      this.rpc.statement<SqlRow>({ sql: 'SELECT COUNT(*) edges FROM memory_edges', mode: 'get' }),
    ]);
    return {
      backend: 'sqlite', path: this.databasePath, schemaVersion: SQLITE_MEMORY_SCHEMA_VERSION,
      nodes: Number(nodes.nodes ?? 0), edges: Number(edges.edges ?? 0),
      active: Number(nodes.active ?? 0), superseded: Number(nodes.superseded ?? 0),
      retracted: Number(nodes.retracted ?? 0), archived: Number(nodes.archived ?? 0),
      unconsolidatedCandidates: Number(nodes.candidates ?? 0),
      semanticIndex: 'disabled',
    };
  }

  async doctor(): Promise<MemoryDoctorResult> {
    this.assertReady();
    const checks: MemoryDoctorResult['checks'] = [];
    const schema = await this.rpc.statement<SqlRow>({ sql: 'PRAGMA user_version', mode: 'get' });
    const actualVersion = Number(Object.values(schema)[0] ?? 0);
    checks.push({
      name: 'schema',
      ok: actualVersion === SQLITE_MEMORY_SCHEMA_VERSION,
      detail: `database v${actualVersion}; runtime v${SQLITE_MEMORY_SCHEMA_VERSION}`,
    });
    try {
      const integrity = await this.rpc.statement<SqlRow>({ sql: 'PRAGMA integrity_check', mode: 'get' });
      const detail = String(Object.values(integrity)[0] ?? 'unknown');
      checks.push({ name: 'integrity', ok: detail === 'ok', detail });
    } catch (error) {
      checks.push({ name: 'integrity', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    const foreign = await this.rpc.statement<SqlRow[]>({ sql: 'PRAGMA foreign_key_check', mode: 'all' });
    checks.push({ name: 'foreign-keys', ok: foreign.length === 0, detail: foreign.length === 0 ? 'ok' : `${foreign.length} violation(s)` });
    checks.push({ name: 'fts', ok: this.fts, detail: this.fts ? 'FTS5 ready' : 'FTS5 unavailable; LIKE fallback active' });
    return { ok: checks.every((check) => check.ok || check.name === 'fts'), backend: 'sqlite', path: this.databasePath, checks };
  }

  async export(projectId: string): Promise<MemoryExport> {
    this.assertReady();
    const [nodeRows, edgeRows, versionRows] = await Promise.all([
      this.rpc.statement<SqlRow[]>({ sql: 'SELECT * FROM memory_nodes WHERE project_id=? ORDER BY created_at', params: [projectId], mode: 'all' }),
      this.rpc.statement<SqlRow[]>({ sql: `SELECT e.* FROM memory_edges e JOIN memory_nodes n ON n.id=e.from_id WHERE n.project_id=? ORDER BY e.created_at`, params: [projectId], mode: 'all' }),
      this.rpc.statement<SqlRow[]>({ sql: `SELECT v.* FROM memory_versions v JOIN memory_nodes n ON n.id=v.memory_id WHERE n.project_id=? ORDER BY v.memory_id,v.revision`, params: [projectId], mode: 'all' }),
    ]);
    return {
      schemaVersion: 1, exportedAt: new Date().toISOString(), projectId,
      nodes: nodeRows.map(decodeNode).filter((node): node is MemoryNode => Boolean(node)),
      edges: edgeRows.map(decodeEdge).filter((edge): edge is MemoryEdge => Boolean(edge)),
      versions: versionRows.map(decodeVersion).filter((version): version is MemoryVersion => Boolean(version)),
    };
  }

  async hasImport(sourceId: string): Promise<boolean> {
    this.assertReady();
    const row = await this.rpc.statement<SqlRow | undefined>({
      sql: 'SELECT source_id FROM memory_imports WHERE source_id=?', params: [sourceId], mode: 'get',
    });
    return Boolean(row);
  }

  async recordImport(sourceId: string, memoryId: string): Promise<void> {
    this.assertReady();
    await this.rpc.statement({
      sql: 'INSERT OR IGNORE INTO memory_imports(source_id,memory_id,imported_at) VALUES (?,?,?)',
      params: [sourceId, memoryId, new Date().toISOString()], mode: 'run',
    });
  }

  async close(): Promise<void> {
    await this.rpc.close();
    this.initialized = false;
  }
}
