import { describe, expect, it } from 'vitest';
import type { AgentMessage, ProviderStreamFn } from '@zelari/core/harness';
import { measureRequest, withRequestComposition, type RequestComposition } from './requestComposition.js';

const messages: AgentMessage[] = [
  { role: 'system', content: 'STABLE' },
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] },
  { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(100) },
  { role: 'assistant', content: 'done', toolCalls: [{ id: 'c2', name: 'bash', args: { command: 'ls' } }] },
  { role: 'tool', toolCallId: 'c2', content: 'y'.repeat(40) },
  { role: 'user', content: '<context-update>\nws\n</context-update>' },
  { role: 'user', content: 'next' },
  { role: 'system', content: 'RESOURCE STATUS' },
] as AgentMessage[];

const tools = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
  { name: 'mcp_github_search', description: '[MCP:github] search', parameters: { type: 'object' } },
];

describe('measureRequest', () => {
  it('splits the request by source and names the tool-result producers', () => {
    const c = measureRequest({ messages, tools });
    expect(c.systemChars).toBe('STABLE'.length + 'RESOURCE STATUS'.length);
    expect(c.userChars).toBe('first question'.length + 'next'.length);
    expect(c.trailingChars).toBe('<context-update>\nws\n</context-update>'.length);
    expect(c.toolResultChars).toBe(140);
    expect(c.toolResultsByTool).toEqual({ read_file: 100, bash: 40 });
    expect(c.assistantChars).toBe('done'.length + JSON.stringify({ path: 'a.ts' }).length + JSON.stringify({ command: 'ls' }).length);
    expect(c.toolsCount).toBe(2);
    expect(c.mcpToolsCount).toBe(1);
    expect(c.mcpToolsChars).toBeGreaterThan(0);
    expect(c.mcpToolsChars).toBeLessThan(c.toolsChars);
    expect(c.totalChars).toBe(
      c.systemChars + c.toolsChars + c.trailingChars + c.userChars + c.assistantChars + c.toolResultChars,
    );
  });
});

describe('withRequestComposition', () => {
  it('measures each request before streaming it, unchanged', async () => {
    const seen: RequestComposition[] = [];
    const inner: ProviderStreamFn = async function* () {
      yield { kind: 'text', delta: 'hi' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const stream = withRequestComposition(inner, (c) => seen.push(c));
    const out: string[] = [];
    for await (const d of stream({ messages, tools, model: 'm', provider: 'p' })) {
      if (d.kind === 'text') out.push(d.delta);
    }
    expect(out).toEqual(['hi']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolsCount).toBe(2);
  });

  it('never lets a throwing callback break the request', async () => {
    const inner: ProviderStreamFn = async function* () {
      yield { kind: 'finish', reason: 'stop' };
    };
    const stream = withRequestComposition(inner, () => {
      throw new Error('boom');
    });
    const kinds: string[] = [];
    for await (const d of stream({ messages, tools: [], model: 'm', provider: 'p' })) kinds.push(d.kind);
    expect(kinds).toEqual(['finish']);
  });
});
