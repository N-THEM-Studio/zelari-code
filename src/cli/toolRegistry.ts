/**
 * toolRegistry — default ToolRegistry for the zelari-code CLI.
 *
 * Wires the 8 built-in tools (filesystem read/write/edit + bash + grep/list +
 * show_diff/apply_diff) into a ToolRegistry instance that the AgentHarness can
 * hand to the provider via `tools: registry.toOpenAITools()` + `toolRegistry: registry`.
 *
 * Task A1 of AnathemaCoder v3-A: enable the existing tool pipeline.
 * Task A2 of v3-A: wrap each tool with the safety layer (sandbox path,
 * shell blocklist, audit log).
 * v0.4.0: added show_diff + apply_diff + recursive grep_content.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3.md (Tasks A1 + A2)
 * @see docs/plans/2026-07-01-v0-4-0-fix-audit.md (v0.4.0 scope)
 */
import { ToolRegistry } from '../main/core/tools/registry.js';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
} from '../main/core/tools/builtin/filesystem.js';
import { bashTool } from '../main/core/tools/builtin/shell.js';
import { grepContentTool } from '../main/core/tools/builtin/search.js';
import { listFilesTool } from '../main/core/tools/builtin/listFiles.js';
import { showDiffTool, applyDiffTool } from '../main/core/tools/builtin/diff.js';
import { resolveSandboxedPath, SandboxViolationError } from './safety/sandboxPath.js';
import { assertShellAllowed, ShellBlockedError } from './safety/shellBlocklist.js';
import { AuditLogger } from './safety/auditLogger.js';
import type { ToolDefinition, TypedResult, ToolContext } from '../main/core/tools/toolTypes.js';

export interface BuiltinToolSummary {
  /** Tool name as registered. */
  name: string;
  /** Tool description. */
  description: string;
  /** Required permission (read | write | execute). */
  permissions: readonly string[];
}

export interface CreateRegistryOptions {
  /** Sandbox root. Defaults to process.cwd(). */
  root?: string;
  /** Audit logger instance. If omitted, creates a default file-backed one. */
  audit?: AuditLogger;
  /** Session id used in audit entries. */
  sessionId?: string;
}

/**
 * Create a fresh ToolRegistry pre-populated with the 5 built-in tools,
 * each wrapped with the safety layer (Task A2).
 *
 * Safety policy applied:
 *  - filesystem tools: resolveSandboxedPath() on every path arg; throws
 *    SandboxViolationError if the path escapes the root.
 *  - bash: assertShellAllowed() on the command; throws ShellBlockedError
 *    on any blocklist match.
 *  - every tool: AuditLogger.runTool() wraps the call to record ts,
 *    args (redacted), ok, duration, summary.
 */
export function createBuiltinToolRegistry(
  options: CreateRegistryOptions = {},
): { registry: ToolRegistry; tools: BuiltinToolSummary[] } {
  const root = options.root ?? process.cwd();
  const audit = options.audit ?? new AuditLogger();
  const sessionId = options.sessionId ?? 'cli';

  // Wrap filesystem tools: sandbox the path argument before delegating.
  const safeReadFile = wrapWithSandbox(readFileTool, ['path'], root, audit, sessionId);
  const safeWriteFile = wrapWithSandbox(writeFileTool, ['path'], root, audit, sessionId);
  const safeEditFile = wrapWithSandbox(editFileTool, ['path'], root, audit, sessionId);
  const safeGrepContent = wrapWithSandbox(grepContentTool, ['path'], root, audit, sessionId);
  const safeListFiles = wrapWithSandbox(listFilesTool, ['path'], root, audit, sessionId);
  const safeShowDiff = wrapWithSandbox(showDiffTool, ['path'], root, audit, sessionId);
  const safeApplyDiff = wrapWithSandbox(applyDiffTool, ['path'], root, audit, sessionId);

  // Wrap bash: shell blocklist + audit.
  const safeBash = wrapWithShellSafety(bashTool, audit, sessionId);

  const registry = new ToolRegistry();
  registry.register(safeReadFile);
  registry.register(safeWriteFile);
  registry.register(safeEditFile);
  registry.register(safeBash);
  registry.register(safeGrepContent);
  registry.register(safeListFiles);
  registry.register(safeShowDiff);
  registry.register(safeApplyDiff);

  const tools: BuiltinToolSummary[] = [
    safeReadFile,
    safeWriteFile,
    safeEditFile,
    safeBash,
    safeGrepContent,
    safeListFiles,
    safeShowDiff,
    safeApplyDiff,
  ].map((t) => ({
    name: t.name,
    description: t.description,
    permissions: t.permissions ?? [],
  }));
  return { registry, tools };
}

/**
 * Wrap a tool so that the named string args are validated through
 * resolveSandboxedPath() before the original execute() runs. The path
 * arg is rewritten to its resolved form so the tool sees the absolute
 * sandboxed path.
 */
function wrapWithSandbox<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  pathArgs: readonly string[],
  root: string,
  audit: AuditLogger,
  sessionId: string,
): ToolDefinition<I, O> {
  return {
    ...original,
    execute: async (rawArgs: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      // Pre-flight: sandbox all path args; rewrite them in-place.
      const args = rawArgs as Record<string, unknown>;
      for (const key of pathArgs) {
        const v = args[key];
        if (typeof v === 'string' && v.length > 0) {
          try {
            args[key] = resolveSandboxedPath(v, { root });
          } catch (err) {
            if (err instanceof SandboxViolationError) {
              // Audit + return typedErr so the caller gets a friendly error.
              await audit.append({
                ts: new Date().toISOString(),
                sessionId,
                tool: original.name,
                args: redactForAudit(args),
                ok: false,
                resultSummary: err.message,
                durationMs: 0,
                error: 'sandbox_violation',
              });
              return {
                ok: false,
                error: `[sandbox] ${err.message}`,
              } as TypedResult<O>;
            }
            throw err;
          }
        }
      }
      // Audit-wrapped execution.
      try {
        return await audit.runTool({
          tool: original.name,
          args: redactForAudit(args),
          sessionId,
          fn: () => original.execute(rawArgs, ctx),
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as TypedResult<O>;
      }
    },
  };
}

/**
 * Wrap the bash tool: assertShellAllowed() runs before execute(), and
 * every invocation is audited.
 */
function wrapWithShellSafety<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  audit: AuditLogger,
  sessionId: string,
): ToolDefinition<I, O> {
  return {
    ...original,
    execute: async (rawArgs: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      const args = rawArgs as Record<string, unknown>;
      const cmd = args['command'];
      if (typeof cmd === 'string') {
        try {
          assertShellAllowed(cmd);
        } catch (err) {
          if (err instanceof ShellBlockedError) {
            await audit.append({
              ts: new Date().toISOString(),
              sessionId,
              tool: original.name,
              args: redactForAudit(args),
              ok: false,
              resultSummary: err.message,
              durationMs: 0,
              error: 'shell_blocked',
            });
            return {
              ok: false,
              error: `[shell-blocked] ${err.message}`,
            } as TypedResult<O>;
          }
          throw err;
        }
      }
      try {
        return await audit.runTool({
          tool: original.name,
          args: redactForAudit(args),
          sessionId,
          fn: () => original.execute(rawArgs, ctx),
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as TypedResult<O>;
      }
    },
  };
}

function redactForAudit(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (/(api[_-]?key|secret|token|password)/i.test(k) && typeof v === 'string') {
      out[k] = '***';
    } else if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + '…';
    } else {
      out[k] = v;
    }
  }
  return out;
}