import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getMemoryService } from '../../src/cli/memory/serviceFactory.js';
import { startMemoryMcpServer, type MemoryMcpServerHandle } from '../../src/cli/memory/mcpServer.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

class RpcHarness {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();

  constructor() {
    this.output.setEncoding('utf8');
    this.output.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { id?: number } & Record<string, unknown>;
        if (typeof message.id !== 'number') continue;
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 5_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}

function toolResult(message: Record<string, unknown>): { isError?: boolean; value: unknown } {
  if (!message.result) throw new Error(`unexpected MCP response: ${JSON.stringify(message)}`);
  const result = message.result as { content?: Array<{ text?: string }>; isError?: boolean };
  const text = result.content?.[0]?.text ?? 'null';
  let value: unknown = text;
  try { value = JSON.parse(text); } catch { /* policy errors are plain text */ }
  return { isError: result.isError, value };
}

async function start(
  root: string,
  service: Awaited<ReturnType<typeof getMemoryService>>,
  client: string,
  trusted = true,
  maxWritesPerMinute = 60,
): Promise<{ rpc: RpcHarness; server: MemoryMcpServerHandle }> {
  const rpc = new RpcHarness();
  const server = await startMemoryMcpServer({
    projectRoot: root,
    service,
    input: rpc.input,
    output: rpc.output,
    isTrusted: () => trusted,
    maxWritesPerMinute,
  });
  const initialized = await rpc.request('initialize', {
    protocolVersion: '2025-03-26',
    clientInfo: { name: client, version: '1.0.0' },
  });
  expect(initialized.error).toBeUndefined();
  return { rpc, server };
}

describe('optional memory MCP adapter', () => {
  it('requires initialization and honors a fixed local client principal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-mcp-handshake-'));
    roots.push(root);
    const service = await getMemoryService(root, { ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv, { force: true });
    const rpc = new RpcHarness();
    const server = await startMemoryMcpServer({
      projectRoot: root,
      service,
      input: rpc.input,
      output: rpc.output,
      isTrusted: () => true,
      clientId: 'fixed-owner',
    });
    expect((await rpc.request('tools/list')).error).toMatchObject({ code: -32002 });
    await rpc.request('initialize', { clientInfo: { name: 'spoofed-name' } });
    const added = toolResult(await rpc.request('tools/call', {
      name: 'zelari_memory_add',
      arguments: {
        project_id: service.projectId,
        kind: 'fact',
        content: 'Fixed principal provenance.',
      },
    })).value as { source: { client: string } };
    expect(added.source.client).toBe('fixed-owner');
    expect((await rpc.request('initialize', { clientInfo: { name: 'second-name' } })).error)
      .toMatchObject({ code: -32600 });
    await server.stop();
    await service.close();
  });

  it('round-trips external/native writes with scope, visibility, provenance, and secrets enforced', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-mcp-'));
    roots.push(root);
    let service = await getMemoryService(root, { ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv, { force: true });
    const projectId = service.projectId;

    const clientA = await start(root, service, 'client-A');
    const listed = await clientA.rpc.request('tools/list');
    expect((listed.result as { tools: unknown[] }).tools).toHaveLength(6);
    const resources = await clientA.rpc.request('resources/list');
    expect((resources.result as { resources: Array<{ uri: string }> }).resources[0]?.uri)
      .toBe(`zelari://memory/project/${projectId}`);

    const addedResponse = await clientA.rpc.request('tools/call', {
      name: 'zelari_memory_add',
      arguments: {
        project_id: projectId,
        kind: 'finding',
        content: 'The release job requires the signed manifest.',
        visibility: 'private',
        source: { sessionId: 'external-session' },
      },
    });
    const added = toolResult(addedResponse).value as { id: string; source: { client: string }; visibility: string };
    expect(added.source.client).toBe('client-A');
    expect(added.visibility).toBe('private');
    expect((await service.get(added.id))?.content).toContain('signed manifest');
    expect((await service.recall({ text: 'signed manifest' }))[0]?.node.id).toBe(added.id);

    const secret = toolResult(await clientA.rpc.request('tools/call', {
      name: 'zelari_memory_add',
      arguments: {
        project_id: projectId,
        kind: 'failure',
        content: 'Upload failed with api_key=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      },
    })).value as { content: string };
    expect(secret.content).toContain('[REDACTED]');
    expect(secret.content).not.toContain('sk-proj-');

    const wrongScope = toolResult(await clientA.rpc.request('tools/call', {
      name: 'zelari_memory_add',
      arguments: { project_id: 'project_spoofed', kind: 'fact', content: 'spoof' },
    }));
    expect(wrongScope.isError).toBe(true);
    expect(String(wrongScope.value)).toMatch(/scope mismatch/i);
    const spoofedFile = toolResult(await clientA.rpc.request('tools/call', {
      name: 'zelari_memory_add',
      arguments: {
        project_id: projectId,
        kind: 'fact',
        content: 'Spoofed external provenance.',
        source: { file: '../outside.txt' },
      },
    }));
    expect(spoofedFile.isError).toBe(true);
    expect(String(spoofedFile.value)).toMatch(/project-relative/i);
    await clientA.server.stop();
    await service.close();

    service = await getMemoryService(root, { ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv, { force: true });
    expect((await service.recall({ text: 'signed manifest' })).some(({ node }) => node.id === added.id)).toBe(true);

    const native = await service.remember({
      kind: 'decision',
      content: 'Native Council selected the release pipeline.',
      visibility: 'project',
      source: { agent: 'council' },
    });
    const clientB = await start(root, service, 'client-B');
    const privateSearch = toolResult(await clientB.rpc.request('tools/call', {
      name: 'zelari_memory_search', arguments: { query: 'signed manifest', limit: 10 },
    })).value as { results: unknown[] };
    expect(privateSearch.results).toHaveLength(0);
    const clientBCopy = toolResult(await clientB.rpc.request('tools/call', {
      name: 'zelari_memory_add',
      arguments: {
        project_id: projectId,
        kind: 'finding',
        content: 'The release job requires the signed manifest.',
        visibility: 'private',
      },
    })).value as { id: string; source: { client: string } };
    expect(clientBCopy.id).not.toBe(added.id);
    expect(clientBCopy.source.client).toBe('client-B');
    const ownedSearch = toolResult(await clientB.rpc.request('tools/call', {
      name: 'zelari_memory_search', arguments: { query: 'signed manifest', limit: 10 },
    })).value as { results: Array<{ node: { id: string } }> };
    expect(ownedSearch.results.map((result) => result.node.id)).toEqual([clientBCopy.id]);
    const nativeGet = toolResult(await clientB.rpc.request('tools/call', {
      name: 'zelari_memory_get', arguments: { memory_id: native.id },
    })).value as { id: string };
    expect(nativeGet.id).toBe(native.id);
    const nativeRetract = toolResult(await clientB.rpc.request('tools/call', {
      name: 'zelari_memory_retract',
      arguments: { project_id: projectId, memory_id: native.id },
    }));
    expect(nativeRetract.isError).toBe(true);
    expect((await service.get(native.id))?.status).toBe('active');
    const ownRetract = toolResult(await clientB.rpc.request('tools/call', {
      name: 'zelari_memory_retract',
      arguments: { project_id: projectId, memory_id: clientBCopy.id, reason: 'superseded externally' },
    }));
    expect(ownRetract.isError).not.toBe(true);
    expect((await service.get(clientBCopy.id))?.status).toBe('retracted');
    const privateGet = toolResult(await clientB.rpc.request('tools/call', {
      name: 'zelari_memory_get', arguments: { memory_id: added.id },
    }));
    expect(privateGet.isError).toBe(true);
    await clientB.server.stop();
    await service.close();
  });

  it('denies untrusted projects and bounds external write bursts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-mcp-policy-'));
    roots.push(root);
    const service = await getMemoryService(root, { ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv, { force: true });

    const denied = await start(root, service, 'blocked-client', false);
    expect((await denied.rpc.request('resources/list')).result).toEqual({ resources: [] });
    const blocked = toolResult(await denied.rpc.request('tools/call', {
      name: 'zelari_memory_search', arguments: { query: 'anything' },
    }));
    expect(blocked.isError).toBe(true);
    expect(String(blocked.value)).toMatch(/not trusted/i);
    await denied.server.stop();

    const limited = await start(root, service, 'limited-client', true, 1);
    const args = { project_id: service.projectId, kind: 'fact', content: 'First bounded write.' };
    expect(toolResult(await limited.rpc.request('tools/call', { name: 'zelari_memory_add', arguments: args })).isError)
      .not.toBe(true);
    const second = toolResult(await limited.rpc.request('tools/call', {
      name: 'zelari_memory_add', arguments: { ...args, content: 'Second bounded write.' },
    }));
    expect(second.isError).toBe(true);
    expect(String(second.value)).toMatch(/rate limit/i);
    await limited.server.stop();
    await service.close();
  });
});
