import { zodToJsonSchema } from './zodBridge.js';
import { spillToolOutput } from './toolOutputSpill.js';
import { typedErr, type ToolDefinition, type ToolContext, type TypedResult } from './toolTypes.js';

export { spillToolOutput, resolveToolOutputDir, isToolSpillEnabled } from './toolOutputSpill.js';

export interface InvokeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  sessionId?: string;
  /** Optional tool name for spill file naming (defaults to invoked name). */
  toolName?: string;
}

export interface TruncateToolResultOptions {
  /** Line cap (default ZELARI_TOOL_RESULT_LINES / 200). */
  cap?: number;
  /** When true (default), spill full text to managed dir if truncated. */
  spill?: boolean;
  /** Used in spill filename + marker. */
  toolName?: string;
}

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

/**
 * v1.5.3: tool-result truncation. A read_file / show_diff / bash on a large
 * target used to dump the entire output into config.messages verbatim — a
 * 5000-line file is ~100k tokens, re-sent every subsequent provider turn, and
 * a single such call can consume 50–100% of a context window. This truncates
 * tool results to a bounded head + tail with a marker, so the transcript LLM
 * sees stays under control regardless of what a tool returns.
 *
 * Strategy: if the result has more than `cap` lines, keep the first half and
 * the last half of `cap`, with a marker naming the omission. Single-line
 * payloads (e.g. compact JSON) are split on a char budget derived from cap.
 * Results under the cap pass through verbatim — zero overhead on the common
 * case. Errors (ok:false) are never truncated (they're small by nature).
 *
 * Env override: ZELARI_TOOL_RESULT_LINES (default 200). Set higher for
 * sessions that need more file context, lower to save tokens on tight windows.
 */
const TOOL_RESULT_LINE_CAP: number = (() => {
  const raw = process.env.ZELARI_TOOL_RESULT_LINES;
  const n = raw ? Number.parseInt(raw, 10) : 200;
  return Number.isFinite(n) && n >= 10 ? n : 200;
})();

/**
 * Truncate a string result to head + tail with a marker, bounded by line count
 * (and a soft char budget for huge single-line payloads).
 *
 * When the result is truncated and spill is enabled, the **full** text is
 * written under the managed tool-output dir and the marker includes the path
 * so the model can re-open it with read_file if needed.
 *
 * Exported for tests. Returns the original string if under the cap.
 *
 * Overloads:
 *   truncateToolResult(text, cap?)
 *   truncateToolResult(text, { cap, spill, toolName })
 */
export function truncateToolResult(
  text: string,
  capOrOpts: number | TruncateToolResultOptions = TOOL_RESULT_LINE_CAP,
): string {
  if (text.length === 0) return text;

  const opts: TruncateToolResultOptions =
    typeof capOrOpts === 'number' ? { cap: capOrOpts } : (capOrOpts ?? {});
  const cap =
    typeof opts.cap === 'number' && Number.isFinite(opts.cap) && opts.cap >= 10
      ? opts.cap
      : TOOL_RESULT_LINE_CAP;
  const doSpill = opts.spill !== false;

  const lines = text.split('\n');
  // Soft char budget: ~80 chars/line × cap. Catches single-line megabytes
  // that would otherwise pass the line check.
  const charBudget = cap * 80;
  const overLines = lines.length > cap;
  const overChars = text.length > charBudget && lines.length <= cap;

  if (!overLines && !overChars) return text;

  let preview: string;
  let marker: string;

  if (overLines) {
    const half = Math.floor(cap / 2);
    const head = lines.slice(0, half);
    const tail = lines.slice(lines.length - half);
    const omitted = lines.length - cap;
    marker = `+${omitted} lines omitted — showing head:${half}, tail:${half} of ${lines.length} total`;
    preview =
      head.join('\n') +
      `\n… [${marker}] …\n` +
      tail.join('\n');
  } else {
    // Single (or few) huge lines — keep head + tail chars.
    const half = Math.floor(charBudget / 2);
    const head = text.slice(0, half);
    const tail = text.slice(text.length - half);
    const omitted = text.length - charBudget;
    marker = `+${omitted} chars omitted — showing head/tail of ${text.length} total (line-sparse payload)`;
    preview = `${head}\n… [${marker}] …\n${tail}`;
  }

  if (doSpill) {
    const path = spillToolOutput(text, { toolName: opts.toolName });
    if (path) {
      const spillNote =
        `\n… [full output spilled to: ${path} — re-read with read_file if you need the complete text] …`;
      // Insert spill note after the omission marker line for visibility.
      if (preview.includes('] …\n')) {
        preview = preview.replace('] …\n', `] …${spillNote}\n`);
      } else {
        preview = preview + spillNote;
      }
    }
  }

  return preview;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register<I, O>(def: ToolDefinition<I, O>): void {
    this.tools.set(def.name, def as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
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

    // Zod validation
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return typedErr(`Invalid input: ${parsed.error.message}`);
    }

    // Timeout + cancellation
    const timeoutMs = options.timeoutMs ?? tool.timeoutMs ?? 30000;
    const signal = options.signal;

    const ctx: ToolContext = {
      signal: signal ?? new AbortController().signal,
      cwd: options.cwd ?? process.cwd(),
      audit: () => { /* audit log injected externally */ },
      sessionId: options.sessionId ?? 'default',
    };

    try {
      const result = await Promise.race<TypedResult<O>>([
        tool.execute(parsed.data, ctx) as Promise<TypedResult<O>>,
        new Promise<TypedResult<O>>((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`)), timeoutMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error(`Tool "${name}" aborted`));
          });
        }),
      ]);
      // v1.5.3 / v1.21.0: truncate large results before they land in the LLM
      // transcript; spill full text to managed dir when truncated so the
      // model can re-open via path. Errors pass through untouched.
      if (result.ok) {
        const tName = options.toolName ?? name;
        if (typeof result.value === 'string') {
          return {
            ok: true,
            value: truncateToolResult(result.value, {
              toolName: tName,
            }) as unknown as O,
          };
        }
        if (result.value && typeof result.value === 'object') {
          const v = result.value as Record<string, unknown>;
          if (typeof v.content === 'string') {
            v.content = truncateToolResult(v.content, { toolName: tName });
          }
        }
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return typedErr(error);
    }
  }

  /** Return all tool definitions in OpenAI function-calling format. */
  toOpenAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return Array.from(this.tools.values()).map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.jsonSchema ?? zodToJsonSchema(t.inputSchema),
      },
    }));
  }
}

/** Singleton instance (caller can override via setInstance). */
let _instance: ToolRegistry | null = null;
export function getToolRegistry(): ToolRegistry {
  if (!_instance) _instance = new ToolRegistry();
  return _instance;
}
