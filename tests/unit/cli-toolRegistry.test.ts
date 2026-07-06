import { describe, it, expect } from 'vitest';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';

describe('createBuiltinToolRegistry (Task A1)', () => {
  it('registers all 11 builtin tools (filesystem + bash + search + diff + web + task)', () => {
    const { registry, tools } = createBuiltinToolRegistry();
    const expected = [
      'apply_diff',
      'bash',
      'edit_file',
      'fetch_url',
      'grep_content',
      'list_files',
      'read_file',
      'show_diff',
      'task',
      'web_search',
      'write_file',
    ];
    expect(registry.list().sort()).toEqual(expected);
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });

  it('each tool summary has a non-empty name, description, and permissions', () => {
    const { tools } = createBuiltinToolRegistry();
    for (const t of tools) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.permissions.length).toBeGreaterThan(0);
    }
  });

  it('toOpenAITools() returns OpenAI function-calling shape for every tool', () => {
    const { registry } = createBuiltinToolRegistry();
    const openAITools = registry.toOpenAITools();
    expect(openAITools).toHaveLength(11);
    for (const t of openAITools) {
      expect(t.type).toBe('function');
      expect(t.function.name.length).toBeGreaterThan(0);
      expect(t.function.description.length).toBeGreaterThan(0);
      expect(typeof t.function.parameters).toBe('object');
    }
  });

  it('returns a fresh registry per call (no shared singleton state)', () => {
    const { registry: r1 } = createBuiltinToolRegistry();
    const { registry: r2 } = createBuiltinToolRegistry();
    expect(r1).not.toBe(r2);
    // Same tool names but different instances
    expect(r1.list()).toEqual(r2.list());
  });
});