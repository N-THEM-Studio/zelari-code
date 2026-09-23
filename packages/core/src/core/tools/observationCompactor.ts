/**
 * observationCompactor — tool-result truncation extracted from ToolRegistry.
 *
 * S2 (plan): the head+tail truncation + managed-dir spill used to live inline
 * in ToolRegistry.invoke (and, in a cloned form, in the CLI tool-result cache).
 * This module is the single implementation of that mechanism. registry.ts
 * re-exports it for backward compatibility; the CLI cache calls it directly.
 *
 * @since v2.47.0
 */
import { spillToolOutput } from './toolOutputSpill.js';
import type { TypedResult } from './toolTypes.js';

export interface TruncateToolResultOptions {
  /** Line cap (default ZELARI_TOOL_RESULT_LINES / 200). */
  cap?: number;
  /** When true (default), spill full text to managed dir if truncated. */
  spill?: boolean;
  /** Used in spill filename + marker. */
  toolName?: string;
}

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
export const TOOL_RESULT_LINE_CAP: number = (() => {
  const raw = process.env.ZELARI_TOOL_RESULT_LINES;
  const n = raw ? Number.parseInt(raw, 10) : 200;
  return Number.isFinite(n) && n >= 10 ? n : 200;
})();

/**
 * Truncate a string result to a ~50/50 head + tail window with ONE marker
 * (`...N bytes truncated; complete output in <path>`), bounded by line count
 * (and a soft char budget for huge single-line payloads). N is the exact
 * omitted UTF-8 byte count and the spill path sits LAST on its marker line so
 * Windows paths with spaces stay extractable up to end-of-line.
 *
 * When the result is truncated and spill is enabled, the **full** text is
 * written under the managed tool-output dir and the marker names that path
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

  let head: string;
  let tail: string;
  if (overLines) {
    const half = Math.floor(cap / 2);
    head = lines.slice(0, half).join('\n');
    tail = lines.slice(lines.length - half).join('\n');
  } else {
    // Single (or few) huge lines — keep head + tail chars.
    const half = Math.floor(charBudget / 2);
    head = text.slice(0, half);
    tail = text.slice(text.length - half);
  }

  const truncatedBytes = Math.max(
    0,
    Buffer.byteLength(text, 'utf8') -
      Buffer.byteLength(head, 'utf8') -
      Buffer.byteLength(tail, 'utf8'),
  );
  const spillPath = doSpill ? spillToolOutput(text, { toolName: opts.toolName }) : null;
  const marker = spillPath
    ? `...${truncatedBytes} bytes truncated; complete output in ${spillPath}`
    : `...${truncatedBytes} bytes truncated (spill disabled or failed — full output not on disk)`;
  return `${head}\n${marker}\n${tail}`;
}

/**
 * Compact a TypedResult's model-facing payload IN PLACE and return the SAME
 * reference. String values are truncated; object values with a string
 * `content` field have that field truncated on the same object (no clone).
 * Errors (ok:false) and other shapes pass through untouched.
 *
 * spill defaults to true (matches truncateToolResult); the CLI tool-result
 * cache passes spill:false so a cache fill never writes to disk.
 */
export function compactToolResult<O>(
  result: TypedResult<O>,
  opts: { toolName?: string; cap?: number; spill?: boolean } = {},
): TypedResult<O> {
  if (!result.ok) return result;

  const truncOpts: TruncateToolResultOptions = { toolName: opts.toolName };
  if (opts.cap !== undefined) truncOpts.cap = opts.cap;
  if (opts.spill !== undefined) truncOpts.spill = opts.spill;

  if (typeof result.value === 'string') {
    result.value = truncateToolResult(result.value, truncOpts) as unknown as O;
  } else if (result.value && typeof result.value === 'object') {
    const v = result.value as Record<string, unknown>;
    if (typeof v.content === 'string') {
      v.content = truncateToolResult(v.content, truncOpts);
    }
  }
  return result;
}
