import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DefaultMemoryService, type MemoryEmbeddingProvider } from '@zelari/core/memory';
import { canonicalProjectId } from '../../src/cli/memory/serviceFactory.js';
import { SQLiteMemoryBackend } from '../../src/cli/memory/sqliteBackend.js';
import { evaluateMemoryRecall, semanticGain } from '../../tools/eval/memoryMetrics.ts';

const roots: string[] = [];

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-semantic-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function provider(model = 'test-embedding/v1'): MemoryEmbeddingProvider {
  return {
    model,
    embed: async (texts) => texts.map((text) => {
      const normalized = text.toLowerCase();
      if (/sqlite|wal|relational|persistence/.test(normalized)) return [1, 0, 0];
      if (/button|css|visual|interface/.test(normalized)) return [0, 1, 0];
      return [0, 0, 1];
    }),
  };
}

async function semanticService(root: string, embedding = provider()) {
  const backend = new SQLiteMemoryBackend();
  await backend.init(root);
  const memory = new DefaultMemoryService(await canonicalProjectId(root), backend, {
    embeddingProvider: embedding,
  });
  return { backend, memory };
}

describe('hybrid semantic project memory', () => {
  it('finds conceptually related memory with no lexical overlap and persists the index', async () => {
    const root = await project();
    const first = await semanticService(root);
    const decision = await first.memory.remember({
      kind: 'decision',
      content: 'Use SQLite WAL for shared project memory.',
      source: { agent: 'council' },
    });
    const preference = await first.memory.remember({
      kind: 'preference',
      content: 'Render buttons with compact CSS.',
      source: { agent: 'designer' },
    });

    const lexicalBackend = new SQLiteMemoryBackend();
    await lexicalBackend.init(root);
    const lexical = new DefaultMemoryService(await canonicalProjectId(root), lexicalBackend);
    const lexicalDatabase = await lexical.recall({ text: 'durable relational persistence', limit: 3 });
    const lexicalInterface = await lexical.recall({ text: 'visual interface', limit: 3 });
    expect(lexicalDatabase).toEqual([]);
    expect(lexicalInterface).toEqual([]);
    await lexical.close();

    const built = await first.memory.index({ force: true });
    expect(built).toMatchObject({ status: 'ready', indexed: 2, failed: 0 });
    const hits = await first.memory.recall({ text: 'durable relational persistence', limit: 3 });
    const interfaceHits = await first.memory.recall({ text: 'visual interface', limit: 3 });
    expect(hits[0]?.node.id).toBe(decision.id);
    expect(interfaceHits[0]?.node.id).toBe(preference.id);
    expect(hits[0]?.signals.semanticRelevance).toBeGreaterThan(0.9);
    const cases = [
      { id: 'database', relevantIds: [decision.id] },
      { id: 'interface', relevantIds: [preference.id] },
    ];
    const lexicalMetrics = evaluateMemoryRecall(cases, [
      { caseId: 'database', returnedIds: lexicalDatabase.map(({ node }) => node.id), contextTokens: 0, latencyMs: 0 },
      { caseId: 'interface', returnedIds: lexicalInterface.map(({ node }) => node.id), contextTokens: 0, latencyMs: 0 },
    ]);
    const hybridMetrics = evaluateMemoryRecall(cases, [
      { caseId: 'database', returnedIds: hits.map(({ node }) => node.id), contextTokens: 80, latencyMs: 0 },
      { caseId: 'interface', returnedIds: interfaceHits.map(({ node }) => node.id), contextTokens: 80, latencyMs: 0 },
    ]);
    expect(semanticGain(lexicalMetrics, hybridMetrics)).toMatchObject({ materiallyBetter: true });
    await first.memory.close();

    const restarted = await semanticService(root);
    const status = await restarted.memory.stats();
    expect(status).toMatchObject({ semanticIndex: 'ready', semanticIndexed: 2, semanticStale: 0 });
    expect((await restarted.memory.index()).indexed).toBe(0);
    expect((await restarted.memory.recall({ text: 'durable relational persistence' }))[0]?.node.id)
      .toBe(decision.id);
    await restarted.memory.close();
  });

  it('invalidates changed content and lazily rebuilds only the stale node', async () => {
    const root = await project();
    const { backend, memory } = await semanticService(root);
    const node = await memory.remember({
      kind: 'decision', content: 'Use SQLite WAL for shared project memory.', source: { agent: 'test' },
    });
    await memory.index();
    await backend.update(node.id, { content: 'Use compact CSS buttons for the visual interface.' });
    expect((await memory.stats()).semanticStale).toBe(1);
    const hits = await memory.recall({ text: 'visual interface', limit: 2 });
    expect(hits[0]?.node.id).toBe(node.id);
    expect((await memory.stats()).semanticStale).toBe(0);
    await memory.close();
  });

  it('falls back deterministically when embeddings fail or the persisted vector is corrupt', async () => {
    const root = await project();
    const working = await semanticService(root);
    await working.memory.remember({
      kind: 'fact', content: 'SQLite recovery uses WAL checkpoints.', source: { agent: 'test' },
    });
    await working.memory.index();
    await working.memory.close();

    const dbPath = path.join(root, '.zelari', 'memory', 'memory.db');
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE memory_embeddings SET vector_json='not-json'").run();
    db.close();

    const reopened = await semanticService(root, {
      model: 'test-embedding/v1',
      embed: async () => ({ error: 'provider unavailable' }),
    });
    const hits = await reopened.memory.recall({ text: 'SQLite recovery', limit: 3 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.signals.lexicalRelevance).toBeGreaterThan(0);
    expect((await reopened.memory.stats()).semanticIndex).toBe('degraded');
    await reopened.memory.close();
  });

  it('keeps model versions independent and supports interruptible rebuilds', async () => {
    const root = await project();
    const first = await semanticService(root, provider('model-a'));
    await first.memory.remember({ kind: 'fact', content: 'Use SQLite WAL.', source: { agent: 'test' } });
    await first.memory.index();
    await first.memory.close();

    const second = await semanticService(root, provider('model-b'));
    const controller = new AbortController();
    controller.abort();
    expect(await second.memory.index({ signal: controller.signal })).toMatchObject({ interrupted: true });
    expect(await second.memory.index()).toMatchObject({ status: 'ready', model: 'model-b', indexed: 1 });
    expect((await second.memory.stats()).semanticModel).toBe('model-b');
    await second.memory.close();
  });

  it('paginates large rebuilds without loading or repeating the full source set', async () => {
    const root = await project();
    const initializer = new SQLiteMemoryBackend();
    await initializer.init(root);
    await initializer.close();
    const projectId = await canonicalProjectId(root);
    const db = new DatabaseSync(path.join(root, '.zelari', 'memory', 'memory.db'));
    const insert = db.prepare(`INSERT INTO memory_nodes (
      id,schema_version,project_id,kind,content,importance,confidence,status,visibility,
      tags_json,source_json,created_at,updated_at,valid_from,valid_until,recorded_at,
      retracted_at,embedding_ref,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const at = '2026-01-01T00:00:00.000Z';
    db.exec('BEGIN');
    for (let index = 0; index < 513; index += 1) {
      insert.run(
        `mem-page-${String(index).padStart(4, '0')}`, 1, projectId, 'fact',
        `SQLite pagination memory ${index}.`, 0.5, 0.7, 'active', 'project',
        '[]', '{"agent":"pagination-test"}', at, at, null, null, at, null, null, '{}',
      );
    }
    db.exec('COMMIT');
    db.close();
    const { memory } = await semanticService(root);
    expect(await memory.index({ force: true, batchSize: 128 })).toMatchObject({
      status: 'ready', scanned: 513, indexed: 513,
    });
    expect(await memory.index()).toMatchObject({ scanned: 0, indexed: 0 });
    expect(await memory.index({ force: true, limit: 512 })).toMatchObject({ scanned: 512, indexed: 512 });
    await memory.close();
  });
});
