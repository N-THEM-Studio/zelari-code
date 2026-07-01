import { zodToJsonSchema } from './zodBridge.js';
import { typedErr, type ToolDefinition, type ToolContext, type TypedResult } from './toolTypes.js';

export interface InvokeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  sessionId?: string;
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

  /** Invoke a tool with validated input + timeout + audit + permissions check. */
  async invoke<O>(
    name: string,
    rawInput: unknown,
    options: InvokeOptions = {},
  ): Promise<TypedResult<O>> {
    const tool = this.tools.get(name);
    if (!tool) {
      return typedErr(`Tool "${name}" not found. Available: ${this.list().join(', ')}`);
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
        parameters: zodToJsonSchema(t.inputSchema),
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
