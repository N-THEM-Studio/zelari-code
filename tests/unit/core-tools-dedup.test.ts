/**
 * core-tools-dedup.test.ts — v0.7.1 regression for the /council HTTP 400.
 *
 * Root cause: `getAllTools()` returned `[..._allTools, ..._workspaceStubs]`
 * without deduping by name. The CLI council path registers workspace stubs
 * (`createPhase`, `createTask`, …) that share names with the core builtin
 * planner tools, so `getProviderTools()` emitted two function entries per
 * name and xAI rejected the request with HTTP 400
 * "Duplicate function definition provided".
 *
 * The in-memory `Map` (rebuildIndex) silently let stubs shadow builtins, but
 * the wire-format array did not — this test pins the array contract too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getAllTools,
  getAvailableTools,
  setWorkspaceStubs,
} from '@zelari/core/skills';
import { getProviderTools } from '@zelari/core/skills';
import type { EnhancedToolDefinition } from '@zelari/core/types';

const STUB_EXEC = (): string => 'stub';

/** Build a minimal stub matching the EnhancedToolDefinition contract. */
function stub(name: string, description = 'stub'): EnhancedToolDefinition {
  return {
    name,
    description,
    category: 'custom',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: STUB_EXEC,
  };
}

describe('getAllTools — dedup by name (v0.7.1 /council HTTP 400 fix)', () => {
  afterEach(() => {
    // Reset workspace stubs so tests don't leak into each other.
    setWorkspaceStubs([]);
  });

  it('returns unique names even when a workspace stub shadows a builtin', () => {
    // createPhase is a core builtin planner tool; register a same-named stub.
    setWorkspaceStubs([stub('createPhase', 'workspace stub')]);
    const all = getAllTools();
    const names = all.map((t) => t.name);
    // No duplicates — the xAI 400 was caused by createPhase appearing twice.
    expect(new Set(names).size).toBe(names.length);
    // The stub wins (consistent with the rebuildIndex Map semantics).
    const phase = all.find((t) => t.name === 'createPhase');
    expect(phase?.description).toBe('workspace stub');
  });

  it('getProviderTools returns exactly one entry per requested name', () => {
    setWorkspaceStubs([stub('createPhase', 'ws'), stub('createTask', 'ws')]);
    // The council chairman declares all seven planner tools; request a mix
    // that includes both shadowed and non-shadowed names.
    const providerTools = getProviderTools(['createPhase', 'createTask', 'addIdea']);
    const names = providerTools.map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['createPhase', 'createTask', 'addIdea']));
    // Exactly one createPhase — never two (this is what xAI rejected).
    expect(names.filter((n) => n === 'createPhase')).toHaveLength(1);
  });

  it('getAvailableTools resolves a shadowed name to a single definition', () => {
    setWorkspaceStubs([stub('createPhase', 'ws-shadow')]);
    const resolved = getAvailableTools(['createPhase']);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.description).toBe('ws-shadow');
  });

  it('with no stubs, builtin planner tools are unique', () => {
    setWorkspaceStubs([]);
    const all = getAllTools();
    const names = all.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    // Sanity: the planner tools the council relies on are present.
    expect(names).toEqual(expect.arrayContaining([
      'createPhase', 'createTask', 'addIdea',
    ]));
  });
});
