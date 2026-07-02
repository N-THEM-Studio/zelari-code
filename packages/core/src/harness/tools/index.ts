/**
 * @zelari/core/harness/tools — built-in tools registry.
 * Includes ToolRegistry class + the 5 default tools (filesystem, shell, search,
 * listFiles, diff) + their shared types.
 *
 * `ToolContext` is intentionally NOT re-exported here: the authoritative
 * version lives in `@zelari/core/types` (re-exported via `systemTypes.ts`
 * from `agents/tools.ts`). Re-exporting the local `core/tools/toolTypes.ts`
 * copy too would create an ambiguous re-export at the root `index.ts`
 * barrel (v0.6.2 audit CRITICAL-1 follow-up).
 */
export * from '../../core/tools/registry.js';
// Re-export everything from toolTypes EXCEPT ToolContext to avoid the
// conflict described above. Add new types here as needed. Using `export
// type` because isolatedModules requires it for type-only re-exports.
export type {
  TypedResult,
  ToolPermission,
  ToolDefinition,
  AuditEntry,
} from '../../core/tools/toolTypes.js';
export { typedOk, typedErr } from '../../core/tools/toolTypes.js';
export * from '../../core/tools/builtin/filesystem.js';
export * from '../../core/tools/builtin/shell.js';
export * from '../../core/tools/builtin/search.js';
export * from '../../core/tools/builtin/listFiles.js';
export * from '../../core/tools/builtin/diff.js';
