import { describe, it, expect } from 'vitest';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';

describe('createBuiltinToolRegistry (Task A1)', () => {
  it('registers all builtin tools (filesystem + bash + search + diff + web + task + ast + ssh)', () => {
    const { registry, tools } = createBuiltinToolRegistry({ lspProvider: null });
    const expected = [
      'apply_diff',
      'ast_outline',
      'bash',
      'browser_check',
      'edit_file',
      'fetch_url',
      'find_symbol',
      'grep_content',
      'list_files',
      'read_file',
      'semantic_search',
      'show_diff',
      'ssh_run',
      'ssh_status',
      'task',
      'web_search',
      'write_file',
    ];
    expect(registry.list().sort()).toEqual(expected);
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });

  it('adds the 5 LSP navigation tools when an LSP provider is available', () => {
    const { registry } = createBuiltinToolRegistry({ lspProvider: null });
    const withoutLsp = registry.list().length;
    // A truthy provider (here the default shared manager) adds the LSP tools.
    const { registry: withLsp } = createBuiltinToolRegistry();
    expect(withLsp.list().length).toBe(withoutLsp + 5);
    for (const name of ['go_to_definition', 'find_references', 'hover_type', 'document_symbols', 'rename_symbol']) {
      expect(withLsp.get(name)).toBeDefined();
    }
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
    const { registry } = createBuiltinToolRegistry({ lspProvider: null });
    const openAITools = registry.toOpenAITools();
    expect(openAITools).toHaveLength(17);
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
