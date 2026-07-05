/**
 * Memory backend contract — provider-neutral, zero-dependency.
 *
 * The v1.0 implementation shipped by the CLI is a file-backed keyword store
 * (`FileMemoryBackend`, see `src/cli/memory/fileBackend.ts`). This interface
 * is deliberately shaped so a future semantic backend (LanceDB + embeddings,
 * or an MCP-backed palace) can be dropped in behind the same seam without
 * touching callers — the council loop only ever sees `MemoryBackend`.
 *
 * Only types live here, so `@zelari/core` stays dependency-free.
 */

export interface MemoryChunk {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface MemorySearchOptions {
  /** Max results to return. Default 8. */
  limit?: number;
  /**
   * Reserved for graph-aware backends (1-hop expansion). The file backend
   * ignores this flag; it is part of the contract so semantic/graph backends
   * can honour it later without an interface change.
   */
  useGraph?: boolean;
  /**
   * Shallow key/value match applied to each chunk's metadata. Only chunks
   * whose metadata contains every provided key with an equal value are kept.
   * Typically `{ projectRoot }` to keep projects isolated.
   */
  metadataFilter?: Record<string, unknown>;
}

export interface MemoryResult {
  id: string;
  text: string;
  /** Relevance score (backend-defined; higher is better). */
  score: number;
  metadata: Record<string, unknown>;
}

/** Optional graph payload accepted by `add` — stored/ignored per backend. */
export interface MemoryAddGraph {
  entities?: Array<{ name: string; type?: string }>;
  relations?: Array<{ from: string; to: string; type: string; weight?: number }>;
}

export interface MemoryBackend {
  /** Prepare storage for a project (create dirs, open handles, …). Idempotent. */
  init(projectRoot: string): Promise<void>;
  /** Persist a chunk of text with optional metadata/graph. Returns its id. */
  add(
    content: string,
    metadata?: Record<string, unknown>,
    graph?: MemoryAddGraph,
  ): Promise<string>;
  /** Retrieve the most relevant chunks for a query. */
  search(query: string, options?: MemorySearchOptions): Promise<MemoryResult[]>;
  /** Release any resources. Safe to call multiple times. */
  close(): Promise<void>;
}
