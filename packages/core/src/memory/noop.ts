import type {
  ConsolidationResult,
  EdgeQuery,
  LinkMemoryInput,
  MemoryContext,
  MemoryContextRequest,
  MemoryDoctorResult,
  MemoryEdge,
  MemoryExport,
  MemoryIndexRequest,
  MemoryIndexResult,
  MemoryNode,
  MemoryService,
  MemoryStats,
  MemoryVersion,
  RecallQuery,
  RecallResult,
  RememberInput,
} from './types.js';

export class NoopMemoryService implements MemoryService {
  constructor(readonly projectId = 'disabled', readonly unavailableReason?: string) {}
  async remember(_input: RememberInput): Promise<MemoryNode> {
    throw new Error(this.unavailableReason ?? 'Memory is disabled.');
  }
  async get(): Promise<MemoryNode | null> { return null; }
  async recall(_query: RecallQuery): Promise<RecallResult[]> { return []; }
  async connect(_input: LinkMemoryInput): Promise<MemoryEdge> {
    throw new Error(this.unavailableReason ?? 'Memory is disabled.');
  }
  async related(_id: string, _options?: EdgeQuery): Promise<Array<{ edge: MemoryEdge; node: MemoryNode }>> { return []; }
  async history(): Promise<MemoryVersion[]> { return []; }
  async getAt(): Promise<MemoryNode | null> { return null; }
  async retract(): Promise<void> {}
  async forget(): Promise<boolean> { return false; }
  async buildContext(input: MemoryContextRequest): Promise<MemoryContext> {
    return { text: '', memories: [], usedChars: 0, budgetChars: input.maxChars ?? 2_000, truncated: false };
  }
  async consolidate(): Promise<ConsolidationResult> {
    return { scanned: 0, groups: 0, created: [], archivedSourceIds: [] };
  }
  async index(_input?: MemoryIndexRequest): Promise<MemoryIndexResult> {
    return { status: 'disabled', scanned: 0, indexed: 0, skipped: 0, failed: 0, interrupted: false };
  }
  async stats(): Promise<MemoryStats> {
    return { backend: this.unavailableReason ? 'unavailable' : 'disabled', schemaVersion: 1, nodes: 0, edges: 0, active: 0, superseded: 0, retracted: 0, archived: 0, unconsolidatedCandidates: 0, semanticIndex: 'disabled' };
  }
  async doctor(): Promise<MemoryDoctorResult> {
    return this.unavailableReason
      ? {
          ok: false,
          backend: 'unavailable',
          checks: [{ name: 'initialization', ok: false, detail: this.unavailableReason }],
        }
      : {
          ok: true,
          backend: 'disabled',
          checks: [{ name: 'disabled', ok: true, detail: 'Memory disabled by configuration.' }],
        };
  }
  async export(): Promise<MemoryExport> {
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), projectId: this.projectId, nodes: [], edges: [], versions: [] };
  }
  async close(): Promise<void> {}
}
