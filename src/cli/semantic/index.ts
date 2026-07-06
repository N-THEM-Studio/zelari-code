/**
 * semantic/index — build, persist, and query a repo's semantic code index.
 *
 * Orchestrates the pure store (chunk/cosine/rank) with an injectable embed
 * function. Persistence is a JSON file under the user's state dir, keyed by
 * repo root — no native vector DB, brute-force cosine, which is plenty for
 * repo-scale indexes.
 */

import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  chunkFile,
  searchIndex,
  type IndexedChunk,
  type SemanticIndexData,
  type SearchHit,
  type ChunkOptions,
} from './store.js';

/** Embed a batch of texts → vectors, or an error. Injected from embeddings.ts. */
export type EmbedFn = (texts: string[]) => Promise<number[][] | { error: string }>;

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.rb', '.php', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.kt',
  '.scala', '.sh', '.md',
]);
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next',
  '.turbo', '.cache', 'vendor', '__pycache__', '.venv', 'venv', '.tmp',
]);

export function getIndexPath(root: string): string {
  const hash = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);
  return (
    process.env.ZELARI_SEMANTIC_FILE ??
    path.join(homedir(), '.tmp', 'zelari-code', 'semantic', `${hash}.json`)
  );
}

/** Walk `root` collecting indexable source files (bounded by `maxFiles`). */
export async function collectSourceFiles(root: string, maxFiles = 1500): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= maxFiles) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.') {
        // Skip dotfiles/dotdirs except allow walking the root itself.
        if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
        if (entry.isDirectory()) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  await walk(root);
  return out;
}

export interface BuildOptions extends ChunkOptions {
  model: string;
  /** Files to embed per API call (default 64). */
  batchSize?: number;
  /** Skip a single chunk longer than this many chars (default 8000). */
  maxChunkChars?: number;
}

export interface BuildResult {
  data?: SemanticIndexData;
  error?: string;
  filesIndexed: number;
  chunksIndexed: number;
}

/**
 * Build an index over `files` using `embed`. Chunks are embedded in batches;
 * if any batch fails, the whole build fails (a partial index would give
 * misleading results).
 */
export async function buildIndex(
  files: string[],
  embed: EmbedFn,
  options: BuildOptions,
): Promise<BuildResult> {
  const batchSize = options.batchSize ?? 64;
  const maxChunkChars = options.maxChunkChars ?? 8000;
  const chunks: { file: string; startLine: number; endLine: number; text: string }[] = [];
  let filesIndexed = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const fileChunks = chunkFile(file, text, options).filter((c) => c.text.length <= maxChunkChars);
    if (fileChunks.length > 0) filesIndexed += 1;
    chunks.push(...fileChunks);
  }
  if (chunks.length === 0) {
    return { error: 'no indexable source found', filesIndexed: 0, chunksIndexed: 0 };
  }

  const indexed: IndexedChunk[] = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const res = await embed(batch.map((c) => c.text));
    if ('error' in res) {
      return { error: res.error, filesIndexed, chunksIndexed: 0 };
    }
    if (res.length !== batch.length) {
      return { error: 'embedding count mismatch', filesIndexed, chunksIndexed: 0 };
    }
    batch.forEach((c, j) => indexed.push({ ...c, embedding: res[j] }));
  }

  const data: SemanticIndexData = {
    model: options.model,
    dim: indexed[0]?.embedding.length ?? 0,
    chunks: indexed,
    builtAt: Date.now(),
  };
  return { data, filesIndexed, chunksIndexed: indexed.length };
}

/** Persist an index atomically. */
export async function saveIndex(root: string, data: SemanticIndexData): Promise<void> {
  const file = getIndexPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, file);
}

/** Load a persisted index (sync — used at query time). Null if missing/corrupt. */
export function loadIndex(root: string): SemanticIndexData | null {
  const file = getIndexPath(root);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SemanticIndexData;
    if (parsed && Array.isArray(parsed.chunks)) return parsed;
  } catch {
    /* corrupt */
  }
  return null;
}

/** Embed a query and rank the persisted index against it. */
export async function semanticSearch(
  root: string,
  query: string,
  embed: EmbedFn,
  k = 8,
): Promise<{ hits: SearchHit[] } | { error: string }> {
  const data = loadIndex(root);
  if (!data) return { error: 'no semantic index — run /index first' };
  const res = await embed([query]);
  if ('error' in res) return { error: res.error };
  const vector = res[0];
  if (!vector) return { error: 'query embedding failed' };
  return { hits: searchIndex(data, vector, k) };
}
