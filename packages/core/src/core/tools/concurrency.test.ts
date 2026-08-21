import { describe, it, expect } from 'vitest';
import { classifyToolConcurrency } from './concurrency.js';

describe('classifyToolConcurrency', () => {
  it('marks read-only registry tools parallel-safe', () => {
    expect(
      classifyToolConcurrency({ toolName: 'read_file', permissions: ['read'], registered: true }),
    ).toBe('parallel-safe');
    expect(
      classifyToolConcurrency({
        toolName: 'grep_content',
        permissions: ['read'],
        registered: true,
      }),
    ).toBe('parallel-safe');
  });

  it('marks write/execute tools exclusive', () => {
    expect(
      classifyToolConcurrency({
        toolName: 'write_file',
        permissions: ['write'],
        registered: true,
      }),
    ).toBe('exclusive');
    expect(
      classifyToolConcurrency({
        toolName: 'bash',
        permissions: ['execute'],
        registered: true,
      }),
    ).toBe('exclusive');
  });

  it('task explore/verify (default explore) are parallel-safe; general is exclusive', () => {
    expect(classifyToolConcurrency({ toolName: 'task', args: { prompt: 'x' } })).toBe(
      'parallel-safe',
    );
    expect(
      classifyToolConcurrency({ toolName: 'task', args: { agent: 'explore', prompt: 'x' } }),
    ).toBe('parallel-safe');
    expect(
      classifyToolConcurrency({ toolName: 'task', args: { agent: 'verify', prompt: 'x' } }),
    ).toBe('parallel-safe');
    expect(
      classifyToolConcurrency({ toolName: 'task', args: { agent: 'general', prompt: 'x' } }),
    ).toBe('exclusive');
  });

  it('unknown non-MCP tools are exclusive; search-like MCP is parallel-safe', () => {
    expect(classifyToolConcurrency({ toolName: 'mystery', registered: false })).toBe('exclusive');
    expect(classifyToolConcurrency({ toolName: 'mcp_search_docs', registered: false })).toBe(
      'parallel-safe',
    );
    expect(classifyToolConcurrency({ toolName: 'mcp_write_note', registered: false })).toBe(
      'exclusive',
    );
  });

  it('ZELARI_PARALLEL_TOOLS=0 forces exclusive', () => {
    expect(
      classifyToolConcurrency({
        toolName: 'read_file',
        permissions: ['read'],
        registered: true,
        env: { ZELARI_PARALLEL_TOOLS: '0' },
      }),
    ).toBe('exclusive');
  });
});
