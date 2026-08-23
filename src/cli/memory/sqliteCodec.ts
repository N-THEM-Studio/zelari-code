import {
  MemoryEdgeSchema,
  MemoryNodeSchema,
} from '@zelari/core/memory';
import type {
  MemoryEdge,
  MemoryNode,
  MemoryVersion,
} from '@zelari/core/memory';
import type { SqlValue } from './sqliteRpc.js';

export type SqlRow = Record<string, unknown>;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function decodeNode(row: SqlRow | undefined): MemoryNode | null {
  if (!row) return null;
  const parsed = MemoryNodeSchema.safeParse({
    id: row.id,
    schemaVersion: row.schema_version,
    projectId: row.project_id,
    kind: row.kind,
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    status: row.status,
    visibility: row.visibility ?? 'project',
    tags: json(row.tags_json, []),
    source: json(row.source_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(optional(row.valid_from) ? { validFrom: optional(row.valid_from) } : {}),
    ...(optional(row.valid_until) ? { validUntil: optional(row.valid_until) } : {}),
    recordedAt: row.recorded_at,
    ...(optional(row.retracted_at) ? { retractedAt: optional(row.retracted_at) } : {}),
    ...(optional(row.embedding_ref) ? { embeddingRef: optional(row.embedding_ref) } : {}),
    metadata: json(row.metadata_json, {}),
  });
  return parsed.success ? parsed.data : null;
}

export function nodeSqlValues(node: MemoryNode): SqlValue[] {
  return [
    node.id,
    node.schemaVersion,
    node.projectId,
    node.kind,
    node.content,
    node.importance,
    node.confidence,
    node.status,
    node.visibility ?? 'project',
    JSON.stringify(node.tags),
    JSON.stringify(node.source),
    node.createdAt,
    node.updatedAt,
    node.validFrom ?? null,
    node.validUntil ?? null,
    node.recordedAt,
    node.retractedAt ?? null,
    node.embeddingRef ?? null,
    JSON.stringify(node.metadata),
  ];
}

export function decodeEdge(row: SqlRow | undefined): MemoryEdge | null {
  if (!row) return null;
  const parsed = MemoryEdgeSchema.safeParse({
    id: row.id,
    from: row.from_id,
    to: row.to_id,
    relation: row.relation,
    strength: row.strength,
    confidence: row.confidence,
    createdAt: row.created_at,
    ...(optional(row.created_by) ? { createdBy: optional(row.created_by) } : {}),
    ...(optional(row.valid_from) ? { validFrom: optional(row.valid_from) } : {}),
    ...(optional(row.valid_until) ? { validUntil: optional(row.valid_until) } : {}),
    metadata: json(row.metadata_json, {}),
  });
  return parsed.success ? parsed.data : null;
}

export function edgeSqlValues(edge: MemoryEdge): SqlValue[] {
  return [
    edge.id,
    edge.from,
    edge.to,
    edge.relation,
    edge.strength,
    edge.confidence,
    edge.createdAt,
    edge.createdBy ?? null,
    edge.validFrom ?? null,
    edge.validUntil ?? null,
    JSON.stringify(edge.metadata),
  ];
}

export function decodeVersion(row: SqlRow | undefined): MemoryVersion | null {
  if (!row) return null;
  const snapshot = json<unknown>(row.snapshot_json, null);
  const parsed = MemoryNodeSchema.safeParse(snapshot);
  if (!parsed.success) return null;
  return {
    versionId: String(row.version_id),
    memoryId: String(row.memory_id),
    revision: Number(row.revision),
    snapshot: parsed.data,
    recordedAt: String(row.recorded_at),
    ...(optional(row.actor) ? { actor: optional(row.actor) } : {}),
    ...(optional(row.reason) ? { reason: optional(row.reason) } : {}),
  };
}
