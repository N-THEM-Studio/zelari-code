import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { MemoryService } from '@zelari/core/memory';
import { getCurrentVersion } from '../updater.js';
import { isFolderTrusted } from '../safety/folderTrust.js';
import { getMemoryService } from './serviceFactory.js';
import { MEMORY_MCP_TOOLS, MemoryMcpAdapter } from './mcpAdapter.js';

export const MEMORY_MCP_PROTOCOL_VERSION = '2025-03-26';
const MAX_RPC_LINE_BYTES = 1_048_576;

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface MemoryMcpServerOptions {
  projectRoot: string;
  input?: Readable;
  output?: Writable;
  service?: MemoryService;
  isTrusted?: () => boolean;
  allowAdminMutations?: boolean;
  maxWritesPerMinute?: number;
  closeService?: boolean;
  /** Stable local principal, preferably configured per external client. */
  clientId?: string;
}

export interface MemoryMcpServerHandle {
  projectId: string;
  closed: Promise<void>;
  stop(): Promise<void>;
}

function safeClientName(value: unknown): string {
  if (typeof value !== 'string') return 'unknown-mcp-client';
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._:@/-]+/g, '-').slice(0, 100);
  return cleaned || 'unknown-mcp-client';
}

export async function startMemoryMcpServer(
  options: MemoryMcpServerOptions,
): Promise<MemoryMcpServerHandle> {
  const service = options.service ?? await getMemoryService(options.projectRoot, process.env, { force: true });
  const ownsService = options.service === undefined || options.closeService === true;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const trusted = options.isTrusted ?? (() => isFolderTrusted(options.projectRoot));
  const fixedClientName = options.clientId ? safeClientName(options.clientId) : undefined;
  let clientName = fixedClientName ?? 'unknown-mcp-client';
  let initialized = false;
  let stopped = false;
  let finalizePromise: Promise<void> | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const adapter = new MemoryMcpAdapter({
    service,
    isTrusted: trusted,
    getClientName: () => clientName,
    allowAdminMutations: options.allowAdminMutations,
    maxWritesPerMinute: options.maxWritesPerMinute,
  });

  input.on?.('error', () => undefined);
  output.on?.('error', () => undefined);
  const send = (message: unknown): void => {
    if (!stopped && !output.destroyed) output.write(`${JSON.stringify(message)}\n`);
  };
  const rl = createInterface({ input, crlfDelay: Infinity });
  const finalize = (): Promise<void> => {
    finalizePromise ??= (async () => {
      if (ownsService) await service.close().catch(() => undefined);
      resolveClosed();
    })();
    return finalizePromise;
  };

  const handle = async (message: RpcMessage): Promise<Record<string, unknown>> => {
    const method = message.method ?? '';
    if (method === 'initialize') {
      if (initialized) return { error: { code: -32600, message: 'MCP connection is already initialized' } };
      const info = message.params?.clientInfo;
      if (!fixedClientName && info && typeof info === 'object') {
        clientName = safeClientName((info as { name?: unknown }).name);
      }
      initialized = true;
      return {
        result: {
          protocolVersion: typeof message.params?.protocolVersion === 'string'
            ? message.params.protocolVersion
            : MEMORY_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'zelari-memory-mcp', version: getCurrentVersion() },
        },
      };
    }
    if (method === 'ping') return { result: {} };
    if (!initialized) return { error: { code: -32002, message: 'MCP connection is not initialized' } };
    if (method === 'tools/list') return { result: { tools: MEMORY_MCP_TOOLS } };
    if (method === 'tools/call') {
      const name = typeof message.params?.name === 'string' ? message.params.name : '';
      return { result: await adapter.callTool(name, message.params?.arguments) };
    }
    if (method === 'resources/list') return { result: { resources: adapter.listResources() } };
    if (method === 'resources/read') {
      const uri = typeof message.params?.uri === 'string' ? message.params.uri : '';
      if (!uri) return { error: { code: -32602, message: 'resources/read requires uri' } };
      return { result: await adapter.readResource(uri) };
    }
    return { error: { code: -32601, message: `method not found: ${method}` } };
  };

  rl.on('line', (line) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request exceeds 1 MiB transport limit' } });
      return;
    }
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; }
    catch { return; }
    if (message.id === undefined) return;
    void handle(message).then((body) => {
      send({ jsonrpc: '2.0', id: message.id, ...body });
    }).catch((error) => {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: `internal error: ${error instanceof Error ? error.message : String(error)}` },
      });
    });
  });
  rl.on('close', () => { void finalize(); });

  return {
    projectId: service.projectId,
    closed,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      rl.close();
      await finalize();
    },
  };
}
