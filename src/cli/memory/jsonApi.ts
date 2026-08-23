import { z } from 'zod';
import { MemoryKindSchema, MemoryStatusSchema } from '@zelari/core/memory';
import { getMemoryService } from './serviceFactory.js';

export const MEMORY_JSON_API_VERSION = 'zelari-memory-desktop/1';

const SearchRequest = z.object({
  operation: z.literal('search'),
  query: z.string().max(64_000).default(''),
  limit: z.number().int().min(1).max(100).default(30),
  kinds: z.array(MemoryKindSchema).max(12).optional(),
  statuses: z.array(MemoryStatusSchema).max(4).optional(),
  tags: z.array(z.string().min(1).max(120)).max(32).optional(),
  useGraph: z.boolean().default(true),
  includeHistorical: z.boolean().default(false),
}).strict();

const DetailRequest = z.object({
  operation: z.literal('detail'),
  memoryId: z.string().min(1).max(300),
}).strict();

const StatsRequest = z.object({ operation: z.literal('stats') }).strict();

export const MemoryJsonRequestSchema = z.discriminatedUnion('operation', [
  SearchRequest,
  DetailRequest,
  StatsRequest,
]);

/** Bounded JSON bridge used by Desktop. It exposes no mutation operation. */
export async function runMemoryJsonApi(projectRoot: string, rawRequest: string): Promise<unknown> {
  if (Buffer.byteLength(rawRequest, 'utf8') > 256_000) {
    throw new Error('memory JSON request exceeds 256 KB');
  }
  let decoded: unknown;
  try { decoded = JSON.parse(rawRequest); }
  catch { throw new Error('memory JSON request must be valid JSON'); }
  const request = MemoryJsonRequestSchema.parse(decoded);
  const warnings: string[] = [];
  const memory = await getMemoryService(projectRoot, process.env, {
    force: true,
    onWarning: (warning) => warnings.push(warning),
  });
  try {
    if (request.operation === 'stats') {
      return { apiVersion: MEMORY_JSON_API_VERSION, ok: true, operation: request.operation, warnings, stats: await memory.stats() };
    }
    if (request.operation === 'detail') {
      const node = await memory.get(request.memoryId);
      if (!node) return { apiVersion: MEMORY_JSON_API_VERSION, ok: false, operation: request.operation, warnings, error: 'memory not found' };
      const [related, history] = await Promise.all([
        memory.related(request.memoryId, { direction: 'both', limit: 200 }),
        memory.history(request.memoryId),
      ]);
      return { apiVersion: MEMORY_JSON_API_VERSION, ok: true, operation: request.operation, warnings, node, related, history };
    }
    const [results, stats] = await Promise.all([
      memory.recall({
        text: request.query,
        limit: request.limit,
        kinds: request.kinds,
        statuses: request.statuses,
        tags: request.tags,
        useGraph: request.useGraph,
        includeHistorical: request.includeHistorical,
      }),
      memory.stats(),
    ]);
    return {
      ok: true,
      apiVersion: MEMORY_JSON_API_VERSION,
      operation: request.operation,
      warnings,
      projectId: memory.projectId,
      results,
      stats,
    };
  } finally {
    await memory.close().catch(() => undefined);
  }
}
