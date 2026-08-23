import { z } from 'zod';
import {
  MEMORY_KINDS,
  MEMORY_RELATIONS,
  MEMORY_SCHEMA_VERSION,
  MEMORY_STATUSES,
  MEMORY_VISIBILITIES,
} from './types.js';

const isoDate = z.string().datetime({ offset: true });
const unit = z.number().finite().min(0).max(1);
const metadata = z.record(z.string(), z.unknown()).refine((value) => {
  try {
    return JSON.stringify(value).length <= 128_000;
  } catch {
    return false;
  }
}, 'Memory metadata must be JSON-serializable and no larger than 128 KB.');

export const MemoryKindSchema = z.enum(MEMORY_KINDS);
export const MemoryStatusSchema = z.enum(MEMORY_STATUSES);
export const MemoryRelationSchema = z.enum(MEMORY_RELATIONS);
export const MemoryVisibilitySchema = z.enum(MEMORY_VISIBILITIES);

export const MemorySourceSchema = z
  .object({
    agent: z.string().min(1).max(200).optional(),
    sessionId: z.string().min(1).max(300).optional(),
    missionId: z.string().min(1).max(300).optional(),
    sliceId: z.string().min(1).max(300).optional(),
    tentacleId: z.string().min(1).max(300).optional(),
    councilMemberId: z.string().min(1).max(300).optional(),
    skillId: z.string().min(1).max(300).optional(),
    verificationId: z.string().min(1).max(300).optional(),
    file: z.string().min(1).max(4_096).optional(),
    symbol: z.string().min(1).max(1_000).optional(),
    commit: z.string().min(1).max(200).optional(),
    branch: z.string().min(1).max(500).optional(),
    worktree: z.string().min(1).max(4_096).optional(),
    toolCallId: z.string().min(1).max(300).optional(),
    client: z.string().min(1).max(300).optional(),
  })
  .strict();

export const MemoryNodeInputSchema = z
  .object({
    id: z.string().min(1).max(300).optional(),
    projectId: z.string().min(1).max(300).optional(),
    kind: MemoryKindSchema,
    content: z.string().min(1).max(64_000),
    importance: unit.optional(),
    confidence: unit.optional(),
    status: MemoryStatusSchema.optional(),
    visibility: MemoryVisibilitySchema.optional(),
    tags: z.array(z.string().min(1).max(120)).max(64).optional(),
    source: MemorySourceSchema.optional(),
    createdAt: isoDate.optional(),
    recordedAt: isoDate.optional(),
    validFrom: isoDate.optional(),
    validUntil: isoDate.optional(),
    embeddingRef: z.string().min(1).max(2_000).optional(),
    metadata: metadata.optional(),
    writeClass: z.enum(['auto', 'candidate', 'manual']).optional(),
  })
  .strict();

export const MemoryNodeSchema = MemoryNodeInputSchema.omit({ writeClass: true })
  .extend({
    id: z.string().min(1).max(300),
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    projectId: z.string().min(1).max(300),
    importance: unit,
    confidence: unit,
    status: MemoryStatusSchema,
    visibility: MemoryVisibilitySchema.default('project'),
    tags: z.array(z.string().min(1).max(120)).max(64),
    source: MemorySourceSchema,
    createdAt: isoDate,
    updatedAt: isoDate,
    recordedAt: isoDate,
    retractedAt: isoDate.optional(),
    metadata,
  })
  .strict();

export const MemoryEdgeInputSchema = z
  .object({
    id: z.string().min(1).max(300).optional(),
    from: z.string().min(1).max(300),
    to: z.string().min(1).max(300),
    relation: MemoryRelationSchema,
    strength: unit.optional(),
    confidence: unit.optional(),
    createdBy: z.string().min(1).max(300).optional(),
    validFrom: isoDate.optional(),
    validUntil: isoDate.optional(),
    metadata: metadata.optional(),
  })
  .strict();

export const MemoryEdgeSchema = MemoryEdgeInputSchema.extend({
  id: z.string().min(1).max(300),
  strength: unit,
  confidence: unit,
  createdAt: isoDate,
  metadata,
}).strict();
