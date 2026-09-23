import { zodToJsonSchema } from './zodBridge.js';
import type { LifecycleHookRunner } from '../hooks/index.js';
import { compactToolResult } from './observationCompactor.js';
import { typedErr, type ToolDefinition, type ToolContext, type TypedResult } from './toolTypes.js';
import { SchemaRepairGuard, buildCappedError, buildSchemaHint } from './schemaRepairGuard.js';
import type { SessionEventInput } from '../../session/types.js';
import type { ToolFingerprint } from '../../runtime/fingerprints.js';

export { spillToolOutput, resolveToolOutputDir, isToolSpillEnabled } from './toolOutputSpill.js';
export {
  truncateToolResult,
  compactToolResult,
  TOOL_RESULT_LINE_CAP,
  type TruncateToolResultOptions,
} from './observationCompactor.js';

export interface InvokeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  sessionId?: string;
  /** Optional tool name for spill file naming (defaults to invoked name). */
  toolName?: string;
  /**
   * WS7 slice 4b (t139): optional session-spine sink, forwarded verbatim to
   * `ToolContext.emitSessionEvent` for the duration of this ONE call. Additive
   * and optional by contract — omitting it leaves the ctx byte-identical to
   * before, and every consumer of those emitters already treats a missing sink
   * as "record nothing" (file.* telemetry, permission/decision events).
   *
   * WHY an invoke option and not a registry field: the sink is per-turn (one
   * session writer per turn) and travels with the CALL. Hosts that own the
   * dispatch — tests, the Electron/legacy callers, any future non-harness
   * plumbing — hand it in here. The CLI cannot: `AgentHarness` sits between its
   * hosts and `invoke` and forwards no host sink, so the CLI populates this SAME
   * ctx field in its own outermost tool wrapper instead (see
   * `src/cli/safety/sessionSink.ts`).
   */
  emitSessionEvent?: (input: SessionEventInput) => Promise<unknown>;
}

/**
 * t57 (ADR 0022 seams): payload handed to the in-process post-result
 * listener. Deliberately minimal — the CLI host (e.g. TaskTouchGuard) only
 * needs to know which tool ran, with which validated input, and whether it
 * produced a result (ok:true) or an error (ok:false).
 */
export interface ToolResultEvent {
  toolName: string;
  toolInput: unknown;
  ok: boolean;
}

/** Same-process observer notified after every tool result. Null unsubscribes. */
export type ToolResultListener = (event: ToolResultEvent) => void;

/**
 * Common hallucinated tool names → canonical registry names. Models trained
 * on other agent stacks routinely call `Read`/`Glob` (Claude Code), `list_dir`
 * (Cursor), or legacy Electron-era names (`searchRAG`) — each such call burns
 * a per-turn tool-budget slot on a guaranteed failure (live test 2026-07-03).
 * The alias map turns the failure into a one-step recovery: the error names
 * the intended tool explicitly ("Did you mean …").
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  read: 'read_file',
  readfile: 'read_file',
  cat: 'read_file',
  write: 'write_file',
  writefile: 'write_file',
  edit: 'edit_file',
  editfile: 'edit_file',
  glob: 'list_files',
  listdir: 'list_files',
  listdirectory: 'list_files',
  ls: 'list_files',
  dir: 'list_files',
  find: 'list_files',
  grep: 'grep_content',
  search: 'grep_content',
  searchrag: 'searchDocuments',
  rag: 'searchDocuments',
  shell: 'bash',
  terminal: 'bash',
  cmd: 'bash',
  run: 'bash',
  exec: 'bash',
};

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  /** v0.10.0: lifecycle hooks (PreToolUse/PostToolUse). Null = no hooks. */
  private lifecycleHooks: LifecycleHookRunner | null = null;
  /** t57: in-process post-result listener (null = none). */
  private toolResultListener: ToolResultListener | null = null;
  /**
   * K4.4 (F26): per-tool schema-violation counter — structured hint at 3,
   * tool disabled at 6 (see schemaRepairGuard.ts).
   */
  private schemaRepair = new SchemaRepairGuard();
  /**
   * Memoized toOpenAITools() result, invalidated on register(). The zod →
   * JSON-schema conversion is recursive and runs for ~20 tools twice per
   * user turn plus once per spawned sub-agent — callers treat the returned
   * array and its objects as immutable (providers wrap, never mutate).
   */
  private openAIToolsCache: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> | null = null;

  register<I, O>(def: ToolDefinition<I, O>): void {
    this.tools.set(def.name, def as ToolDefinition);
    this.openAIToolsCache = null;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * v0.10.0: attach the lifecycle hook runner (null to disable).
   * v2.16 (t22): the runner's failureMode decides what a THROWING runner
   * means — fail-closed denies the call, fail-open (default) allows it.
   */
  setLifecycleHooks(runner: LifecycleHookRunner | null): void {
    this.lifecycleHooks = runner;
  }

  getLifecycleHooks(): LifecycleHookRunner | null {
    return this.lifecycleHooks;
  }

  /**
   * t57 (ADR 0022 seams): in-process, zero-config post-result observer.
   * Unlike PostToolUse hooks this runs in the same process with no JSON
   * protocol — meant for CLI hosts (e.g. TaskTouchGuard matching writes
   * against plan.json globs). Fail-open: a throwing listener never breaks
   * the tool result. Pass null to unsubscribe.
   */
  setToolResultListener(listener: ToolResultListener | null): void {
    this.toolResultListener = listener;
  }

  /**
   * K4.4 (F26): re-arm the schema-repair cap at a host-owned turn/run
   * boundary (see schemaRepairGuard.ts).
   */
  resetSchemaRepair(): void {
    this.schemaRepair.reset();
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Resolve a hallucinated tool name to a registered one, or null.
   * Case/underscore-insensitive so `Read`, `list_dir`, `Search_RAG` all map.
   */
  private suggestFor(name: string): string | null {
    const normalized = name.toLowerCase().replace(/[_-]/g, '');
    const target = TOOL_NAME_ALIASES[normalized];
    return target && this.tools.has(target) ? target : null;
  }

  /** Invoke a tool with validated input + timeout + audit + permissions check. */
  async invoke<O>(
    name: string,
    rawInput: unknown,
    options: InvokeOptions = {},
  ): Promise<TypedResult<O>> {
    const tool = this.tools.get(name);
    if (!tool) {
      const suggestion = this.suggestFor(name);
      return typedErr(
        `Tool "${name}" not found.` +
          (suggestion ? ` Did you mean "${suggestion}"? Retry with that exact name.` : '') +
          ` Available: ${this.list().join(', ')}`,
      );
    }

    // K4.4 (F26): schema-repair cap — a tool that kept receiving invalid
    // input is disabled after the cap (guard code tool_schema_repair_capped +
    // escalation directive) instead of iterating silently until
    // maxToolCallsPerTurn. Short-circuits BEFORE validation: even valid input
    // cannot revive a capped tool this run.
    if (this.schemaRepair.isCapped(name)) {
      return typedErr(buildCappedError(name, this.schemaRepair.violations(name)));
    }

    // Zod validation
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      // K4.4 (F26): plain error → structured hint (schema + example) at the
      // hint threshold → capped error at the cap. Never a silent plain loop.
      const state = this.schemaRepair.record(name);
      const addendum =
        state.kind === 'hint'
          ? `\n${buildSchemaHint(name, state.violations, tool.jsonSchema ?? zodToJsonSchema(tool.inputSchema), tool.description)}`
          : state.kind === 'capped'
            ? `\n${buildCappedError(name, state.violations)}`
            : '';
      return typedErr(`Invalid input: ${parsed.error.message}` + addendum);
    }

    // Timeout + cancellation. Use a *child* AbortController so a tool timeout
    // stops that tool (and nested tentacles) without aborting the parent harness.
    const timeoutMs = options.timeoutMs ?? tool.timeoutMs ?? 30000;
    const parentSignal = options.signal;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectRace: ((err: Error) => void) | undefined;
    const onParentAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
      rejectRace?.(new Error(`Tool "${name}" aborted`));
    };
    if (parentSignal) {
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener('abort', onParentAbort);
    }

    const ctx: ToolContext = {
      signal: controller.signal,
      cwd: options.cwd ?? process.cwd(),
      audit: () => { /* audit log injected externally */ },
      sessionId: options.sessionId ?? 'default',
      // WS7 slice 4b (t139): additive-optional. Present ONLY when the caller
      // passed a sink, so an invoke without it produces the exact ctx it always
      // did (field absent, not undefined-valued). Tools and wrappers read it as
      // `ctx.emitSessionEvent` and skip telemetry when it is missing.
      ...(options.emitSessionEvent ? { emitSessionEvent: options.emitSessionEvent } : {}),
    };

    // v0.10.0: PreToolUse lifecycle hooks — deny blocks the tool.
    // v2.16 (t22): a THROWING runner follows the runner's failureMode:
    // fail-closed ⇒ typedErr deny before execute; fail-open (default) ⇒ log
    // + allow, exactly as before.
    if (this.lifecycleHooks) {
      try {
        const pre = await this.lifecycleHooks.runPreToolUse(name, parsed.data, {
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
        });
        if (!pre.ok) {
          parentSignal?.removeEventListener('abort', onParentAbort);
          return typedErr(`[hook:${pre.hookName ?? 'unknown'}] ${pre.reason ?? 'denied'}`);
        }
      } catch (hookErr) {
        if (this.lifecycleHooks.failureMode === 'fail-closed') {
          parentSignal?.removeEventListener('abort', onParentAbort);
          return typedErr('[hook:unknown] hook-failed');
        }
        // Belt-and-suspenders (fail-open): a throwing runner never blocks the tool.
        console.error(
          `[hooks] PreToolUse runner threw (fail-open): ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
        );
      }
    }

    try {
      const result = await Promise.race<TypedResult<O>>([
        tool.execute(parsed.data, ctx) as Promise<TypedResult<O>>,
        new Promise<TypedResult<O>>((_, reject) => {
          rejectRace = reject;
          if (parentSignal?.aborted) {
            onParentAbort();
            return;
          }
          timer = setTimeout(() => {
            if (!controller.signal.aborted) controller.abort();
            reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      // v1.5.3 / v1.21.0: truncate large results before they land in the LLM
      // transcript; spill full text to managed dir when truncated so the
      // model can re-open via path. Errors pass through untouched.
      // t57: mutate in place instead of early-returning — the Post hook and
      // the post-result listener below must observe EVERY executed result,
      // including truncated string successes.
      if (result.ok) {
        compactToolResult(result, { toolName: options.toolName ?? name });
      }
      // v0.10.0: PostToolUse lifecycle hooks — fail-open, never blocks.
      if (this.lifecycleHooks) {
        try {
          await this.lifecycleHooks.runPostToolUse(name, parsed.data, result, {
            sessionId: ctx.sessionId,
            cwd: ctx.cwd,
            ok: result.ok,
            error: result.ok ? undefined : ('error' in result ? result.error : undefined),
          });
        } catch {
          /* fail-open */
        }
      }
      // t57 (ADR 0022 seams): in-process post-result seam — same point as
      // the Post hook. Synchronous, fail-open: a throwing listener never
      // breaks the tool result.
      if (this.toolResultListener) {
        try {
          this.toolResultListener({ toolName: name, toolInput: parsed.data, ok: result.ok });
        } catch {
          /* fail-open */
        }
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return typedErr(error);
    } finally {
      rejectRace = undefined;
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  /** Return all tool definitions in OpenAI function-calling format (memoized). */
  toOpenAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    if (this.openAIToolsCache) return this.openAIToolsCache;
    this.openAIToolsCache = Array.from(this.tools.values()).map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.jsonSchema ?? zodToJsonSchema(t.inputSchema),
      },
    }));
    return this.openAIToolsCache;
  }

  /** 2.6.1 (plan §7): deep tool specs (name + description + JSON schema) for the harness manifest. */
  fingerprints(names?: readonly string[]): ToolFingerprint[] {
    const wanted = names ? new Set(names) : null;
    const out: ToolFingerprint[] = [];
    for (const t of this.tools.values()) {
      if (wanted && !wanted.has(t.name)) continue;
      out.push({
        name: t.name,
        description: t.description,
        inputSchema: t.jsonSchema ?? zodToJsonSchema(t.inputSchema),
      });
    }
    return out;
  }
}

/** Singleton instance (caller can override via setInstance). */
let _instance: ToolRegistry | null = null;
export function getToolRegistry(): ToolRegistry {
  if (!_instance) _instance = new ToolRegistry();
  return _instance;
}
