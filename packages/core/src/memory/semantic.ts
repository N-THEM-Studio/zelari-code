import type {
  CognitiveMemoryBackend,
  MemoryCandidate,
  MemoryEmbeddingProvider,
  MemoryEmbeddingRecord,
  MemoryIndexRequest,
  MemoryIndexResult,
  MemoryQuery,
  MemorySemanticStatus,
} from './types.js';

function bounded(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value!), max));
}

function validVector(vector: unknown): vector is number[] {
  return Array.isArray(vector) && vector.length > 0 && vector.length <= 65_536 &&
    vector.every((value) => typeof value === 'number' && Number.isFinite(value));
}

export interface SemanticMemoryControllerOptions {
  now?: () => Date;
  lazyIndexLimit?: number;
  minRelevance?: number;
  onFailure?: (reason: string) => void;
}

/**
 * Optional semantic orchestration. Persistence and embedding generation stay
 * behind injected seams, keeping the core dependency-light and lexical-safe.
 */
export class SemanticMemoryController {
  private readonly now: () => Date;
  private readonly lazyIndexLimit: number;
  private readonly onFailure?: (reason: string) => void;
  private readonly minRelevance: number;

  constructor(
    private readonly projectId: string,
    private readonly backend: CognitiveMemoryBackend,
    private readonly provider: MemoryEmbeddingProvider,
    options: SemanticMemoryControllerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.lazyIndexLimit = bounded(options.lazyIndexLimit, 32, 256);
    this.minRelevance = Math.max(0, Math.min(options.minRelevance ?? 0.15, 1));
    this.onFailure = options.onFailure;
  }

  get model(): string { return this.provider.model; }

  get available(): boolean {
    return Boolean(
      this.backend.listSemanticSources &&
      this.backend.upsertSemanticEmbeddings &&
      this.backend.semanticSearch,
    );
  }

  async index(input: MemoryIndexRequest = {}): Promise<MemoryIndexResult> {
    if (!this.available) return this.disabled('backend has no semantic index capability');
    if (input.signal?.aborted) return this.interrupted();
    const limit = bounded(input.limit, 1_000, 100_000);
    const batchSize = bounded(input.batchSize, 32, 256);
    let indexed = 0;
    let scanned = 0;
    let cursor: string | undefined;
    while (scanned < limit) {
      let sources;
      try {
        sources = await this.backend.listSemanticSources!(this.projectId, this.model, {
          force: input.force,
          limit: Math.min(limit - scanned, Math.max(batchSize, 512)),
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        return this.degraded(error, scanned, indexed);
      }
      if (sources.length === 0) break;
      scanned += sources.length;
      cursor = sources.at(-1)!.node.id;
      for (let offset = 0; offset < sources.length; offset += batchSize) {
        if (input.signal?.aborted) {
          return {
            status: 'degraded', model: this.model, scanned,
            indexed, skipped: 0, failed: 0, interrupted: true,
          };
        }
        const batch = sources.slice(offset, offset + batchSize);
        let embedded: number[][] | { error: string };
        try {
          embedded = await this.provider.embed(batch.map(({ node }) => node.content));
        } catch (error) {
          return this.degraded(error, scanned, indexed, batch.length);
        }
        if ('error' in embedded) {
          return this.degraded(embedded.error, scanned, indexed, batch.length);
        }
        if (embedded.length !== batch.length || !embedded.every(validVector)) {
          return this.degraded('embedding provider returned invalid vectors', scanned, indexed, batch.length);
        }
        const dimensions = embedded[0]!.length;
        if (!embedded.every((vector) => vector.length === dimensions)) {
          return this.degraded('embedding dimensions differ within one batch', scanned, indexed, batch.length);
        }
        const at = this.now().toISOString();
        const records: MemoryEmbeddingRecord[] = batch.map((source, index) => ({
          memoryId: source.node.id,
          projectId: this.projectId,
          model: this.model,
          contentHash: source.contentHash,
          vector: embedded[index]!,
          indexedAt: at,
        }));
        try {
          await this.backend.upsertSemanticEmbeddings!(records);
        } catch (error) {
          return this.degraded(error, scanned, indexed, batch.length);
        }
        indexed += records.length;
      }
    }
    return {
      status: 'ready', model: this.model, scanned,
      indexed, skipped: 0, failed: 0, interrupted: false,
    };
  }

  async search(query: MemoryQuery, text: string): Promise<MemoryCandidate[]> {
    if (!this.available || !text.trim() || query.asOf) return [];
    // A small synchronous lazy pass makes fresh memories searchable without a
    // mandatory background daemon. Large rebuilds remain explicit/interruptible.
    const indexed = await this.index({ limit: this.lazyIndexLimit });
    if (indexed.status === 'degraded') this.onFailure?.(indexed.error ?? 'semantic indexing degraded');
    let result: number[][] | { error: string };
    try { result = await this.provider.embed([text]); }
    catch (error) { this.onFailure?.(String(error)); return []; }
    if ('error' in result) { this.onFailure?.(result.error); return []; }
    const vector = result[0];
    if (!validVector(vector)) { this.onFailure?.('invalid semantic query vector'); return []; }
    try {
      return (await this.backend.semanticSearch!(query, vector, this.model))
        .filter((candidate) => (candidate.semanticRelevance ?? 0) >= this.minRelevance);
    } catch (error) {
      this.onFailure?.(error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  async status(): Promise<MemorySemanticStatus> {
    if (!this.available || !this.backend.semanticStatus) {
      return { state: 'disabled', model: this.model, indexed: 0, stale: 0 };
    }
    try { return await this.backend.semanticStatus(this.projectId, this.model); }
    catch (error) {
      return {
        state: 'degraded', model: this.model, indexed: 0, stale: 0,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private disabled(error: string): MemoryIndexResult {
    return {
      status: 'disabled', model: this.model, scanned: 0, indexed: 0,
      skipped: 0, failed: 0, interrupted: false, error,
    };
  }

  private interrupted(): MemoryIndexResult {
    return {
      status: 'degraded', model: this.model, scanned: 0, indexed: 0,
      skipped: 0, failed: 0, interrupted: true,
    };
  }

  private degraded(
    error: unknown,
    scanned = 0,
    indexed = 0,
    failed = 0,
  ): MemoryIndexResult {
    const detail = error instanceof Error ? error.message : String(error);
    this.onFailure?.(detail);
    return {
      status: 'degraded', model: this.model, scanned, indexed, skipped: 0,
      failed, interrupted: false, error: detail,
    };
  }
}
