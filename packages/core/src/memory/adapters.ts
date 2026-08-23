import { DefaultMemorySanitizer, normalizeTags } from './policies.js';
import { rankMemoryCandidates } from './scoring.js';
import type {
  EdgeQuery,
  MemoryAddGraph,
  MemoryBackend,
  MemoryContext,
  MemoryContextRequest,
  MemoryDoctorResult,
  MemoryEdge,
  MemoryExport,
  MemoryNode,
  MemoryResult,
  MemorySearchOptions,
  MemoryService,
  MemoryStats,
  MemoryVersion,
  RecallQuery,
  RecallResult,
  RememberInput,
} from './types.js';

function legacyKind(value: unknown): MemoryNode['kind'] {
  const kinds: MemoryNode['kind'][] = [
    'fact', 'decision', 'episode', 'hypothesis', 'outcome', 'constraint',
    'preference', 'finding', 'failure', 'verification', 'artifact', 'procedure',
  ];
  return kinds.includes(value as MemoryNode['kind']) ? (value as MemoryNode['kind']) : 'finding';
}

/** Present a V2 service through the original chunk interface. */
export class LegacyMemoryBackendAdapter implements MemoryBackend {
  constructor(readonly service: MemoryService) {}
  async init(): Promise<void> {}

  async add(
    content: string,
    metadata: Record<string, unknown> = {},
    graph?: MemoryAddGraph,
  ): Promise<string> {
    const source = {
      ...(typeof metadata.source === 'string' ? { agent: metadata.source } : {}),
      ...(typeof metadata.sessionId === 'string' ? { sessionId: metadata.sessionId } : {}),
      ...(typeof metadata.missionId === 'string' ? { missionId: metadata.missionId } : {}),
      ...(typeof metadata.sliceId === 'string' ? { sliceId: metadata.sliceId } : {}),
      ...(typeof metadata.tentacleId === 'string' ? { tentacleId: metadata.tentacleId } : {}),
    };
    const node = await this.service.remember({
      kind: legacyKind(metadata.memoryKind ?? (metadata.completionOk ? 'outcome' : 'finding')),
      content,
      importance: typeof metadata.importance === 'number' ? metadata.importance : 0.6,
      confidence: typeof metadata.confidence === 'number' ? metadata.confidence : 0.7,
      source,
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      metadata: { ...metadata, ...(graph ? { legacyGraph: graph } : {}) },
      writeClass: metadata.writeClass === 'candidate' ? 'candidate' : 'auto',
    });
    return node.id;
  }

  async search(query: string, options: MemorySearchOptions = {}): Promise<MemoryResult[]> {
    const wanted = options.metadataFilter;
    const hits = await this.service.recall({
      text: query,
      limit: Math.max(options.limit ?? 8, wanted ? 100 : options.limit ?? 8),
      useGraph: options.useGraph,
    });
    return hits
      .filter(({ node }) =>
        !wanted || Object.entries(wanted).every(([key, value]) => node.metadata[key] === value),
      )
      .slice(0, options.limit ?? 8)
      .map(({ node, score }) => ({
        id: node.id,
        text: node.content,
        score,
        metadata: {
          ...node.metadata,
          memoryKind: node.kind,
          importance: node.importance,
          confidence: node.confidence,
          status: node.status,
        },
      }));
  }

  async close(): Promise<void> {
    await this.service.close();
  }
}

/** Minimal reverse adapter for hosts that only have a V1 backend. */
export class LegacyMemoryServiceAdapter implements MemoryService {
  readonly projectId: string;
  private readonly sanitizer = new DefaultMemorySanitizer();
  constructor(projectId: string, private readonly backend: MemoryBackend) {
    this.projectId = projectId;
  }

  async remember(input: RememberInput): Promise<MemoryNode> {
    const sanitized = this.sanitizer.sanitize(input.content);
    if (sanitized.rejected) throw new Error(sanitized.reason);
    const now = new Date().toISOString();
    const id = await this.backend.add(sanitized.content, {
      ...(input.metadata ?? {}),
      projectId: this.projectId,
      memoryKind: input.kind,
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.5,
      tags: normalizeTags(input.tags),
      source: input.source?.agent,
    });
    return {
      id,
      schemaVersion: 1,
      projectId: this.projectId,
      kind: input.kind,
      content: sanitized.content,
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.5,
      status: input.status ?? 'active',
      visibility: input.visibility ?? 'project',
      tags: normalizeTags(input.tags),
      source: input.source ?? { agent: 'legacy-adapter' },
      createdAt: now,
      updatedAt: now,
      recordedAt: now,
      metadata: input.metadata ?? {},
    };
  }

  async get(): Promise<MemoryNode | null> { return null; }
  async recall(query: RecallQuery): Promise<RecallResult[]> {
    const text = query.query ?? query.text ?? '';
    const hits = await this.backend.search(text, { limit: query.limit ?? 8 });
    const now = new Date().toISOString();
    return rankMemoryCandidates(hits.map((hit) => ({
      node: {
        id: hit.id,
        schemaVersion: 1 as const,
        projectId: this.projectId,
        kind: legacyKind(hit.metadata.memoryKind),
        content: hit.text,
        importance: typeof hit.metadata.importance === 'number' ? hit.metadata.importance : 0.5,
        confidence: typeof hit.metadata.confidence === 'number' ? hit.metadata.confidence : 0.5,
        status: 'active' as const,
        visibility: 'project' as const,
        tags: [],
        source: { agent: typeof hit.metadata.source === 'string' ? hit.metadata.source : 'legacy' },
        createdAt: now,
        updatedAt: now,
        recordedAt: now,
        metadata: hit.metadata,
      },
      lexicalRelevance: Math.min(1, hit.score),
    })), text);
  }
  async connect(): Promise<MemoryEdge> { throw new Error('Legacy memory has no graph support.'); }
  async related(): Promise<Array<{ edge: MemoryEdge; node: MemoryNode }>> { return []; }
  async history(): Promise<MemoryVersion[]> { return []; }
  async getAt(): Promise<MemoryNode | null> { return null; }
  async retract(): Promise<void> { throw new Error('Legacy memory has no retraction support.'); }
  async forget(): Promise<boolean> { return false; }
  async buildContext(input: MemoryContextRequest): Promise<MemoryContext> {
    const memories = await this.recall(input);
    const text = memories.map(({ node }) => `- ${node.content}`).join('\n');
    const budget = input.maxChars ?? 2_000;
    return { text: text.slice(0, budget), memories, usedChars: Math.min(text.length, budget), budgetChars: budget, truncated: text.length > budget };
  }
  async consolidate(): Promise<{ scanned: number; groups: number; created: MemoryNode[]; archivedSourceIds: string[] }> {
    return { scanned: 0, groups: 0, created: [], archivedSourceIds: [] };
  }
  async index(): Promise<import('./types.js').MemoryIndexResult> {
    return { status: 'disabled', scanned: 0, indexed: 0, skipped: 0, failed: 0, interrupted: false };
  }
  async stats(): Promise<MemoryStats> {
    return { backend: 'legacy-file', schemaVersion: 1, nodes: 0, edges: 0, active: 0, superseded: 0, retracted: 0, archived: 0, unconsolidatedCandidates: 0, semanticIndex: 'disabled' };
  }
  async doctor(): Promise<MemoryDoctorResult> {
    return { ok: true, backend: 'legacy-file', checks: [{ name: 'compatibility', ok: true, detail: 'V1 compatibility adapter active.' }] };
  }
  async export(): Promise<MemoryExport> {
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), projectId: this.projectId, nodes: [], edges: [], versions: [] };
  }
  async close(): Promise<void> { await this.backend.close(); }
}
