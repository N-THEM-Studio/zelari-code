/**
 * File-backed keyword memory — the v1.0 `MemoryBackend` implementation.
 *
 * Zero external dependencies: a per-project JSONL append log plus a keyword
 * (token-overlap) search. No embeddings, no vector store, no native modules.
 * This is deliberately a seam, not a semantic engine — a future
 * `@zelari/memory` (LanceDB/embeddings) can replace it behind the same
 * `MemoryBackend` interface without touching callers.
 *
 * Storage: `<projectRoot>/.zelari/memory/log.jsonl` (one fact per line).
 * Disable entirely with `ZELARI_MEMORY=0` (factory returns a no-op backend).
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  MemoryAddGraph,
  MemoryBackend,
  MemoryResult,
  MemorySearchOptions,
} from '@zelari/core';

interface StoredFact {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  graph?: MemoryAddGraph;
  createdAt: string;
}

/** Lowercase, split on non-alphanumerics (unicode letters kept), drop stop-length tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
}

/** Every provided filter key must be present and shallow-equal in metadata. */
function matchesFilter(
  metadata: Record<string, unknown>,
  filter?: Record<string, unknown>,
): boolean {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (metadata[k] !== v) return false;
  }
  return true;
}

export class FileMemoryBackend implements MemoryBackend {
  private logPath = '';
  private memoryDir = '';

  async init(projectRoot: string): Promise<void> {
    this.memoryDir = path.join(projectRoot, '.zelari', 'memory');
    this.logPath = path.join(this.memoryDir, 'log.jsonl');
    await fs.mkdir(this.memoryDir, { recursive: true });
  }

  async add(
    content: string,
    metadata: Record<string, unknown> = {},
    graph?: MemoryAddGraph,
  ): Promise<string> {
    const fact: StoredFact = {
      id: randomUUID(),
      content,
      metadata,
      ...(graph ? { graph } : {}),
      createdAt: new Date().toISOString(),
    };
    await fs.appendFile(this.logPath, JSON.stringify(fact) + '\n', 'utf8');
    return fact.id;
  }

  async search(query: string, options: MemorySearchOptions = {}): Promise<MemoryResult[]> {
    const limit = options.limit ?? 8;
    const facts = await this.readAll();
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return [];

    const scored: MemoryResult[] = [];
    for (const fact of facts) {
      if (!matchesFilter(fact.metadata, options.metadataFilter)) continue;
      const contentTokens = new Set(tokenize(fact.content));
      let score = 0;
      for (const t of queryTokens) {
        if (contentTokens.has(t)) score += 1;
      }
      if (score > 0) {
        scored.push({ id: fact.id, text: fact.content, score, metadata: fact.metadata });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async close(): Promise<void> {
    // Nothing to release — appends are fire-and-forget.
  }

  private async readAll(): Promise<StoredFact[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.logPath, 'utf8');
    } catch {
      return []; // no log yet
    }
    const facts: StoredFact[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        facts.push(JSON.parse(trimmed) as StoredFact);
      } catch {
        // skip a corrupt line rather than fail the whole search
      }
    }
    return facts;
  }
}

/** No-op backend used when `ZELARI_MEMORY=0`. */
export class NoopMemoryBackend implements MemoryBackend {
  async init(): Promise<void> {}
  async add(): Promise<string> {
    return '';
  }
  async search(): Promise<MemoryResult[]> {
    return [];
  }
  async close(): Promise<void> {}
}

/** True unless memory has been explicitly disabled. */
export function isMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZELARI_MEMORY !== '0';
}

/**
 * Resolve and initialise the memory backend for a project. Returns a no-op
 * backend (never throws) when disabled or when initialisation fails, so callers
 * can always `await memory.search(...)` without guarding.
 */
export async function getMemoryBackend(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryBackend> {
  if (!isMemoryEnabled(env)) return new NoopMemoryBackend();
  const backend = new FileMemoryBackend();
  try {
    await backend.init(projectRoot);
    return backend;
  } catch {
    return new NoopMemoryBackend();
  }
}

/** Max chars per memory hit line (keeps RAG from rehydrating giant synthesis dumps). */
const MEMORY_HIT_MAX_CHARS = 400;

/** Render memory hits as a compact RAG block for the council `ragContext`. */
export function formatMemoryHits(hits: MemoryResult[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map((h, i) => {
    let t = h.text.replace(/\s+/g, ' ').trim();
    if (t.length > MEMORY_HIT_MAX_CHARS) {
      t = t.slice(0, MEMORY_HIT_MAX_CHARS) + '…';
    }
    return `${i + 1}. ${t}`;
  });
  return (
    `## Recalled from project memory (hypotheses — verify on disk)\n` +
    lines.join('\n')
  );
}
