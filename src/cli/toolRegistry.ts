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
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
} from '@zelari/core/harness/tools/builtin/filesystem';
import { bashTool } from '@zelari/core/harness/tools/builtin/shell';
import { grepContentTool } from '@zelari/core/harness/tools/builtin/search';
import { listFilesTool } from '@zelari/core/harness/tools/builtin/listFiles';
import { showDiffTool, applyDiffTool } from '@zelari/core/harness/tools/builtin/diff';
import { fetchUrlTool, webSearchTool } from '@zelari/core/harness/tools/builtin/web';
import { resolveSandboxedPath, SandboxViolationError } from './safety/sandboxPath.js';
import { assertShellAllowed, ShellBlockedError } from './safety/shellBlocklist.js';
import { AuditLogger } from './safety/auditLogger.js';
import { runDiagnosticsForFile, formatDiagnostics, type Runner } from './diagnostics/engine.js';
import { createTaskTool } from './tools/taskTool.js';
import { createLspTools } from './lsp/tools.js';
import { getSharedLspManager, type LspProvider } from './lsp/manager.js';
import { createAstTools } from './ast/tools.js';
import { createSemanticTool } from './semantic/tools.js';
import { createBrowserTool } from './browser/tools.js';
import { providerFromEnv, openaiCompatibleProvider } from './provider/openai-compatible.js';
import type { ToolDefinition, TypedResult, ToolContext } from '@zelari/core/harness/tools/toolTypes';

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
  /**
   * Enable the post-edit diagnostics loop (fast file-scoped checker runs
   * after write_file/edit_file/apply_diff, appending errors to the result).
   * Defaults to true unless `ZELARI_DIAGNOSTICS=0` is set.
   */
  diagnostics?: boolean;
  /** Inject the diagnostics process runner (tests). Defaults to real spawn. */
  diagnosticsRunner?: Runner;
  /**
   * Read-only registry: register only observe tools (read/list/grep/show_diff/
   * fetch/web) and omit write/edit/apply_diff/bash + the `task` tool. Used to
   * build the isolated, non-recursive registry each sub-agent runs with.
   */
  readOnly?: boolean;
  /** Register the `task` sub-agent tool (default true unless readOnly). */
  enableTask?: boolean;
  /**
   * LSP navigation provider. Omit to use the shared, real language-server
   * manager; pass a fake in tests; pass `null` to disable the LSP tools.
   */
  lspProvider?: LspProvider | null;
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
  // Edit tools (write/edit/apply_diff) are ALSO wrapped with the diagnostics
  // loop: after a successful edit, a fast file-scoped checker runs on the
  // touched file and its errors/warnings are appended to the tool result so
  // the model sees compiler feedback in the same turn (opt out: ZELARI_DIAGNOSTICS=0).
  const diagnosticsOn = options.diagnostics ?? process.env.ZELARI_DIAGNOSTICS !== '0';
  const withDiag = <I extends Record<string, unknown>, O>(t: ToolDefinition<I, O>) =>
    diagnosticsOn ? wrapWithDiagnostics(t, root, options.diagnosticsRunner) : t;
  const safeReadFile = wrapWithSandbox(readFileTool, ['path'], root, audit, sessionId);
  const safeWriteFile = withDiag(wrapWithSandbox(writeFileTool, ['path'], root, audit, sessionId));
  const safeEditFile = withDiag(wrapWithSandbox(editFileTool, ['path'], root, audit, sessionId));
  const safeGrepContent = wrapWithSandbox(grepContentTool, ['path'], root, audit, sessionId);
  const safeListFiles = wrapWithSandbox(listFilesTool, ['path'], root, audit, sessionId);
  const safeShowDiff = wrapWithSandbox(showDiffTool, ['path'], root, audit, sessionId);
  const safeApplyDiff = withDiag(wrapWithSandbox(applyDiffTool, ['path'], root, audit, sessionId));

  // Wrap bash: shell blocklist + audit.
  const safeBash = wrapWithShellSafety(bashTool, audit, sessionId);

  // v0.7.5: network tools — audit-only wrap (no filesystem paths to sandbox;
  // the tools themselves enforce http(s)-only + timeout + size caps).
  const safeFetchUrl = wrapWithAudit(fetchUrlTool, audit, sessionId);
  const safeWebSearch = wrapWithAudit(webSearchTool, audit, sessionId);

  const registry = new ToolRegistry();
  // Read-only mode (used for sub-agents): only tools that observe the
  // workspace — no write/edit/apply_diff/bash, and no `task` tool, so a
  // sub-agent can neither mutate the repo nor recurse into more sub-agents.
  const readOnly = options.readOnly === true;

  // Observe tools — always registered.
  registry.register(safeReadFile);
  registry.register(safeGrepContent);
  registry.register(safeListFiles);
  registry.register(safeShowDiff);
  registry.register(safeFetchUrl);
  registry.register(safeWebSearch);
  // Mutating tools — full registry only.
  if (!readOnly) {
    registry.register(safeWriteFile);
    registry.register(safeEditFile);
    registry.register(safeBash);
    registry.register(safeApplyDiff);
  }

  const summary = readOnly
    ? [safeReadFile, safeGrepContent, safeListFiles, safeShowDiff, safeFetchUrl, safeWebSearch]
    : [
        safeReadFile,
        safeWriteFile,
        safeEditFile,
        safeBash,
        safeGrepContent,
        safeListFiles,
        safeShowDiff,
        safeApplyDiff,
        safeFetchUrl,
        safeWebSearch,
      ];
  const tools: BuiltinToolSummary[] = summary.map((t) => ({
    name: t.name,
    description: t.description,
    permissions: t.permissions ?? [],
  }));

  // AST structural tools (ast_outline, find_symbol) — read-only, so available
  // in BOTH the full registry and read-only sub-agents. Gated by ZELARI_AST.
  if (process.env.ZELARI_AST !== '0') {
    for (const t of createAstTools()) {
      registry.register(t);
      tools.push({ name: t.name, description: t.description, permissions: t.permissions ?? [] });
    }
  }

  // Semantic code search — read-only, available in both registries. Gated by
  // ZELARI_SEMANTIC. Needs a prior index (/index); the tool self-reports when
  // none exists, so it's always safe to register.
  if (process.env.ZELARI_SEMANTIC !== '0') {
    const semanticTool = createSemanticTool({ root });
    registry.register(semanticTool);
    tools.push({
      name: semanticTool.name,
      description: semanticTool.description,
      permissions: semanticTool.permissions ?? [],
    });
  }

  // Browser verification (browser_check) — full registry only (it drives a
  // real browser). Gated by ZELARI_BROWSER; self-reports install steps when
  // Playwright is absent, so it's safe to register unconditionally.
  if (!readOnly && process.env.ZELARI_BROWSER !== '0') {
    const browserTool = createBrowserTool();
    registry.register(browserTool);
    tools.push({
      name: browserTool.name,
      description: browserTool.description,
      permissions: browserTool.permissions ?? [],
    });
  }

  // The `task` sub-agent tool — only in the full (non-read-only) registry.
  // Each invocation spins up a fresh READ-ONLY sub-registry via this same
  // factory (readOnly:true), so sub-agents are isolated and non-recursive.
  if (!readOnly && options.enableTask !== false) {
    const taskTool = createTaskTool({
      createSubAgentContext: async () => {
        const cfg = await providerFromEnv();
        if (!cfg) return null;
        const { registry: subRegistry } = createBuiltinToolRegistry({
          root,
          audit,
          sessionId,
          readOnly: true,
          diagnostics: false,
        });
        return {
          providerStream: openaiCompatibleProvider(cfg),
          model: cfg.model,
          provider: 'openai-compatible',
          registry: subRegistry,
          tools: subRegistry.toOpenAITools().map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        };
      },
    });
    registry.register(taskTool);
    tools.push({
      name: taskTool.name,
      description: taskTool.description,
      permissions: taskTool.permissions ?? [],
    });
  }

  // LSP navigation tools (go_to_definition, find_references, hover_type,
  // document_symbols, rename_symbol). Full registry only, gated by
  // ZELARI_LSP. Backed by a shared, lazily-spawned language-server manager —
  // the servers start on first use and degrade silently when not installed.
  if (!readOnly && process.env.ZELARI_LSP !== '0' && options.lspProvider !== null) {
    const lspTools = options.lspProvider
      ? createLspTools(options.lspProvider, root)
      : createLspTools(getSharedLspManager(root), root);
    for (const t of lspTools) {
      registry.register(t);
      tools.push({ name: t.name, description: t.description, permissions: t.permissions ?? [] });
    }
  }

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
 * Wrap an edit tool (write_file / edit_file / apply_diff) with the
 * post-edit diagnostics loop. After a successful, non-dry-run edit, a fast
 * file-scoped checker runs on the touched file (`result.value.path`) and, if
 * it finds anything, a compact diagnostics block is appended to the result
 * value under `diagnostics`. The harness serializes the value into the tool
 * message, so the model sees compiler errors in the same turn and can fix
 * them immediately.
 *
 * Best-effort and non-blocking-by-design: unsupported file types, missing
 * linters, timeouts, and parse failures all yield no diagnostics and leave
 * the original result untouched. Never changes a failed result or a dryRun.
 */
function wrapWithDiagnostics<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  root: string,
  runner?: Runner,
): ToolDefinition<I, O> {
  return {
    ...original,
    execute: async (rawArgs: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      const result = await original.execute(rawArgs, ctx);
      if (!result.ok) return result;
      // A dry-run edit (apply_diff dryRun) writes nothing — nothing to check.
      if ((rawArgs as Record<string, unknown>).dryRun === true) return result;
      const value = result.value as { path?: unknown } | null;
      const filePath =
        value && typeof value === 'object' && typeof value.path === 'string'
          ? value.path
          : undefined;
      if (!filePath) return result;
      try {
        const timeoutMs = Number(process.env.ZELARI_DIAGNOSTICS_TIMEOUT_MS) || 5000;
        const diags = await runDiagnosticsForFile(filePath, {
          cwd: root,
          timeoutMs,
          ...(runner ? { runner } : {}),
        });
        const formatted = formatDiagnostics(diags, { relativeTo: root });
        if (formatted) {
          return {
            ok: true,
            value: { ...(value as Record<string, unknown>), diagnostics: formatted },
          } as TypedResult<O>;
        }
      } catch {
        // Diagnostics must never break an edit — swallow and return as-is.
      }
      return result;
    },
  };
}

/** Audit-only wrap for tools with no path/shell args (network tools). */
function wrapWithAudit<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  audit: AuditLogger,
  sessionId: string,
): ToolDefinition<I, O> {
  return {
    ...original,
    execute: async (rawArgs: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      try {
        return await audit.runTool({
          tool: original.name,
          args: redactForAudit(rawArgs as Record<string, unknown>),
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