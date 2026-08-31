/**
 * Public contracts for Zelari project memory.
 *
 * `MemoryBackend` is the original V1 chunk API and remains source-compatible.
 * The cognitive contracts below are additive: callers use `MemoryService`
 * while persistence implementations use `CognitiveMemoryBackend`.
 */

// ---------------------------------------------------------------------------
// Legacy V1 API

export interface MemoryChunk {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface MemorySearchOptions {
  /** Max results to return. Default 8. */
  limit?: number;
  /** Optional one-hop expansion for graph-aware backends. */
  useGraph?: boolean;
  /** Shallow metadata equality filter. */
  metadataFilter?: Record<string, unknown>;
}

export interface MemoryResult {
  id: string;
  text: string;
  /** Relevance score (backend-defined; higher is better). */
  score: number;
  metadata: Record<string, unknown>;
}

export interface MemoryAddGraph {
  entities?: Array<{ name: string; type?: string }>;
  relations?: Array<{ from: string; to: string; type: string; weight?: number }>;
}

export interface MemoryBackend {
  init(projectRoot: string): Promise<void>;
  add(
    content: string,
    metadata?: Record<string, unknown>,
    graph?: MemoryAddGraph,
  ): Promise<string>;
  search(query: string, options?: MemorySearchOptions): Promise<MemoryResult[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Native cognitive memory V2

export const MEMORY_SCHEMA_VERSION = 1 as const;

export const MEMORY_KINDS = [
  'fact',
  'decision',
  'episode',
  'hypothesis',
  'outcome',
  'constraint',
  'preference',
  'finding',
  'failure',
  'verification',
  'artifact',
  'procedure',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = [
  'active',
  'superseded',
  'retracted',
  'archived',
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_RELATIONS = [
  'supports',
  'contradicts',
  'supersedes',
  'derived_from',
  'motivated_by',
  'implemented_by',
  'validated_by',
  'invalidated_by',
  'caused',
  'affected',
  'depends_on',
  'related_to',
  'belongs_to',
  'resolved_by',
  'failed_because',
] as const;
export type MemoryRelation = (typeof MEMORY_RELATIONS)[number];

export type MemoryWriteClass = 'auto' | 'candidate' | 'manual';

export const MEMORY_VISIBILITIES = ['project', 'private'] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export interface MemorySource {
  agent?: string;
  sessionId?: string;
  missionId?: string;
  sliceId?: string;
  tentacleId?: string;
  councilMemberId?: string;
  skillId?: string;
  verificationId?: string;
  file?: string;
  symbol?: string;
  commit?: string;
  branch?: string;
  worktree?: string;
  toolCallId?: string;
  client?: string;
}

export interface MemoryNode {
  id: string;
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  projectId: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  /** `private` nodes are only exposed back to their originating external client. */
  visibility?: MemoryVisibility;
  tags: string[];
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  validFrom?: string;
  validUntil?: string;
  recordedAt: string;
  retractedAt?: string;
  embeddingRef?: string;
  metadata: Record<string, unknown>;
}

export interface MemoryNodeInput {
  /** Optional stable id, primarily for safe legacy imports. */
  id?: string;
  /** The service supplies and enforces its project id when omitted. */
  projectId?: string;
  kind: MemoryKind;
  content: string;
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  visibility?: MemoryVisibility;
  tags?: string[];
  source?: MemorySource;
  /** Optional historical timestamps, used by trusted migration/import paths. */
  createdAt?: string;
  recordedAt?: string;
  validFrom?: string;
  validUntil?: string;
  embeddingRef?: string;
  metadata?: Record<string, unknown>;
}

export interface RememberInput extends MemoryNodeInput {
  writeClass?: MemoryWriteClass;
}

export interface MemoryPatch {
  kind?: MemoryKind;
  content?: string;
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  visibility?: MemoryVisibility;
  tags?: string[];
  source?: MemorySource;
  validFrom?: string | null;
  validUntil?: string | null;
  embeddingRef?: string | null;
  metadata?: Record<string, unknown>;
  /** Stored on the immutable version row, not on the current node. */
  reason?: string;
  actor?: string;
}

export interface MemoryEdge {
  id: string;
  from: string;
  to: string;
  relation: MemoryRelation;
  strength: number;
  confidence: number;
  createdAt: string;
  createdBy?: string;
  validFrom?: string;
  validUntil?: string;
  metadata: Record<string, unknown>;
}

export interface MemoryEdgeInput {
  id?: string;
  from: string;
  to: string;
  relation: MemoryRelation;
  strength?: number;
  confidence?: number;
  createdBy?: string;
  validFrom?: string;
  validUntil?: string;
  metadata?: Record<string, unknown>;
}

export interface EdgeQuery {
  direction?: 'in' | 'out' | 'both';
  relations?: MemoryRelation[];
  asOf?: string;
  limit?: number;
}

export interface MemoryVersion {
  versionId: string;
  memoryId: string;
  revision: number;
  snapshot: MemoryNode;
  recordedAt: string;
  actor?: string;
  reason?: string;
}

export interface MemoryQuery {
  text?: string;
  projectId?: string;
  kinds?: MemoryKind[];
  statuses?: MemoryStatus[];
  visibilities?: MemoryVisibility[];
  /** Restrict external reads to project-visible nodes plus this client's private nodes. */
  externalClient?: string;
  tags?: string[];
  source?: Partial<MemorySource>;
  minImportance?: number;
  minConfidence?: number;
  createdAfter?: string;
  createdBefore?: string;
  asOf?: string;
  includeHistorical?: boolean;
  useGraph?: boolean;
  graphDepth?: number;
  limit?: number;
}

/** Persistence-level candidate with optional retrieval signals. */
export interface MemoryCandidate {
  node: MemoryNode;
  lexicalRelevance?: number;
  semanticRelevance?: number;
  graphProximity?: number;
}

export interface RecallSignals {
  semanticRelevance: number;
  lexicalRelevance: number;
  importance: number;
  confidence: number;
  recency: number;
  graphProximity: number;
  verificationBonus: number;
}

export interface RecallResult {
  node: MemoryNode;
  score: number;
  signals: RecallSignals;
}

export interface RecallQuery extends MemoryQuery {
  /** Alias retained for callers that naturally pass `{ query: ... }`. */
  query?: string;
  /**
   * Caller-resolved scoring overrides, structurally
   * `Partial<MemoryScoringWeights>` (kept inline to avoid a types↔scoring
   * type-import cycle). The core stays pressure-blind per ADR-0031/0032:
   * hosts (the CLI budget pipeline) translate measured occupancy into weight
   * shifts and pass them here; `rankMemoryCandidates` merges them over the
   * defaults.
   */
  weights?: Partial<{
    semanticRelevance: number;
    lexicalRelevance: number;
    importance: number;
    confidence: number;
    recency: number;
    graphProximity: number;
    verificationBonus: number;
  }>;
}

export interface LinkMemoryInput extends MemoryEdgeInput {}

export interface MemoryContextRequest extends RecallQuery {
  /** Hard output character budget. Default 2,000. */
  maxChars?: number;
  /** Broad candidate pool before ranking and diversity packing. */
  candidateLimit?: number;
  /** Maximum memories packed even when the character budget allows more. */
  maxMemories?: number;
}

export interface MemoryContext {
  text: string;
  memories: RecallResult[];
  usedChars: number;
  budgetChars: number;
  truncated: boolean;
}

export interface ConsolidationRequest {
  memoryIds?: string[];
  query?: string;
  minOccurrences?: number;
  archiveSources?: boolean;
  source?: MemorySource;
}

export interface ConsolidationResult {
  scanned: number;
  groups: number;
  created: MemoryNode[];
  archivedSourceIds: string[];
}

export interface MemoryStats {
  backend: string;
  path?: string;
  schemaVersion: number;
  nodes: number;
  edges: number;
  active: number;
  superseded: number;
  retracted: number;
  archived: number;
  unconsolidatedCandidates: number;
  semanticIndex: 'ready' | 'disabled' | 'degraded';
  semanticModel?: string;
  semanticIndexed?: number;
  semanticStale?: number;
}

/** Optional dependency injected by a host; @zelari/core never calls a provider directly. */
export interface MemoryEmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][] | { error: string }>;
}

export interface MemorySemanticSource {
  node: MemoryNode;
  contentHash: string;
}

export interface MemoryEmbeddingRecord {
  memoryId: string;
  projectId: string;
  model: string;
  contentHash: string;
  vector: number[];
  indexedAt: string;
}

export interface MemorySemanticStatus {
  state: 'ready' | 'disabled' | 'degraded';
  model?: string;
  indexed: number;
  stale: number;
  lastIndexedAt?: string;
  detail?: string;
}

export interface MemoryIndexRequest {
  /** Recompute even when model and content hash still match. */
  force?: boolean;
  /** Maximum nodes handled in this invocation. Default 1,000. */
  limit?: number;
  /** Provider batch size. Default 32. */
  batchSize?: number;
  /** Makes long explicit re-index operations interruptible. */
  signal?: AbortSignal;
}

export interface MemoryIndexResult {
  status: 'ready' | 'disabled' | 'degraded';
  model?: string;
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
  interrupted: boolean;
  error?: string;
}

export interface MemoryDoctorResult {
  ok: boolean;
  backend: string;
  path?: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface MemoryExport {
  schemaVersion: 1;
  exportedAt: string;
  projectId: string;
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  versions: MemoryVersion[];
}

export interface CognitiveMemoryBackend {
  init?(projectRoot: string): Promise<void>;
  add(node: MemoryNodeInput & { projectId: string }): Promise<MemoryNode>;
  get(id: string): Promise<MemoryNode | null>;
  update(id: string, patch: MemoryPatch): Promise<MemoryNode>;
  search(query: MemoryQuery): Promise<MemoryCandidate[]>;
  listSemanticSources?(
    projectId: string,
    model: string,
    options?: { force?: boolean; limit?: number; cursor?: string },
  ): Promise<MemorySemanticSource[]>;
  upsertSemanticEmbeddings?(records: MemoryEmbeddingRecord[]): Promise<void>;
  semanticSearch?(
    query: MemoryQuery,
    vector: number[],
    model: string,
  ): Promise<MemoryCandidate[]>;
  semanticStatus?(projectId: string, model?: string): Promise<MemorySemanticStatus>;
  addEdge(edge: MemoryEdgeInput): Promise<MemoryEdge>;
  edges(nodeId: string, options?: EdgeQuery): Promise<MemoryEdge[]>;
  history(id: string): Promise<MemoryVersion[]>;
  getAt?(id: string, timestamp: string): Promise<MemoryNode | null>;
  retract(id: string, reason?: string, actor?: string): Promise<void>;
  delete?(id: string): Promise<boolean>;
  stats?(): Promise<MemoryStats>;
  doctor?(): Promise<MemoryDoctorResult>;
  export?(projectId: string): Promise<MemoryExport>;
  close?(): Promise<void>;
}

export interface MemoryService {
  readonly projectId: string;
  remember(input: RememberInput): Promise<MemoryNode>;
  get(memoryId: string): Promise<MemoryNode | null>;
  recall(query: RecallQuery): Promise<RecallResult[]>;
  connect(input: LinkMemoryInput): Promise<MemoryEdge>;
  related(memoryId: string, options?: EdgeQuery): Promise<Array<{
    edge: MemoryEdge;
    node: MemoryNode;
  }>>;
  history(memoryId: string): Promise<MemoryVersion[]>;
  getAt(memoryId: string, timestamp: string): Promise<MemoryNode | null>;
  retract(memoryId: string, reason?: string): Promise<void>;
  forget(memoryId: string): Promise<boolean>;
  buildContext(input: MemoryContextRequest): Promise<MemoryContext>;
  consolidate(input?: ConsolidationRequest): Promise<ConsolidationResult>;
  index?(input?: MemoryIndexRequest): Promise<MemoryIndexResult>;
  stats(): Promise<MemoryStats>;
  doctor(): Promise<MemoryDoctorResult>;
  export(): Promise<MemoryExport>;
  close(): Promise<void>;
}

export interface MemorySanitizationResult {
  content: string;
  redactions: string[];
  rejected: boolean;
  reason?: string;
}

export interface MemorySanitizer {
  sanitize(content: string): MemorySanitizationResult;
}

export type MemoryEventType =
  | 'memory_recall_start'
  | 'memory_recall_end'
  | 'memory_write'
  | 'memory_link'
  | 'memory_retract'
  | 'memory_consolidate_start'
  | 'memory_consolidate_end'
  | 'memory_migration'
  | 'memory_error';

export interface MemoryEvent {
  type: MemoryEventType;
  at: string;
  durationMs?: number;
  candidateCount?: number;
  returnedCount?: number;
  contextChars?: number;
  backend?: string;
  reason?: string;
  /** Identifiers only. Memory content must never be placed in telemetry. */
  memoryId?: string;
}

export type MemoryEventSink = (event: MemoryEvent) => void | Promise<void>;
