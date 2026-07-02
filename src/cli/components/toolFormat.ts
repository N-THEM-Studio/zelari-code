/**
 * toolFormat.ts — v0.7.1 pure formatters for tool rendering (plan B1+B2+B3).
 *
 * The v0.6/v0.7.0 renderer dumped the raw JSON result envelope into a bordered
 * box: escaped `\n`, full-terminal-width borders with inconsistent widths per
 * box, and summary lines that were raw JSON args truncated mid-string. These
 * pure functions replace that with human-readable output keyed by tool name.
 *
 * Two formatters:
 *   - {@link formatToolSummary}: the one-line summary (replaces raw-JSON args).
 *   - {@link formatToolResult}: the multi-line body (replaces the raw envelope).
 *
 * Both are pure (no React, no Ink) so they are trivially unit-testable and
 * usable by any renderer (the current ToolOutput, the Static path, /last-tool).
 *
 * Truncation is line-based (default 8, `ZELARI_TOOL_OUTPUT_LINES`) with a
 * `… (+K lines)` tail, replacing the 600-char mid-string cut that split JSON
 * strings awkwardly.
 */
import path from 'node:path';

/** Default line cap for the printed result body. */
const DEFAULT_TOOL_OUTPUT_LINES = 8;

function toolOutputLineCap(): number {
  const raw = process.env.ZELARI_TOOL_OUTPUT_LINES;
  const n = raw ? Number.parseInt(raw, 10) : DEFAULT_TOOL_OUTPUT_LINES;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOOL_OUTPUT_LINES;
}

/** Result of formatting a tool body. */
export interface FormattedToolResult {
  /** Body lines to print (already truncated to the line cap). */
  lines: string[];
  /** Optional one-line meta appended after the body (e.g. `exit 1`, `stderr`). */
  meta?: string;
  /**
   * When true, the result is a single logical line and the renderer should
   * NOT wrap it in a bordered box — print it inline on the summary line
   * (e.g. `✓ [write_file] wrote 10.3 KB → path`). Plan B3.
   */
  oneLine?: boolean;
}

/**
 * Best-effort JSON parse. Returns the parsed value or `null` (caller falls
 * back to treating the input as a plain string).
 */
function tryParseJson<T = unknown>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Truncate an array of lines to the cap, appending a `… (+K lines)` marker. */
function truncateLines(lines: string[]): string[] {
  const cap = toolOutputLineCap();
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), `… (+${lines.length - cap} lines)`];
}

/** Human-readable byte size (KB / MB). */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Format the body of a tool result for display.
 *
 * @param toolName  tool name (determines the per-tool shape handling)
 * @param resultStr the raw result string (JSON envelope from the harness, or
 *                  a plain string for non-JSON tools / errors)
 */
export function formatToolResult(toolName: string, resultStr: string): FormattedToolResult {
  const lower = toolName.toLowerCase();

  // bash / shell — envelope: { stdout, stderr, exitCode }
  if (lower === 'bash' || lower === 'shell' || lower === 'exec') {
    const parsed = tryParseJson<{ stdout?: string; stderr?: string; exitCode?: number }>(resultStr);
    if (parsed && typeof parsed === 'object') {
      const stdout = parsed.stdout ?? '';
      const lines = stdout.length > 0 ? stdout.replace(/\r\n/g, '\n').split('\n') : [];
      const metaParts: string[] = [];
      if (parsed.stderr && parsed.stderr.trim().length > 0) {
        metaParts.push(`stderr: ${parsed.stderr.trim().split('\n')[0]}`);
      }
      if (typeof parsed.exitCode === 'number' && parsed.exitCode !== 0) {
        metaParts.push(`exit ${parsed.exitCode}`);
      }
      return {
        lines: truncateLines(lines),
        meta: metaParts.length > 0 ? metaParts.join(' · ') : undefined,
      };
    }
  }

  // read_file — envelope: { path, content, ... }
  if (lower.includes('read') || lower === 'cat') {
    const parsed = tryParseJson<{ content?: string; path?: string }>(resultStr);
    if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
      return { lines: truncateLines(parsed.content.replace(/\r\n/g, '\n').split('\n')) };
    }
  }

  // write_file / edit_file — success is a single line, no box (B3).
  if (lower.includes('write') || lower.includes('edit')) {
    const parsed = tryParseJson<{ path?: string; bytesWritten?: number; occurrencesReplaced?: number }>(resultStr);
    if (parsed && typeof parsed === 'object') {
      const p = parsed.path ? rel(parsed.path) : '';
      if (typeof parsed.bytesWritten === 'number') {
        return { lines: [`wrote ${formatBytes(parsed.bytesWritten)} → ${p}`], oneLine: true };
      }
      if (typeof parsed.occurrencesReplaced === 'number') {
        return {
          lines: [`replaced ${parsed.occurrencesReplaced} occurrence(s) in ${p}`],
          oneLine: true,
        };
      }
    }
  }

  // list_files — envelope: { dir, entries: [{name, type}], truncated }
  if (lower.includes('list') || lower.includes('ls')) {
    const parsed = tryParseJson<{ dir?: string; entries?: { name: string; type?: string }[]; truncated?: boolean }>(resultStr);
    if (parsed && Array.isArray(parsed.entries)) {
      const names = parsed.entries.slice(0, 10).map((e) => e.name);
      const head = truncateLines(names);
      const count = parsed.entries.length;
      const dir = parsed.dir ? rel(parsed.dir) : '';
      const metaParts: string[] = [];
      if (dir) metaParts.push(`${count} entries in ${dir}`);
      else metaParts.push(`${count} entries`);
      if (parsed.truncated) metaParts.push(`(truncated)`);
      return { lines: head, meta: metaParts.join(' ') };
    }
  }

  // grep_content / search — envelope: { matches/results: [...] }
  if (lower.includes('grep') || lower.includes('search')) {
    const parsed = tryParseJson<{ matches?: unknown[]; results?: unknown[] }>(resultStr);
    const arr = parsed?.matches ?? parsed?.results;
    if (Array.isArray(arr)) {
      return {
        lines: truncateLines(arr.map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))),
        meta: `${arr.length} match(es)`,
      };
    }
  }

  // Fallback: treat as plain text (split on real newlines; if it's JSON we
  // already failed to match a known shape, so show it verbatim).
  return { lines: truncateLines(resultStr.replace(/\r\n/g, '\n').split('\n')) };
}

/** Make a path relative to cwd when possible (shorter display). */
function rel(p: string): string {
  try {
    const r = path.relative(process.cwd(), p);
    return r && !r.startsWith('..') ? r : p;
  } catch {
    return p;
  }
}

/**
 * Format the one-line summary for a tool invocation (replaces raw-JSON args).
 *
 * @param toolName tool name
 * @param args     the args object/value as received from the model
 * @param maxWidth optional column cap; the summary is truncated (with `…`) to
 *                 fit so it never wraps mid-token. When omitted, a sane default
 *                 is applied.
 */
export function formatToolSummary(toolName: string, args: unknown, maxWidth?: number): string {
  const cap = maxWidth && maxWidth > 10 ? maxWidth : 100;
  const lower = toolName.toLowerCase();
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;

  let summary: string;
  if (lower === 'bash' || lower === 'shell' || lower === 'exec') {
    summary = String(a['command'] ?? a['cmd'] ?? '');
  } else if (lower.includes('read') || lower === 'cat') {
    summary = typeof a['path'] === 'string' ? rel(a['path']) : '';
  } else if (lower.includes('write') || lower.includes('edit')) {
    const p = typeof a['path'] === 'string' ? rel(a['path']) : '';
    summary = p;
  } else if (lower.includes('list') || lower.includes('ls')) {
    const dir = typeof a['dir'] === 'string' ? rel(a['dir']) : '.';
    const depth = typeof a['maxDepth'] === 'number' ? ` (depth ${a['maxDepth']})` : '';
    summary = `${dir}${depth}`;
  } else if (lower.includes('grep') || lower.includes('search')) {
    const pattern = String(a['pattern'] ?? a['query'] ?? '');
    const p = typeof a['path'] === 'string' ? ` in ${rel(a['path'])}` : '';
    summary = `${pattern}${p}`;
  } else {
    // Fallback: compact JSON, but truncated at the column cap (not mid-string
    // like the old slice(0,120) which cut content values arbitrarily).
    const json = JSON.stringify(args) ?? '';
    summary = json;
  }

  return summary.length > cap ? `${summary.slice(0, cap - 1)}…` : summary;
}
