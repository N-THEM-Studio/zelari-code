import type { ZodSchema } from 'zod';
import type { WriteReject } from './builtin/edit.js';


/**
 * Ground Truth diagnostic envelope for observe tools (2026-07 plan, Fase 0).
 *
 * Every read-only observation tool (grep_content, list_files, read_file) fills
 * this deterministically so that callers — and the model itself — can tell
 * apart "complete with 0 matches" from "empty scope" from "truncated" from
 * "failed", without re-reading the payload.
 *
 * Warning codes are stable, greppable identifiers (never free prose):
 *  - SEARCH_EMPTY_SCOPE  include/exclude globs matched 0 files in a non-empty tree
 *  - TREE_EMPTY          the target directory exists but walked 0 entries
 *  - FILE_NOT_FOUND      the target file does not exist (no silent fallback)
 *  - EMPTY_FILE          the file exists but has 0 bytes
 *  - LINE_RANGE_EMPTY    startLine/endLine selected 0 lines of a non-empty file
 *  - MAX_BYTES_TRUNCATED payload cut by the maxBytes cap (explicit, never silent)
 */
export interface ToolResultMeta {
  status: 'complete' | 'partial' | 'empty' | 'failed';
  counts?: { filesWalked?: number; matches?: number; bytes?: number; lines?: number };
  warnings?: string[];
  truncated?: boolean;
  /** ADR-0033: sha256[:16] anchor of the full (pre-truncation) content (read tools). */
  snapshotId?: string;
  /** ADR-0033: structured WriteReject payload for write-path failures (edit, apply_diff). */
  reject?: WriteReject;
}

/** Discriminated union for tool execution results. */
export type TypedResult<T> =
  | { ok: true; value: T; meta?: ToolResultMeta }
  | { ok: false; error: string; meta?: ToolResultMeta };

/** Tool permission categories. The CLI prompts the user before invoking
 *  tools with write/execute/network permissions. */
export type ToolPermission = 'read' | 'write' | 'execute' | 'network' | 'ui';

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
  /**
   * Crash-recovery class (2.x B). `none` = retry-safe if the result is
   * missing; `local`/`external` = inspect-first, never retry blindly.
   */
  sideEffect?: 'none' | 'local' | 'external';
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
export function typedOk<T>(value: T, meta?: ToolResultMeta): TypedResult<T> {
  return meta ? { ok: true, value, meta } : { ok: true, value };
}

export function typedErr<T = never>(error: string, meta?: ToolResultMeta): TypedResult<T> {
  return meta ? { ok: false, error, meta } : { ok: false, error };
}

/**
 * Compact one-line diagnostic footer appended to the model-facing tool result
 * string when the observation is NOT clean-complete. Returns '' for a clean
 * complete observation (no noise) and for absent meta (pre-Fase-0 tools).
 *
 * Deterministic by construction: same meta → same footer, byte-identical —
 * safe for prefix caching (Fase 2 relies on this).
 */
export function metaFooter(meta?: ToolResultMeta): string {
  if (!meta) return '';
  if (meta.status === 'complete' && !meta.truncated && !meta.warnings?.length) return '';
  const parts: string[] = [`status=${meta.status}`];
  const c = meta.counts;
  if (c?.filesWalked !== undefined) parts.push(`filesWalked=${c.filesWalked}`);
  if (c?.matches !== undefined) parts.push(`matches=${c.matches}`);
  if (c?.lines !== undefined) parts.push(`lines=${c.lines}`);
  if (c?.bytes !== undefined) parts.push(`bytes=${c.bytes}`);
  if (meta.truncated) parts.push('truncated=true');
  if (meta.warnings?.length) parts.push(`warnings=${meta.warnings.join(',')}`);
  return `\n[observation ${parts.join(' ')}]`;
}
