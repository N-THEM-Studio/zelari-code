import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import { typedOk } from '@zelari/core/harness/tools/toolTypes';
import {
  createUseToolTool,
  isToolOffloadEnabled,
  planToolOffload,
  STATIC_TOOLS,
  USE_TOOL_NAME,
} from './toolOffload.js';

const spec = (name: string, description = `${name} tool`) => ({
  name,
  description,
  parameters: { type: 'object', properties: {} },
});

describe('planToolOffload', () => {
  it('keeps the frequent tools, offloads the rest and every MCP tool', () => {
    const plan = planToolOffload([
      spec('read_file'),
      spec('browser_check'),
      spec('mcp_github_search', '[MCP:github] search code'),
      spec('bash'),
      spec('mcp_filesystem_read_file', '[MCP:filesystem] read'),
      spec('create_skill'),
    ]);
    expect(plan.staticTools.map((t) => t.name)).toEqual(['read_file', 'bash']);
    // Sorted by name: the pointer and the dispatcher are byte-stable.
    expect(plan.offloaded.map((t) => t.name)).toEqual([
      'browser_check',
      'create_skill',
      'mcp_filesystem_read_file',
      'mcp_github_search',
    ]);
    expect(plan.pointer).toContain('Built-in: browser_check, create_skill.');
    expect(plan.pointer).toContain('MCP servers: filesystem (1), github (1).');
  });

  it('is deterministic whatever order the registry lists tools in', () => {
    const a = planToolOffload([spec('z_tool'), spec('a_tool'), spec('read_file')]);
    const b = planToolOffload([spec('read_file'), spec('a_tool'), spec('z_tool')]);
    expect(a.pointer).toBe(b.pointer);
    expect(a.offloaded).toEqual(b.offloaded);
  });

  it('keeps the tools real turns use', () => {
    for (const name of ['read_file', 'bash', 'grep_content', 'edit', 'task', 'write_file', 'ask_user']) {
      expect(STATIC_TOOLS.has(name)).toBe(true);
    }
  });

  it('is on by default, off with 0 / false / no / off', () => {
    expect(isToolOffloadEnabled({})).toBe(true);
    expect(isToolOffloadEnabled({ ZELARI_TOOL_OFFLOAD: '1' })).toBe(true);
    for (const v of ['0', 'false', 'NO', ' off ']) {
      expect(isToolOffloadEnabled({ ZELARI_TOOL_OFFLOAD: v })).toBe(false);
    }
  });
});

describe('use_tool', () => {
  function setup() {
    const registry = new ToolRegistry();
    const calls: unknown[] = [];
    registry.register({
      name: 'browser_check',
      description: 'Open a page and check it',
      permissions: [],
      inputSchema: z.object({ url: z.string() }),
      execute: async (input) => {
        calls.push(input);
        return typedOk({ ok: true, url: input.url });
      },
    });
    registry.register({
      name: 'read_file',
      description: 'Read a file',
      permissions: [],
      inputSchema: z.object({ path: z.string() }),
      execute: async () => typedOk('content'),
    });
    const all = registry.toOpenAITools().map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
    const plan = planToolOffload([...all, spec('mcp_github_search', '[MCP:github] search code')]);
    registry.register(createUseToolTool(registry, plan.offloaded) as never);
    return { registry, calls };
  }

  it('describes an offloaded tool', async () => {
    const { registry } = setup();
    const res = await registry.invoke<{ name: string; parameters: unknown }>(USE_TOOL_NAME, {
      name: 'browser_check',
      describe: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toMatchObject({ name: 'browser_check', description: 'Open a page and check it' });
  });

  it('lists an MCP server', async () => {
    const { registry } = setup();
    const res = await registry.invoke<{ tools: Array<{ name: string }> }>(USE_TOOL_NAME, {
      server: 'github',
      describe: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.tools.map((t) => t.name)).toEqual(['mcp_github_search']);
  });

  it('runs an offloaded tool through registry.invoke (its own validation applies)', async () => {
    const { registry, calls } = setup();
    const ok = await registry.invoke<{ url: string }>(USE_TOOL_NAME, {
      name: 'browser_check',
      args: { url: 'http://localhost:1420' },
    });
    expect(ok.ok).toBe(true);
    expect(calls).toEqual([{ url: 'http://localhost:1420' }]);
    const bad = await registry.invoke(USE_TOOL_NAME, { name: 'browser_check', args: { url: 42 } });
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('sends direct tools back to a direct call', async () => {
    const { registry } = setup();
    const res = await registry.invoke(USE_TOOL_NAME, { name: 'read_file', args: { path: 'a' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('call it directly');
  });
});
