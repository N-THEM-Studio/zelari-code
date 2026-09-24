/**
 * toolResultRender — how a tool result reads in the MODEL's context.
 *
 * Token-efficiency audit 2026-09-25: tool outputs were ~63% of the prompt
 * tokens of an average lead request (they accumulate inside a turn's tool
 * loop and every call resends them). 82% of them were pretty-printed JSON:
 * two-space indentation on every structured result, and big text fields
 * (bash stdout, read content) escaped into one JSON string — every newline
 * `\n`, every quote `\"`, every ANSI color `\u001b[31;1m`. And bash/grep/
 * fetch objects had no size cap at all (up to 352K chars in one result).
 *
 * The events and the session spine keep the harness's JSON string: the
 * evidence/file-event parsers read it (`exitCodeFromToolResult`,
 * spineFileEvents). Only the copy pushed into the model's messages is
 * rendered here:
 *
 *   1. objects → compact JSON header of the small fields, then each long
 *      text field verbatim under a `--- field ---` line (no escaping);
 *      arrays and nested values → compact JSON;
 *   2. ANSI escape sequences are removed (terminal colors are noise);
 *   3. past `maxChars` (default 12,000; not for read_file, which has its
 *      own range/byte limits, nor for task reports) the FULL rendered text
 *      is written to the tool-output dir under a content-hash name and the
 *      model gets a head + tail window with the path — the brief's
 *      "write large outputs to a file" pattern. Same input ⇒ same bytes ⇒
 *      the cached prefix stays stable.
 *
 * `ZELARI_TOOL_RESULT_FORMAT=json` returns the content unchanged.
 * `ZELARI_TOOL_RESULT_MODEL_CHARS` sets the cap (0 disables it).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isToolSpillEnabled, resolveToolOutputDir } from './toolOutputSpill.js';

/** Text fields longer than this render verbatim instead of as JSON strings. */
const LONG_FIELD_CHARS = 200;
const DEFAULT_MAX_CHARS = 12_000;
/** Tools whose output is already bounded by the caller's own request. */
const CAP_EXEMPT = new Set(['read_file', 'task']);

// CSI sequences (colors, cursor moves) and OSC sequences (titles, links).
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export interface ToolResultRenderOptions {
  toolName?: string;
  /** Overrides ZELARI_TOOL_RESULT_MODEL_CHARS (0 = no cap). */
  maxChars?: number;
  env?: Record<string, string | undefined>;
  /** Overrides the spill directory (tests). */
  spillDir?: string;
}

export function stripAnsi(text: string): string {
  return text.includes('\u001b') ? text.replace(ANSI, '') : text;
}

function resolveMaxChars(opts: ToolResultRenderOptions, env: Record<string, string | undefined>): number {
  if (typeof opts.maxChars === 'number') return opts.maxChars;
  const raw = env.ZELARI_TOOL_RESULT_MODEL_CHARS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CHARS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_CHARS;
}

/** Compact header + verbatim long text fields; null when not a JSON object/array. */
function renderStructured(content: string): string | null {
  const first = content.trimStart()[0];
  if (first !== '{' && first !== '[') return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  const small: Record<string, unknown> = {};
  const long: Array<[string, string]> = [];
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (typeof field === 'string' && field.length > LONG_FIELD_CHARS) long.push([key, stripAnsi(field)]);
    else small[key] = field;
  }
  if (long.length === 0) return JSON.stringify(value);
  const parts = [JSON.stringify(small)];
  for (const [key, text] of long) parts.push(`--- ${key} ---\n${text}`);
  return parts.join('\n');
}

function spillDeterministic(text: string, toolName: string, dir: string): string | null {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const safeTool = toolName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 32) || 'tool';
    const path = join(dir, `${safeTool}-${hash}.txt`);
    if (!existsSync(path)) writeFileSync(path, text, 'utf8');
    return path;
  } catch {
    return null;
  }
}

function capWindow(text: string, maxChars: number, toolName: string, spillDir: string | null): string {
  const half = Math.floor(maxChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  const omitted = text.length - head.length - tail.length;
  const path = spillDir ? spillDeterministic(text, toolName, spillDir) : null;
  const marker = path
    ? `...${omitted} chars omitted; complete output in ${path}`
    : `...${omitted} chars omitted (full output not on disk)`;
  return `${head}\n${marker}\n${tail}`;
}

export function renderToolResultForModel(content: string, opts: ToolResultRenderOptions = {}): string {
  const env = opts.env ?? process.env;
  if ((env.ZELARI_TOOL_RESULT_FORMAT ?? '').trim().toLowerCase() === 'json') return content;
  if (!content) return content;
  const rendered = renderStructured(content) ?? stripAnsi(content);
  const maxChars = resolveMaxChars(opts, env);
  const toolName = opts.toolName ?? 'tool';
  if (maxChars <= 0 || rendered.length <= maxChars || CAP_EXEMPT.has(toolName)) return rendered;
  const spillDir = opts.spillDir ?? (isToolSpillEnabled() ? resolveToolOutputDir() : null);
  return capWindow(rendered, maxChars, toolName, spillDir);
}
