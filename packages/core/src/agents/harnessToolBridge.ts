/**
 * harnessToolBridge — expose the harness builtin tools (filesystem, shell,
 * search, diff, web) in the agents tool catalog (v0.7.5).
 *
 * ROOT CAUSE this fixes (live test 2026-07-03): council roles declare
 * `tools: ['read_file', 'list_files', 'grep_content']`, and the CLI's
 * executor ToolRegistry implements them — but `getAllTools()` only knew the
 * vault/planner/mind-map catalog. `getToolDescriptions()` silently skipped
 * unknown names and `getProviderTools()` dropped them, so council members
 * were told "you operate on a real codebase" while their AVAILABLE TOOLS
 * section contained NO file tools at all. The models then hallucinated the
 * names they knew from other stacks (`Read`, `Glob`, `list_dir`).
 *
 * The bridge derives EnhancedToolDefinitions from the REAL builtin tool
 * definitions (same descriptions, JSON Schemas generated from their zod
 * schemas), so prompt text, provider schemas, and executor behavior can
 * never drift apart again.
 *
 * The `execute` here is a guard, not an implementation: in the CLI the
 * harness executes these via its ToolRegistry; catalog execution is only
 * reachable in legacy Electron paths that never advertised these names.
 */

import { zodToJsonSchema } from '../core/tools/zodBridge.js';
import type { ToolDefinition as HarnessToolDefinition } from '../core/tools/toolTypes.js';
import { readFileTool, writeFileTool, editFileTool } from '../core/tools/builtin/filesystem.js';
import { bashTool } from '../core/tools/builtin/shell.js';
import { grepContentTool } from '../core/tools/builtin/search.js';
import { listFilesTool } from '../core/tools/builtin/listFiles.js';
import { showDiffTool, applyDiffTool } from '../core/tools/builtin/diff.js';
import { fetchUrlTool, webSearchTool } from '../core/tools/builtin/web.js';
import type { EnhancedToolDefinition } from '../types/index.js';

const HARNESS_TOOLS: HarnessToolDefinition<never, unknown>[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  bashTool,
  grepContentTool,
  listFilesTool,
  showDiffTool,
  applyDiffTool,
  fetchUrlTool,
  webSearchTool,
] as unknown as HarnessToolDefinition<never, unknown>[];

function toEnhanced(tool: HarnessToolDefinition<never, unknown>): EnhancedToolDefinition {
  const schema = zodToJsonSchema(tool.inputSchema) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name: tool.name,
    description: tool.description,
    category: 'core',
    parameters: {
      type: 'object',
      properties: schema.properties ?? {},
      required: schema.required ?? [],
    },
    execute: () =>
      `Tool "${tool.name}" must be executed through the harness ToolRegistry (CLI), not the agents catalog.`,
  };
}

/** Harness builtin tools as catalog entries (fresh array each call). */
export function getHarnessToolDefinitions(): EnhancedToolDefinition[] {
  return HARNESS_TOOLS.map(toEnhanced);
}
