/**
 * workspace/toolRegistry.ts — Adapter that wraps workspace
 * `EnhancedToolDefinition` stubs as `ToolDefinition`s so they can be
 * registered with the standard `ToolRegistry` used by `runCouncilPure`.
 *
 * The ToolRegistry expects:
 *  - Zod-based `inputSchema`
 *  - `execute(input, ctx) => Promise<TypedResult<O>>`
 *  - `permissions: ToolPermission[]`
 *
 * Our workspace stubs use `execute(args, ctx) => string` with no Zod schema.
 * This adapter bridges them with `z.any()` (since the LLM is the one
 * shaping args via tool calling) and `permissions: []`.
 */

import { z } from 'zod';
import { ToolRegistry } from '../../main/core/tools/registry.js';
import { typedOk, typedErr, type TypedResult } from '../../main/core/tools/toolTypes.js';
import type { EnhancedToolDefinition } from '../../types/systemTypes.js';
import type { WorkspaceContext } from './types.js';
import { createWorkspaceStubs } from './stubs.js';

/** Build a ToolRegistry containing the workspace stubs bound to ctx. */
export function createWorkspaceToolRegistry(ctx: WorkspaceContext): ToolRegistry {
  const stubs = createWorkspaceStubs(ctx);
  const registry = new ToolRegistry();
  for (const stub of stubs) {
    const td = adaptStubToToolDefinition(stub, ctx);
    registry.register(td);
  }
  return registry;
}

/** Adapt one EnhancedToolDefinition stub into a ToolDefinition. */
function adaptStubToToolDefinition(
  stub: EnhancedToolDefinition,
  workspaceCtx: WorkspaceContext,
) {
  return {
    name: stub.name,
    description: stub.description,
    permissions: [],
    // The LLM shapes the args via tool calling; we trust the JSON shape.
    // Validating strictly here would block legitimate council output.
    inputSchema: z.any(),
    execute: async (input: unknown): Promise<TypedResult<string>> => {
      try {
        const args = (input as Record<string, unknown>) ?? {};
        // Execute the stub. The stub's execute may be sync or async.
        // EnhancedToolDefinition expects a ToolContext; we cast through
        // `unknown` because our WorkspaceContext is a structural subset
        // (the stub only reads `storage` + `rootDir`).
        const result = await Promise.resolve(
          stub.execute(args, workspaceCtx as unknown as Parameters<typeof stub.execute>[1]),
        );
        return typedOk(result);
      } catch (err) {
        return typedErr(
          `[${stub.name}] ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}