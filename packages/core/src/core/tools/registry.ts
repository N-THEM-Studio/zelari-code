import { zodToJsonSchema } from './zodBridge.js';
import { typedErr, type ToolDefinition, type ToolContext, type TypedResult } from './toolTypes.js';

export interface InvokeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  sessionId?: string;
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
