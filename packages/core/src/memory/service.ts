import {
  MemoryEdgeInputSchema,
  MemoryNodeInputSchema,
} from './schemas.js';
import { formatMemoryContext } from './context.js';
import {
  clampUnit,
  DefaultMemorySanitizer,
  memorySimilarity,
  normalizedMemoryKey,
  normalizeTags,
  sanitizeMemoryMetadata,
} from './policies.js';
import { rankMemoryCandidates } from './scoring.js';
import { SemanticMemoryController } from './semantic.js';
import type {
  CognitiveMemoryBackend,
  ConsolidationRequest,
  ConsolidationResult,
  EdgeQuery,
  LinkMemoryInput,
  MemoryCandidate,
  MemoryContext,
  MemoryContextRequest,
  MemoryDoctorResult,
  MemoryEdge,
  MemoryEvent,
  MemoryEventSink,
  MemoryEmbeddingProvider,
  MemoryExport,
  MemoryIndexRequest,
  MemoryIndexResult,
  MemoryNode,
  MemorySanitizer,
  MemoryService,
  MemorySource,
  MemoryStats,
  MemoryVersion,
  RecallQuery,
  RecallResult,
  RememberInput,
} from './types.js';

export class MemoryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryPolicyError';
  }
}

export interface DefaultMemoryServiceOptions {
  sanitizer?: MemorySanitizer;
  onEvent?: MemoryEventSink;
  now?: () => Date;
  defaultContextChars?: number;
  /** Optional host-owned embedder. Omitting it leaves retrieval lexical. */
  embeddingProvider?: MemoryEmbeddingProvider;
  lazySemanticIndexLimit?: number;
  minSemanticRelevance?: number;
}

function id(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function sourceHasProvenance(source: Record<string, unknown>): boolean {
  return Object.values(source).some((value) => typeof value === 'string' && value.length > 0);
}

function sanitizeSource(source: MemorySource, sanitizer: MemorySanitizer): MemorySource {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => {
      const cleaned = sanitizer.sanitize(value);
      return [key, cleaned.rejected ? '[REDACTED]' : cleaned.content];
    }),
  ) as MemorySource;
}

function diverse(results: RecallResult[], limit: number): RecallResult[] {
  const selected: RecallResult[] = [];
  for (const result of results) {
    if (selected.some((prior) => memorySimilarity(prior.node.content, result.node.content) >= 0.9)) {
      continue;
    }
    selected.push(result);
    if (selected.length >= limit) break;
  }
  return selected;
}

export class DefaultMemoryService implements MemoryService {
  readonly projectId: string;
  private readonly sanitizer: MemorySanitizer;
  private readonly onEvent?: MemoryEventSink;
  private readonly now: () => Date;
  private readonly defaultContextChars: number;
  private readonly semantic?: SemanticMemoryController;

  constructor(
    projectId: string,
    private readonly backend: CognitiveMemoryBackend,
    options: DefaultMemoryServiceOptions = {},
  ) {
    if (!projectId.trim()) throw new Error('MemoryService requires a projectId.');
    this.projectId = projectId;
    this.sanitizer = options.sanitizer ?? new DefaultMemorySanitizer();
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => new Date());
    this.defaultContextChars = options.defaultContextChars ?? 2_000;
    if (options.embeddingProvider) {
      this.semantic = new SemanticMemoryController(projectId, backend, options.embeddingProvider, {
        now: this.now,
        lazyIndexLimit: options.lazySemanticIndexLimit,
        minRelevance: options.minSemanticRelevance,
        onFailure: (reason) => this.emit({ type: 'memory_error', reason: `semantic: ${reason}` }),
      });
    }
  }

  private emit(event: Omit<MemoryEvent, 'at'>): void {
    if (!this.onEvent) return;
    try {
      void Promise.resolve(this.onEvent({ ...event, at: this.now().toISOString() }))
        .catch(() => undefined);
    } catch {
      // Memory telemetry is advisory and contains no memory content.
    }
  }

  async remember(raw: RememberInput): Promise<MemoryNode> {
    const parsed = MemoryNodeInputSchema.parse(raw);
    if (parsed.projectId && parsed.projectId !== this.projectId) {
      throw new MemoryPolicyError('Memory project scope does not match the active project.');
    }
    const sanitized = this.sanitizer.sanitize(parsed.content);
    if (sanitized.rejected) {
      this.emit({ type: 'memory_error', reason: sanitized.reason ?? 'secret rejected' });
      throw new MemoryPolicyError(sanitized.reason ?? 'Memory content was rejected by policy.');
    }
    if (!sanitized.content) throw new MemoryPolicyError('Empty memory content is not persisted.');

    const rawSource = sourceHasProvenance(parsed.source ?? {})
      ? (parsed.source ?? {})
      : { agent: 'unknown' };
    const source = sanitizeSource(rawSource, this.sanitizer);
    const visibility = parsed.visibility ?? 'project';
    let confidence = clampUnit(parsed.confidence, parsed.kind === 'hypothesis' ? 0.4 : 0.7);
    if (source.agent === 'unknown') confidence = Math.min(confidence, 0.5);
    const metadata = {
      ...sanitizeMemoryMetadata(parsed.metadata, this.sanitizer),
      writeClass: parsed.writeClass ?? 'manual',
      ...(sanitized.redactions.length > 0
        ? { secretRedactions: sanitized.redactions }
        : {}),
    };
    const tags = normalizeTags(parsed.tags);

    // Idempotent exact-content dedupe within kind/project. Stronger evidence
    // upgrades the existing node and is itself preserved as a new version.
    const exactKey = normalizedMemoryKey(sanitized.content);
    const possible = await this.backend.search({
      text: sanitized.content,
      projectId: this.projectId,
      kinds: [parsed.kind],
      statuses: ['active'],
      visibilities: [visibility],
      limit: 32,
    });
    const duplicate = possible.find(
      ({ node }) => normalizedMemoryKey(node.content) === exactKey &&
        (visibility === 'project' || node.source.client === source.client),
    )?.node;
    if (duplicate) {
      const mergedTags = normalizeTags([...duplicate.tags, ...tags]);
      const shouldUpdate =
        confidence > duplicate.confidence ||
        clampUnit(parsed.importance, 0.5) > duplicate.importance ||
        mergedTags.length !== duplicate.tags.length ||
        sanitized.redactions.length > 0;
      if (!shouldUpdate) return duplicate;
      const updated = await this.backend.update(duplicate.id, {
        confidence: Math.max(duplicate.confidence, confidence),
        importance: Math.max(duplicate.importance, clampUnit(parsed.importance, 0.5)),
        tags: mergedTags,
        source,
        metadata: { ...duplicate.metadata, ...metadata },
        actor: source.agent,
        reason: 'deduplicated stronger evidence',
      });
      this.emit({ type: 'memory_write', memoryId: updated.id, reason: 'deduplicated' });
      return updated;
    }

    const node = await this.backend.add({
      ...(parsed.id ? { id: parsed.id } : { id: id('mem') }),
      projectId: this.projectId,
      kind: parsed.kind,
      content: sanitized.content,
      importance: clampUnit(parsed.importance, 0.5),
      confidence,
      status: parsed.status ?? 'active',
      visibility,
      tags,
      source,
      ...(parsed.createdAt ? { createdAt: parsed.createdAt } : {}),
      ...(parsed.recordedAt ? { recordedAt: parsed.recordedAt } : {}),
      ...(parsed.validFrom ? { validFrom: parsed.validFrom } : {}),
      ...(parsed.validUntil ? { validUntil: parsed.validUntil } : {}),
      ...(parsed.embeddingRef ? { embeddingRef: parsed.embeddingRef } : {}),
      metadata,
    });
    this.emit({ type: 'memory_write', memoryId: node.id });
    return node;
  }

  async get(memoryId: string): Promise<MemoryNode | null> {
    const node = await this.backend.get(memoryId);
    return node?.projectId === this.projectId ? node : null;
  }

  async recall(raw: RecallQuery): Promise<RecallResult[]> {
    const started = Date.now();
    const text = (raw.query ?? raw.text ?? '').slice(0, 64_000);
    const limit = Math.max(1, Math.min(raw.limit ?? 8, 100));
    this.emit({ type: 'memory_recall_start' });
    const candidates = await this.backend.search({
      ...raw,
      text,
      projectId: this.projectId,
      statuses:
        raw.statuses ??
        (raw.includeHistorical ? undefined : ['active']),
      limit: Math.max(limit, raw.useGraph ? Math.min(100, limit * 3) : limit),
    });
    const byId = new Map<string, MemoryCandidate>();
    for (const candidate of candidates) {
      if (
        candidate.node.projectId === this.projectId &&
        (!raw.externalClient ||
          candidate.node.visibility === 'project' ||
          candidate.node.source.client === raw.externalClient)
      ) byId.set(candidate.node.id, candidate);
    }
    if (this.semantic) {
      const semantic = await this.semantic.search({
        ...raw,
        text,
        projectId: this.projectId,
        statuses: raw.statuses ?? (raw.includeHistorical ? undefined : ['active']),
        limit: Math.max(limit, Math.min(100, limit * 3)),
      }, text);
      for (const candidate of semantic) {
        if (
          candidate.node.projectId !== this.projectId ||
          (raw.externalClient && candidate.node.visibility === 'private' &&
            candidate.node.source.client !== raw.externalClient)
        ) continue;
        const prior = byId.get(candidate.node.id);
        byId.set(candidate.node.id, prior
          ? {
              ...prior,
              semanticRelevance: Math.max(
                prior.semanticRelevance ?? 0,
                candidate.semanticRelevance ?? 0,
              ),
            }
          : candidate);
      }
    }
    if (raw.useGraph) {
      for (const seed of [...byId.values()].slice(0, Math.min(12, limit))) {
        const links = await this.backend.edges(seed.node.id, { direction: 'both', limit: 24 });
        for (const edge of links) {
          const otherId = edge.from === seed.node.id ? edge.to : edge.from;
          if (byId.has(otherId)) continue;
          const node = await this.backend.get(otherId);
          if (!node || node.projectId !== this.projectId) continue;
          if (raw.externalClient && node.visibility === 'private' && node.source.client !== raw.externalClient) continue;
          if (!raw.includeHistorical && node.status !== 'active') continue;
          byId.set(otherId, { node, graphProximity: 0.75 });
        }
      }
    }
    const ranked = diverse(rankMemoryCandidates([...byId.values()], text), limit);
    this.emit({
      type: 'memory_recall_end',
      durationMs: Date.now() - started,
      candidateCount: byId.size,
      returnedCount: ranked.length,
    });
    return ranked;
  }

  async connect(raw: LinkMemoryInput): Promise<MemoryEdge> {
    const parsed = MemoryEdgeInputSchema.parse(raw);
    const creator = parsed.createdBy
      ? this.sanitizer.sanitize(parsed.createdBy)
      : undefined;
    const input = {
      ...parsed,
      ...(creator
        ? { createdBy: creator.rejected ? '[REDACTED]' : creator.content }
        : {}),
      metadata: sanitizeMemoryMetadata(parsed.metadata, this.sanitizer),
    };
    if (input.from === input.to) throw new MemoryPolicyError('A memory cannot link to itself.');
    const [from, to] = await Promise.all([this.get(input.from), this.get(input.to)]);
    if (!from || !to) throw new MemoryPolicyError('Both relation endpoints must exist in this project.');
    const edge = await this.backend.addEdge(input);
    if (edge.relation === 'supersedes' && to.status === 'active') {
      await this.backend.update(to.id, {
        status: 'superseded',
        actor: edge.createdBy,
        reason: `superseded by ${from.id}`,
        metadata: { ...to.metadata, supersededBy: from.id },
      });
    } else if (edge.relation === 'validated_by') {
      await this.backend.update(from.id, {
        confidence: Math.max(from.confidence, 0.95),
        actor: edge.createdBy,
        reason: `validated by ${to.id}`,
        metadata: { ...from.metadata, verified: true, validatedBy: to.id },
      });
    } else if (edge.relation === 'invalidated_by') {
      await this.backend.retract(from.id, `invalidated by ${to.id}`, edge.createdBy);
    }
    this.emit({ type: 'memory_link', memoryId: edge.from, reason: edge.relation });
    return edge;
  }

  async related(memoryId: string, options?: EdgeQuery): Promise<Array<{ edge: MemoryEdge; node: MemoryNode }>> {
    if (!(await this.get(memoryId))) return [];
    const edges = await this.backend.edges(memoryId, options);
    const output: Array<{ edge: MemoryEdge; node: MemoryNode }> = [];
    for (const edge of edges) {
      const other = await this.get(edge.from === memoryId ? edge.to : edge.from);
      if (other) output.push({ edge, node: other });
    }
    return output;
  }

  async history(memoryId: string): Promise<MemoryVersion[]> {
    return (await this.get(memoryId)) ? this.backend.history(memoryId) : [];
  }

  async getAt(memoryId: string, timestamp: string): Promise<MemoryNode | null> {
    const direct = await this.backend.getAt?.(memoryId, timestamp);
    if (direct) return direct.projectId === this.projectId ? direct : null;
    const at = Date.parse(timestamp);
    const versions = await this.history(memoryId);
    return [...versions]
      .reverse()
      .find((version) => Date.parse(version.recordedAt) <= at)?.snapshot ?? null;
  }

  async retract(memoryId: string, reason?: string): Promise<void> {
    if (!(await this.get(memoryId))) throw new MemoryPolicyError(`Memory ${memoryId} was not found.`);
    await this.backend.retract(memoryId, reason, 'user');
    this.emit({ type: 'memory_retract', memoryId, reason });
  }

  async forget(memoryId: string): Promise<boolean> {
    if (!(await this.get(memoryId))) return false;
    if (!this.backend.delete) {
      throw new MemoryPolicyError('The active backend does not support hard deletion; retract instead.');
    }
    return this.backend.delete(memoryId);
  }

  async buildContext(input: MemoryContextRequest): Promise<MemoryContext> {
    const requestedChars = input.maxChars ?? this.defaultContextChars;
    const maxChars = Number.isFinite(requestedChars)
      ? Math.max(0, Math.min(Math.floor(requestedChars), 64_000))
      : this.defaultContextChars;
    const maxMemories = Math.max(1, Math.min(input.maxMemories ?? 8, 50));
    const recalled = await this.recall({
      ...input,
      limit: Math.max(maxMemories, input.candidateLimit ?? maxMemories * 4),
    });
    const context = formatMemoryContext(recalled, { maxChars, maxMemories });
    this.emit({
      type: 'memory_recall_end',
      returnedCount: context.memories.length,
      contextChars: context.usedChars,
      reason: 'context-built',
    });
    return context;
  }

  async consolidate(input: ConsolidationRequest = {}): Promise<ConsolidationResult> {
    this.emit({ type: 'memory_consolidate_start' });
    const memoryIds = input.memoryIds?.slice(0, 500);
    const sourceNodes = memoryIds?.length
      ? (await Promise.all(memoryIds.map((memoryId) => this.get(memoryId)))).filter(
          (node): node is MemoryNode => Boolean(node),
        )
      : (
          await this.backend.search({
            text: (input.query ?? '').slice(0, 64_000),
            projectId: this.projectId,
            statuses: ['active'],
            limit: 500,
          })
        ).map(({ node }) => node);
    const candidates = sourceNodes.filter(
      (node) =>
        node.metadata.writeClass === 'candidate' ||
        ['episode', 'finding', 'hypothesis', 'failure'].includes(node.kind),
    );
    const groups: MemoryNode[][] = [];
    for (const node of candidates) {
      const group = groups.find((items) => memorySimilarity(items[0]!.content, node.content) >= 0.86);
      if (group) group.push(node);
      else groups.push([node]);
    }
    const min = Math.max(2, input.minOccurrences ?? 2);
    const consolidationSource = sanitizeSource(input.source ?? {}, this.sanitizer);
    const consolidationActor = consolidationSource.agent ?? 'memory-consolidator';
    const created: MemoryNode[] = [];
    const archivedSourceIds: string[] = [];
    for (const group of groups.filter((items) => items.length >= min)) {
      const representative = [...group].sort(
        (a, b) => b.confidence - a.confidence || b.importance - a.importance,
      )[0]!;
      const consolidated = await this.backend.update(representative.id, {
        kind: representative.kind === 'failure' ? 'procedure' : 'fact',
        confidence: Math.max(...group.map((node) => node.confidence)),
        importance: Math.max(...group.map((node) => node.importance)),
        metadata: {
          ...representative.metadata,
          writeClass: 'auto',
          consolidated: true,
          consolidatedFrom: group.map((node) => node.id),
        },
        source: { ...representative.source, ...consolidationSource },
        actor: consolidationActor,
        reason: `consolidated ${group.length} related memories`,
      });
      created.push(consolidated);
      for (const source of group) {
        if (source.id === consolidated.id) continue;
        await this.connect({
          from: consolidated.id,
          to: source.id,
          relation: 'derived_from',
          createdBy: consolidationActor,
        });
        if (input.archiveSources !== false) {
          await this.backend.update(source.id, {
            status: 'archived',
            actor: consolidationActor,
            reason: `consolidated into ${consolidated.id}`,
          });
          archivedSourceIds.push(source.id);
        }
      }
    }
    const result = {
      scanned: candidates.length,
      groups: created.length,
      created,
      archivedSourceIds,
    };
    this.emit({
      type: 'memory_consolidate_end',
      candidateCount: candidates.length,
      returnedCount: created.length,
    });
    return result;
  }

  async index(input: MemoryIndexRequest = {}): Promise<MemoryIndexResult> {
    return this.semantic?.index(input) ?? {
      status: 'disabled', scanned: 0, indexed: 0, skipped: 0,
      failed: 0, interrupted: false,
    };
  }

  async stats(): Promise<MemoryStats> {
    if (this.backend.stats) {
      const stats = await this.backend.stats();
      if (!this.semantic) return { ...stats, semanticIndex: 'disabled' };
      const semantic = await this.semantic.status();
      return {
        ...stats,
        semanticIndex: semantic.state,
        ...(semantic.model ? { semanticModel: semantic.model } : {}),
        semanticIndexed: semantic.indexed,
        semanticStale: semantic.stale,
      };
    }
    const nodes = (await this.backend.search({
      projectId: this.projectId,
      includeHistorical: true,
      limit: 100_000,
    })).map(({ node }) => node);
    const count = (status: MemoryNode['status']) => nodes.filter((node) => node.status === status).length;
    return {
      backend: 'custom',
      schemaVersion: 1,
      nodes: nodes.length,
      edges: 0,
      active: count('active'),
      superseded: count('superseded'),
      retracted: count('retracted'),
      archived: count('archived'),
      unconsolidatedCandidates: nodes.filter((node) => node.metadata.writeClass === 'candidate').length,
      semanticIndex: 'disabled',
    };
  }

  async doctor(): Promise<MemoryDoctorResult> {
    const base = await (this.backend.doctor?.() ?? Promise.resolve({
      ok: true,
      backend: 'custom',
      checks: [{ name: 'backend', ok: true, detail: 'No diagnostic API exposed.' }],
    }));
    if (!this.semantic) return base;
    const semantic = await this.semantic.status();
    return {
      ...base,
      checks: [
        ...base.checks,
        {
          name: 'semantic',
          ok: semantic.state !== 'degraded',
          detail: semantic.detail ?? `${semantic.model ?? 'unknown model'}: ${semantic.indexed} indexed, ${semantic.stale} stale`,
        },
      ],
    };
  }

  async export(): Promise<MemoryExport> {
    if (this.backend.export) return this.backend.export(this.projectId);
    const nodes = (await this.backend.search({
      projectId: this.projectId,
      includeHistorical: true,
      limit: 100_000,
    })).map(({ node }) => node);
    const edges = new Map<string, MemoryEdge>();
    const versions: MemoryVersion[] = [];
    for (const node of nodes) {
      for (const edge of await this.backend.edges(node.id, { direction: 'out', limit: 100_000 })) {
        edges.set(edge.id, edge);
      }
      versions.push(...(await this.backend.history(node.id)));
    }
    return {
      schemaVersion: 1,
      exportedAt: this.now().toISOString(),
      projectId: this.projectId,
      nodes,
      edges: [...edges.values()],
      versions,
    };
  }

  async close(): Promise<void> {
    await this.backend.close?.();
  }
}
