import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chunkFile, cosineSimilarity, searchIndex, type SemanticIndexData } from '../../src/cli/semantic/store.js';
import { parseEmbeddingsResponse, embedTexts } from '../../src/cli/semantic/embeddings.js';
import {
  buildIndex,
  saveIndex,
  loadIndex,
  semanticSearch,
  collectSourceFiles,
  type EmbedFn,
} from '../../src/cli/semantic/index.js';
import { createSemanticTool } from '../../src/cli/semantic/tools.js';
import { handleSlashCommand } from '../../src/cli/slashCommands';
import type { CodingSkillDefinition } from '@zelari/core/skills';

// Deterministic fake embedder: 3-dim one-hot on keyword presence.
const KEYS = ['alpha', 'beta', 'gamma'];
const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => KEYS.map((k) => (t.toLowerCase().includes(k) ? 1 : 0)));

const ctx = { signal: new AbortController().signal, cwd: '/x', audit: () => {}, sessionId: 't' };

// ---------------------------------------------------------------------------
// store (pure)
// ---------------------------------------------------------------------------

describe('semantic store', () => {
  it('chunks with overlap and 1-based line ranges, dropping blank chunks', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = chunkFile('a.ts', text, { maxLines: 40, overlap: 8 });
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(40);
    // step = 40 - 8 = 32
    expect(chunks[1].startLine).toBe(33);
    expect(chunkFile('b.ts', '\n\n\n')).toEqual([]);
  });

  it('cosineSimilarity: identical=1, orthogonal=0, mismatched-length=0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it('searchIndex ranks by cosine and respects k', () => {
    const data: SemanticIndexData = {
      model: 'm', dim: 3, builtAt: 0,
      chunks: [
        { file: 'a', startLine: 1, endLine: 2, text: 'alpha', embedding: [1, 0, 0] },
        { file: 'b', startLine: 1, endLine: 2, text: 'beta', embedding: [0, 1, 0] },
        { file: 'c', startLine: 1, endLine: 2, text: 'gamma', embedding: [0, 0, 1] },
      ],
    };
    const hits = searchIndex(data, [1, 0, 0], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].file).toBe('a');
    expect(hits[0].score).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// embeddings
// ---------------------------------------------------------------------------

describe('semantic embeddings', () => {
  it('parses an ordered embeddings response', () => {
    const json = { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] };
    expect(parseEmbeddingsResponse(json, 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('rejects a partial batch (count mismatch) and bad shapes', () => {
    expect(parseEmbeddingsResponse({ data: [{ index: 0, embedding: [1] }] }, 2)).toBeNull();
    expect(parseEmbeddingsResponse({ nope: true }, 1)).toBeNull();
    expect(parseEmbeddingsResponse(null, 1)).toBeNull();
  });

  it('embedTexts returns vectors on 200 and an error on HTTP failure', async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 })) as unknown as typeof fetch;
    const okRes = await embedTexts(['x'], { apiKey: 'k', baseUrl: 'https://api', model: 'm' }, ok);
    expect(okRes).toEqual({ embeddings: [[1, 2, 3]] });

    const fail = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const failRes = await embedTexts(['x'], { apiKey: 'k', baseUrl: 'https://api', model: 'm' }, fail);
    expect('error' in failRes).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// index build / persist / search
// ---------------------------------------------------------------------------

describe('semantic index build + search', () => {
  let dir: string;
  let indexFile: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sem-'));
    indexFile = path.join(dir, 'index.json');
    savedEnv = process.env.ZELARI_SEMANTIC_FILE;
    process.env.ZELARI_SEMANTIC_FILE = indexFile;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ZELARI_SEMANTIC_FILE;
    else process.env.ZELARI_SEMANTIC_FILE = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds, persists, and semantically ranks chunks', async () => {
    writeFileSync(path.join(dir, 'a.ts'), 'the alpha module handles retries\n');
    writeFileSync(path.join(dir, 'b.ts'), 'the beta module renders views\n');
    const files = await collectSourceFiles(dir);
    const built = await buildIndex(files, fakeEmbed, { model: 'fake', maxLines: 40 });
    expect(built.data).toBeDefined();
    await saveIndex(dir, built.data!);
    expect(loadIndex(dir)?.chunks.length).toBe(built.chunksIndexed);

    const res = await semanticSearch(dir, 'alpha', fakeEmbed, 1);
    expect('hits' in res).toBe(true);
    if ('hits' in res) expect(res.hits[0].file).toMatch(/a\.ts$/);
  });

  it('propagates an embedding error and never writes a partial index', async () => {
    writeFileSync(path.join(dir, 'a.ts'), 'alpha\n');
    const files = await collectSourceFiles(dir);
    const failEmbed: EmbedFn = async () => ({ error: 'no embeddings endpoint' });
    const built = await buildIndex(files, failEmbed, { model: 'x' });
    expect(built.error).toMatch(/no embeddings/);
    expect(built.data).toBeUndefined();
  });

  it('semanticSearch reports a clear error when no index exists', async () => {
    const res = await semanticSearch(dir, 'q', fakeEmbed);
    expect('error' in res).toBe(true);
  });

  it('collectSourceFiles skips node_modules and .git', async () => {
    mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'pkg', 'x.ts'), 'skip me');
    writeFileSync(path.join(dir, 'real.ts'), 'keep');
    const files = await collectSourceFiles(dir);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.endsWith('real.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tool
// ---------------------------------------------------------------------------

describe('semantic_search tool', () => {
  let dir: string;
  let savedEnv: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sem-tool-'));
    savedEnv = process.env.ZELARI_SEMANTIC_FILE;
    process.env.ZELARI_SEMANTIC_FILE = path.join(dir, 'idx.json');
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ZELARI_SEMANTIC_FILE;
    else process.env.ZELARI_SEMANTIC_FILE = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('notes when no index exists yet', async () => {
    const tool = createSemanticTool({ root: dir, buildEmbedFn: async () => fakeEmbed });
    const res = await tool.execute({ query: 'alpha' }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { note?: string }).note).toMatch(/no semantic index/);
  });

  it('returns ranked results against a built index', async () => {
    writeFileSync(path.join(dir, 'a.ts'), 'alpha retry logic\n');
    writeFileSync(path.join(dir, 'b.ts'), 'gamma parser\n');
    const built = await buildIndex(await collectSourceFiles(dir), fakeEmbed, { model: 'fake' });
    await saveIndex(dir, built.data!);
    const tool = createSemanticTool({ root: dir, buildEmbedFn: async () => fakeEmbed });
    const res = await tool.execute({ query: 'alpha', k: 1 }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as { results: Array<{ location: string }> };
      expect(v.results[0].location).toMatch(/a\.ts/);
    }
  });
});

describe('/index command parsing', () => {
  const skills: CodingSkillDefinition[] = [];
  it('parses /index as index_build and /index status as index_status', () => {
    expect(handleSlashCommand('/index', skills).kind).toBe('index_build');
    expect(handleSlashCommand('/index status', skills).kind).toBe('index_status');
  });
});
