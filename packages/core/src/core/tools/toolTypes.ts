import type { ZodSchema } from 'zod';


/** Discriminated union for tool execution results. */
export type TypedResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Tool permission categories. The CLI prompts the user before invoking
 *  tools with write/execute/network permissions. */
export type ToolPermission = 'read' | 'write' | 'execute' | 'network';

export interface ToolDefinition<I = unknown, O = unknown> {
  /** Stable tool name (used by LLM function-calling). */
  name: string;
  /** Human-readable description (shown to LLM in prompt). */
  description: string;
  /** Permissions required to invoke. Empty array = no permissions. */
  permissions: ToolPermission[];
  /** Timeout in ms (default 30000 if not specified). */
  timeoutMs?: number;
  /** Zod schema for input validation. */
  inputSchema: ZodSchema<I>;
  /** Async executor. Receives validated input + context, returns TypedResult. */
  execute: (input: I, ctx: ToolContext) => Promise<TypedResult<O>>;
  /**
   * Optional raw JSON Schema for the tool parameters. When present it is
   * forwarded to the provider VERBATIM instead of converting inputSchema
   * (used by MCP tools, whose servers publish JSON Schema directly and
   * validate their own inputs — the local zod gate stays permissive).
   */
  jsonSchema?: Record<string, unknown>;
  /** Optional related tools (for discovery in UI). */
  relatedTools?: string[];
}

export interface ToolContext {
  /** Per-tool-call timeout + cancellation signal. */
  signal: AbortSignal;
  /** Working directory (defaults to process.cwd()). */
  cwd: string;
  /** Audit logger. Tools should call audit() for every invocation. */
  audit: (entry: AuditEntry) => void;
  /** Session id (for audit grouping). */
  sessionId: string;
}

export interface AuditEntry {
  tool: string;
  args: unknown;
  result: { ok: boolean; durationMs: number; sizeBytes?: number };
  ts: number;
  sessionId: string;
}

/** Helper: wrap a thrown error into TypedResult. */
export function typedOk<T>(value: T): TypedResult<T> {
  return { ok: true, value };
}

export function typedErr<T = never>(error: string): TypedResult<T> {
  return { ok: false, error };
}
