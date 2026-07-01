/**
 * workspace/toolRegistry.ts — Adapter that wraps workspace
 * `EnhancedToolDefinition` stubs as `ToolDefinition`s so they can be
 * registered with the standard `ToolRegistry` used by `runCouncilPure`.
 *
 * The ToolRegistry expects:
 *  - Zod-based `inputSchema`
 *  - `execute(input, ctx) => Promise<TypedResult<O>>` where ctx is a `ToolContext`
 *  - `permissions: ToolPermission[]`
 *
 * Our workspace stubs use `execute(args, ctx) => string` reading
 * `ctx.storage` and `ctx.rootDir` (a WorkspaceContext shape). This
 * adapter bridges them by combining the `WorkspaceContext` (closed-over
 * at registry creation) with the runtime `ToolContext` (passed per
 * invocation), so the stub sees both: filesystem operations go through
 * the closed-over workspace ctx, while `audit`/`cwd`/`sessionId` come
 * from the per-call ToolContext.
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
    execute: async (input: unknown, runtimeCtx?: unknown): Promise<TypedResult<string>> => {
      try {
        const args = (input as Record<string, unknown>) ?? {};
        // The harness passes a ToolContext ({ cwd, audit, sessionId, signal }).
        // The workspace stubs need a WorkspaceContext ({ rootDir, projectRoot, storage }).
        // We merge: closed-over workspace ctx for filesystem ops, runtime ctx
        // surfaced via a `runtime` property for stubs that want to log/audit.
        const mergedCtx = Object.assign(Object.create(workspaceCtx), {
          runtime: runtimeCtx,
        });
        const result = await Promise.resolve(
          stub.execute(args, mergedCtx as unknown as Parameters<typeof stub.execute>[1]),
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