import { z } from 'zod';
import * as path from 'node:path';
import {
  MemoryKindSchema,
  MemoryRelationSchema,
  MemoryVisibilitySchema,
  canExternalClientMutate,
  canExternalClientRead,
  type MemoryNode,
  type MemoryService,
} from '@zelari/core/memory';

export interface MemoryMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const id = z.string().min(1).max(300);
const projectId = z.string().min(1).max(300);
const source = z.object({
  agent: z.string().min(1).max(200).optional(),
  sessionId: z.string().min(1).max(300).optional(),
  missionId: z.string().min(1).max(300).optional(),
  sliceId: z.string().min(1).max(300).optional(),
  tentacleId: z.string().min(1).max(300).optional(),
  file: z.string().min(1).max(4_096).optional(),
  symbol: z.string().min(1).max(1_000).optional(),
  commit: z.string().min(1).max(200).optional(),
}).strict().optional();

const SearchSchema = z.object({
  query: z.string().max(64_000).default(''),
  limit: z.number().int().min(1).max(25).default(8),
  kinds: z.array(MemoryKindSchema).max(12).optional(),
  tags: z.array(z.string().min(1).max(120)).max(32).optional(),
  include_historical: z.boolean().default(false),
  use_graph: z.boolean().default(true),
  project_id: projectId.optional(),
}).strict();

const AddSchema = z.object({
  project_id: projectId,
  kind: MemoryKindSchema,
  content: z.string().min(1).max(64_000),
  importance: z.number().finite().min(0).max(1).optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
  visibility: MemoryVisibilitySchema.default('private'),
  tags: z.array(z.string().min(1).max(120)).max(64).optional(),
  source,
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const LinkSchema = z.object({
  project_id: projectId,
  from: id,
  to: id,
  relation: MemoryRelationSchema,
  strength: z.number().finite().min(0).max(1).optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
}).strict();

const RetractSchema = z.object({
  project_id: projectId,
  memory_id: id,
  reason: z.string().min(1).max(2_000).optional(),
}).strict();

export const MEMORY_MCP_TOOLS: readonly MemoryMcpTool[] = [
  {
    name: 'zelari_memory_search',
    description: 'Search current project memory. Private results are limited to the calling client.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 64000 }, limit: { type: 'integer', minimum: 1, maximum: 25 }, kinds: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, include_historical: { type: 'boolean' }, use_graph: { type: 'boolean' }, project_id: { type: 'string' } } },
  },
  {
    name: 'zelari_memory_get',
    description: 'Get one accessible memory by id, including provenance and lifecycle state.',
    inputSchema: { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] },
  },
  {
    name: 'zelari_memory_add',
    description: 'Add a scoped memory. Secrets are scanned and source.client is enforced by the server.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, kind: { type: 'string' }, content: { type: 'string', maxLength: 64000 }, importance: { type: 'number', minimum: 0, maximum: 1 }, confidence: { type: 'number', minimum: 0, maximum: 1 }, visibility: { type: 'string', enum: ['project', 'private'], default: 'private' }, tags: { type: 'array', items: { type: 'string' } }, source: { type: 'object' }, metadata: { type: 'object' } }, required: ['project_id', 'kind', 'content'] },
  },
  {
    name: 'zelari_memory_link',
    description: 'Create a typed relation between two accessible project memories.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, relation: { type: 'string' }, strength: { type: 'number', minimum: 0, maximum: 1 }, confidence: { type: 'number', minimum: 0, maximum: 1 } }, required: ['project_id', 'from', 'to', 'relation'] },
  },
  {
    name: 'zelari_memory_history',
    description: 'Read immutable revisions for one accessible memory.',
    inputSchema: { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] },
  },
  {
    name: 'zelari_memory_retract',
    description: 'Retract a memory owned by the calling client while retaining history.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, memory_id: { type: 'string' }, reason: { type: 'string', maxLength: 2000 } }, required: ['project_id', 'memory_id'] },
  },
];

export interface MemoryMcpAdapterOptions {
  service: MemoryService;
  isTrusted: () => boolean;
  getClientName: () => string;
  allowAdminMutations?: boolean;
  maxWritesPerMinute?: number;
}

export class MemoryMcpAdapter {
  private readonly writes: number[] = [];
  private readonly maxWrites: number;

  constructor(private readonly options: MemoryMcpAdapterOptions) {
    this.maxWrites = Math.max(1, Math.min(options.maxWritesPerMinute ?? 60, 1_000));
  }

  listResources(): Array<{ uri: string; name: string; mimeType: string }> {
    if (!this.options.isTrusted()) return [];
    return [{
      uri: `zelari://memory/project/${this.options.service.projectId}`,
      name: 'Zelari project memory',
      mimeType: 'application/json',
    }];
  }

  async callTool(name: string, raw: unknown): Promise<Record<string, unknown>> {
    try {
      this.assertTrusted();
      const args = raw && typeof raw === 'object' ? raw : {};
      switch (name) {
        case 'zelari_memory_search': return await this.search(SearchSchema.parse(args));
        case 'zelari_memory_get': return await this.get(z.object({ memory_id: id }).strict().parse(args).memory_id);
        case 'zelari_memory_add': return await this.add(AddSchema.parse(args));
        case 'zelari_memory_link': return await this.link(LinkSchema.parse(args));
        case 'zelari_memory_history': return await this.history(z.object({ memory_id: id }).strict().parse(args).memory_id);
        case 'zelari_memory_retract': return await this.retract(RetractSchema.parse(args));
        default: return this.error(`unknown tool: ${name}`);
      }
    } catch (error) {
      const detail = error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')
        : error instanceof Error ? error.message : String(error);
      return this.error(detail);
    }
  }

  async readResource(uri: string): Promise<Record<string, unknown>> {
    try {
      this.assertTrusted();
      const projectUri = `zelari://memory/project/${this.options.service.projectId}`;
      if (uri === projectUri) {
        const results = await this.options.service.recall({
          limit: 25,
          includeHistorical: false,
          externalClient: this.client,
        });
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ projectId: this.options.service.projectId, memories: results }) }] };
      }
      const prefix = 'zelari://memory/';
      if (!uri.startsWith(prefix)) return this.resourceError(uri, 'resource not found');
      const node = await this.accessible(uri.slice(prefix.length));
      if (!node) return this.resourceError(uri, 'resource not found or not authorized');
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(node) }] };
    } catch (error) {
      return this.resourceError(uri, error instanceof Error ? error.message : String(error));
    }
  }

  private get client(): string { return this.options.getClientName(); }

  private async search(args: z.infer<typeof SearchSchema>): Promise<Record<string, unknown>> {
    if (args.project_id && args.project_id !== this.options.service.projectId) return this.error('project scope mismatch');
    const results = await this.options.service.recall({
      text: args.query,
      limit: args.limit,
      kinds: args.kinds,
      tags: args.tags,
      includeHistorical: args.include_historical,
      useGraph: args.use_graph,
      externalClient: this.client,
    });
    return this.ok({ projectId: this.options.service.projectId, count: results.length, results });
  }

  private async get(memoryId: string): Promise<Record<string, unknown>> {
    const node = await this.accessible(memoryId);
    return node ? this.ok(node) : this.error('memory not found or not authorized');
  }

  private async add(args: z.infer<typeof AddSchema>): Promise<Record<string, unknown>> {
    this.assertScope(args.project_id);
    this.takeWrite();
    const externalFile = args.source?.file;
    if (externalFile) {
      const normalized = path.normalize(externalFile);
      if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw new Error('source.file must be project-relative and cannot escape the project');
      }
    }
    const node = await this.options.service.remember({
      kind: args.kind,
      content: args.content,
      importance: args.importance,
      confidence: args.confidence,
      visibility: args.visibility,
      tags: args.tags,
      source: {
        ...(args.source ?? {}),
        ...(externalFile ? { file: externalFile.replace(/\\/g, '/') } : {}),
        agent: args.source?.agent ?? `mcp:${this.client}`,
        client: this.client,
      },
      metadata: { ...(args.metadata ?? {}), externalMcp: true, externalClient: this.client },
      writeClass: 'manual',
    });
    return this.ok(node);
  }

  private async link(args: z.infer<typeof LinkSchema>): Promise<Record<string, unknown>> {
    this.assertScope(args.project_id);
    this.takeWrite();
    const [from, to] = await Promise.all([this.accessible(args.from), this.accessible(args.to)]);
    if (!from || !to) return this.error('relation endpoint not found or not authorized');
    if (['supersedes', 'validated_by', 'invalidated_by'].includes(args.relation) &&
      (!this.mutable(from) || !this.mutable(to))) return this.error('client does not own both mutation endpoints');
    return this.ok(await this.options.service.connect({
      from: args.from, to: args.to, relation: args.relation,
      strength: args.strength, confidence: args.confidence, createdBy: `mcp:${this.client}`,
    }));
  }

  private async history(memoryId: string): Promise<Record<string, unknown>> {
    if (!(await this.accessible(memoryId))) return this.error('memory not found or not authorized');
    const versions = (await this.options.service.history(memoryId))
      .filter((version) => canExternalClientRead(version.snapshot, this.client));
    return this.ok({ memoryId, versions });
  }

  private async retract(args: z.infer<typeof RetractSchema>): Promise<Record<string, unknown>> {
    this.assertScope(args.project_id);
    this.takeWrite();
    const node = await this.accessible(args.memory_id);
    if (!node) return this.error('memory not found or not authorized');
    if (!this.mutable(node)) return this.error('client does not own this memory');
    await this.options.service.retract(args.memory_id, args.reason ?? `retracted by MCP client ${this.client}`);
    return this.ok({ retracted: true, memoryId: args.memory_id });
  }

  private async accessible(memoryId: string): Promise<MemoryNode | null> {
    const node = await this.options.service.get(memoryId);
    return node && canExternalClientRead(node, this.client) ? node : null;
  }

  private mutable(node: MemoryNode): boolean {
    return this.options.allowAdminMutations === true || canExternalClientMutate(node, this.client);
  }

  private assertTrusted(): void {
    if (!this.options.isTrusted()) throw new Error('project is not trusted; run /trust or zelari-code --trust first');
  }

  private assertScope(requested: string): void {
    if (requested !== this.options.service.projectId) throw new Error('project scope mismatch');
  }

  private takeWrite(): void {
    const now = Date.now();
    while (this.writes[0] !== undefined && this.writes[0] <= now - 60_000) this.writes.shift();
    if (this.writes.length >= this.maxWrites) throw new Error(`external write rate limit exceeded (${this.maxWrites}/minute)`);
    this.writes.push(now);
  }

  private ok(value: unknown): Record<string, unknown> {
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  }

  private error(message: string): Record<string, unknown> {
    return { isError: true, content: [{ type: 'text', text: message }] };
  }

  private resourceError(uri: string, message: string): Record<string, unknown> {
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ error: message }) }] };
  }
}
