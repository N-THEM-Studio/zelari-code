/**
 * semantic/store — the pure core of the semantic code index.
 *
 * Chunk source files into overlapping line windows, hold each chunk's
 * embedding vector, and rank chunks against a query vector by cosine
 * similarity. No I/O, no embeddings API — those live in embeddings.ts /
 * index.ts — so all of this is deterministic and unit-testable.
 *
 * Persistence is a plain JSON file (no native vector DB): fine for
 * repo-scale indexes (thousands of chunks) with a brute-force cosine scan.
 */

export interface CodeChunk {
  file: string;
  /** 1-based first line of the chunk. */
  startLine: number;
  /** 1-based last line of the chunk. */
  endLine: number;
  text: string;
}

export interface IndexedChunk extends CodeChunk {
  embedding: number[];
}

export interface SearchHit extends CodeChunk {
  score: number;
}

export interface SemanticIndexData {
  /** Embedding model used — a query must be embedded with the same model. */
  model: string;
  /** Vector dimensionality (sanity check for cosine). */
  dim: number;
  chunks: IndexedChunk[];
  /** Epoch ms the index was built. */
  builtAt: number;
}

export interface ChunkOptions {
  /** Lines per chunk (default 40). */
  maxLines?: number;
  /** Overlapping lines between consecutive chunks (default 8). */
  overlap?: number;
}

/**
 * Split a file's text into overlapping line-window chunks. Blank-only chunks
 * are dropped. Overlap keeps a symbol that straddles a boundary retrievable
 * from either side.
 */
export function chunkFile(file: string, text: string, opts: ChunkOptions = {}): CodeChunk[] {
  const maxLines = Math.max(1, opts.maxLines ?? 40);
  const overlap = Math.max(0, Math.min(opts.overlap ?? 8, maxLines - 1));
  const lines = text.split('\n');
  const step = maxLines - overlap;
  const chunks: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + maxLines, lines.length);
    const slice = lines.slice(start, end);
    if (slice.join('').trim().length > 0) {
      chunks.push({
        file,
        startLine: start + 1,
        endLine: end,
        text: slice.join('\n'),
      });
    }
    if (end >= lines.length) break;
  }
  return chunks;
}

/** Cosine similarity of two equal-length vectors. Returns 0 on mismatch/zero. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Rank indexed chunks against a query embedding, returning the top-k hits. */
export function searchIndex(
  data: SemanticIndexData,
  queryEmbedding: readonly number[],
  k = 8,
): SearchHit[] {
  const scored: SearchHit[] = [];
  for (const chunk of data.chunks) {
    const score = cosineSimilarity(queryEmbedding, chunk.embedding);
    scored.push({
      file: chunk.file,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}
