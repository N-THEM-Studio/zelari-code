/**
 * extensionToolWiring.ts — CLI adapter between the core ExtensionAPI seam
 * (t30) and the safety-wrapped ToolRegistry.
 *
 * Two jobs, both ADDITIVE to the existing pipeline:
 *  1. {@link extensionToolToDefinition} turns a collected ExtensionToolSpec
 *     into a real ToolDefinition. The caller (toolRegistry.createBuiltinToolRegistry)
 *     pushes it through the SAME wrapWithPermissions path as builtin tools,
 *     so the declared permissions are intersected DOWN against the parent
 *     policy and the ContractCompiler capability layer still intersects
 *     LAST. An extension cannot widen anything, no matter what it declares.
 *  2. {@link withExtensionPreToolUse} wraps a tool's execute so the
 *     extension onPreToolUse handlers run BEFORE the tool body, with the
 *     t22 failure semantics (fail-open log+allow / fail-closed deny with
 *     reason 'extension-hook-failed') — the same resolveHookFailureMode
 *     that drives the JSON lifecycle hooks.
 *
 * @since 2.22.0 (t30)
 */

import type { ZodSchema } from 'zod';
import type {
  RegisteredExtensionTool,
  RegisteredPreToolUseHandler,
} from '@zelari/core/harness';
import type { HookFailureMode } from '@zelari/core/harness';
import { runExtensionPreToolUse } from '@zelari/core/harness';
import type {
  ToolContext,
  ToolDefinition,
  ToolPermission,
  TypedResult,
} from '@zelari/core/harness/tools/toolTypes';
import { typedErr } from '@zelari/core/harness/tools/toolTypes';

/**
 * Extension spec → ToolDefinition. The executor IGNORES the ToolContext
 * (extensions never see audit/signal internals) and the description is
 * prefixed with the owning extension id so the model — and audit trails —
 * can tell where the tool came from.
 */
export function extensionToolToDefinition(entry: RegisteredExtensionTool): ToolDefinition {
  const { spec, extensionId } = entry;
  return {
    name: spec.name,
    description: `[extension:${extensionId}] ${spec.description}`,
    permissions: [...spec.permissions] as ToolPermission[],
    inputSchema: spec.inputSchema as ZodSchema<unknown>,
    sideEffect: 'local',
    execute: async (input: unknown, _ctx: ToolContext): Promise<TypedResult<unknown>> =>
      spec.execute(input),
  };
}

export interface ExtensionPreToolUseWrapOptions {
  failureMode: HookFailureMode;
  logger?: (msg: string) => void;
}

/**
 * Wrap a tool definition so extension PreToolUse handlers observe (and may
 * deny) the call before the tool body runs. A deny becomes a typed
 * `{ ok: false, error: '[extension-hook:<id>] <reason>' }` — the tool
 * function is never invoked.
 */
export function withExtensionPreToolUse(
  handlers: readonly RegisteredPreToolUseHandler[],
  options: ExtensionPreToolUseWrapOptions,
): <I, O>(def: ToolDefinition<I, O>) => ToolDefinition<I, O> {
  return <I, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O> => ({
    ...def,
    execute: async (input: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      const verdict = await runExtensionPreToolUse(
        handlers,
        { toolName: def.name, toolInput: input },
        { failureMode: options.failureMode, logger: options.logger },
      );
      if (!verdict.ok) {
        return typedErr(
          `[extension-hook:${verdict.extensionId ?? 'unknown'}] ${verdict.reason ?? 'denied'}`,
        );
      }
      return def.execute(input, ctx);
    },
  });
}
