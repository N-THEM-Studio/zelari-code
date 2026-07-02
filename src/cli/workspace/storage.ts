/**
 * workspace/storage.ts — Frontmatter parse/serialize + safe read/write.
 *
 * Zero new deps. Implements a minimal YAML reader that handles the
 * subset we use: flat key-value pairs, single-line values, simple
 * arrays using `[a, b, c]` or `- a\n- b` notation, nested objects
 * using 2-space indentation, strings (quoted/unquoted), numbers,
 * booleans, null.
 *
 * For our frontmatter (plan items, ADRs, risks, reviews, docs) this
 * is more than enough. Anything more complex would warrant pulling in
 * `gray-matter` + `js-yaml`.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// ── Frontmatter parsing ────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Result of parsing a Markdown file with frontmatter. */
export interface ParsedDoc<TMeta = Record<string, unknown>> {
  meta: TMeta;
  body: string;
}

/** Parse a Markdown string into meta + body. */
export function parseFrontmatter<TMeta = Record<string, unknown>>(
  md: string,
): ParsedDoc<TMeta> {
  const m = FRONTMATTER_RE.exec(md);
  if (!m) return { meta: {} as TMeta, body: md };
  const meta = parseYaml(m[1]) as TMeta;
  const body = m[2];
  return { meta, body };
}

/** Serialize meta + body back to a Markdown string. */
export function serializeFrontmatter<TMeta>(
  meta: TMeta,
  body: string,
): string {
  const yamlStr = serializeYaml(meta);
  // Always end with exactly one \n before body for consistency
  return `---\n${yamlStr}\n---\n${body}`;
}

// ── Minimal YAML parser/serializer ─────────────────────────────────────
// Subset: scalar values, flow/sequence/block-sequence arrays, flow/block maps.

const VALID_SCALARS = /^(true|false|null|~)$/i;

/** Parse a YAML subset string into a JS value. */
export function parseYaml(input: string): unknown {
  const lines = input.split(/\r?\n/);
  const ctx: ParseCtx = { lines, i: 0 };
  return parseNode(ctx, 0);
}

interface ParseCtx {
  lines: string[];
  i: number;
}

function parseNode(ctx: ParseCtx, indent: number): unknown {
  // Skip blank lines and comments
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i];
    if (line.trim() === '' || line.trim().startsWith('#')) { ctx.i++; continue; }
    break;
  }
  if (ctx.i >= ctx.lines.length) return null;

  const line = ctx.lines[ctx.i];
  const lineIndent = countIndent(line);

  // Block sequence at this indent
  if (/^\s*-\s+/.test(line)) {
    return parseBlockSequence(ctx, indent);
  }

  // Flow sequence on a single line: [...]
  if (/^\s*\[.*\]\s*$/.test(line)) {
    const flow = line.trim().replace(/^\[/, '').replace(/\]$/, '');
    return parseFlowSequence(flow);
  }

  // Flow map on a single line: {key: val, ...}
  if (/^\s*\{.*\}\s*$/.test(line)) {
    const flow = line.trim().replace(/^\{/, '').replace(/\}$/, '');
    return parseFlowMap(flow);
  }

  // Block map (key: value, possibly with nested children)
  return parseBlockMap(ctx, indent);
}

function parseBlockMap(ctx: ParseCtx, indent: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i];
    if (line.trim() === '' || line.trim().startsWith('#')) { ctx.i++; continue; }
    const lineIndent = countIndent(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      // Not expected in well-formed YAML — skip
      ctx.i++;
      continue;
    }
    // Key: value
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (!m) { ctx.i++; continue; }
    const key = m[1].trim();
    const valuePart = m[2].trim();

    if (valuePart === '' || valuePart === '|' || valuePart === '>') {
      // Multiline value or nested structure
      ctx.i++;
      const nested = parseNode(ctx, indent + 2);
      out[key] = nested;
    } else {
      // Flow-style array on the value side: tags: [a, b, c]
      if (valuePart.startsWith('[')) {
        out[key] = parseFlowSequence(stripFlow(valuePart, '[', ']'));
      } else if (valuePart.startsWith('{')) {
        // Flow-style map on the value side: meta: {order: 1, color: x}
        out[key] = parseFlowMap(stripFlow(valuePart, '{', '}'));
      } else {
        out[key] = parseScalar(valuePart);
      }
      ctx.i++;
    }
  }
  return out;
}

function parseBlockSequence(ctx: ParseCtx, indent: number): unknown[] {
  const out: unknown[] = [];
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i];
    if (line.trim() === '') { ctx.i++; continue; }
    const lineIndent = countIndent(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) break; // shouldn't happen
    const m = /^-\s*(.*)$/.exec(line);
    if (!m) break;
    const rest = m[1];
    if (rest === '') {
      // Indented child of this sequence item
      ctx.i++;
      out.push(parseNode(ctx, indent + 2));
    } else if (rest.startsWith('[') || rest.startsWith('{')) {
      // Inline flow collection starting the item
      // Parse the whole line as flow
      let buffer = rest;
      // If line doesn't end with closing bracket, slurp next lines until balanced
      let depthSq = (buffer.match(/\[/g) || []).length - (buffer.match(/\]/g) || []).length;
      let depthCu = (buffer.match(/\{/g) || []).length - (buffer.match(/\}/g) || []).length;
      while ((depthSq > 0 || depthCu > 0) && ctx.i + 1 < ctx.lines.length) {
        ctx.i++;
        const next = ctx.lines[ctx.i].trim();
        buffer += ' ' + next;
        depthSq = (buffer.match(/\[/g) || []).length - (buffer.match(/\]/g) || []).length;
        depthCu = (buffer.match(/\{/g) || []).length - (buffer.match(/\}/g) || []).length;
      }
      if (buffer.startsWith('[')) {
        out.push(parseFlowSequence(buffer.slice(1).replace(/\]$/, '')));
      } else {
        out.push(parseFlowMap(buffer.slice(1).replace(/\}$/, '')));
      }
      ctx.i++;
    } else if (rest.includes(':')) {
      // Map item starting on the dash line: "- key: val"
      // Reconstruct a synthetic line at the right indent to feed parseBlockMap
      ctx.i++;
      const mapCtx: ParseCtx = { lines: [' '.repeat(indent + 2) + rest, ...ctx.lines.slice(ctx.i)], i: 0 };
      const val = parseBlockMap(mapCtx, indent + 2);
      // Skip the synthetic line + however many mapCtx consumed from original
      ctx.i += mapCtx.i - 1;
      out.push(val);
    } else {
      out.push(parseScalar(rest));
      ctx.i++;
    }
  }
  return out;
}

function parseFlowSequence(input: string): unknown[] {
  // Split on top-level commas (not inside nested brackets)
  const parts = splitFlow(input);
  return parts.map((p) => {
    const trimmed = p.trim();
    if (trimmed.startsWith('{')) {
      // Inline object inside a flow sequence: [{a: 1, b: 2}]
      return parseFlowMap(stripFlow(trimmed, '{', '}'));
    }
    return parseScalar(trimmed);
  });
}

/** Strip surrounding flow brackets and any trailing whitespace. */
function stripFlow(s: string, open: string, close: string): string {
  let out = s.trim();
  if (out.startsWith(open)) out = out.slice(1);
  if (out.endsWith(close)) out = out.slice(0, -1);
  return out;
}

function parseFlowMap(input: string): Record<string, unknown> {
  const parts = splitFlow(input);
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    const colonIdx = p.indexOf(':');
    if (colonIdx < 0) continue;
    const key = p.slice(0, colonIdx).trim();
    const value = p.slice(colonIdx + 1).trim();
    out[key] = parseScalar(value);
  }
  return out;
}

function splitFlow(input: string): string[] {
  const out: string[] = [];
  let depthSq = 0, depthCu = 0, depthQu = 0;
  let buffer = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"' || c === "'") {
      depthQu = depthQu === 0 ? (depthQu + 1) : 0;
      buffer += c;
    } else if (depthQu === 0) {
      if (c === '[') depthSq++;
      else if (c === ']') depthSq--;
      else if (c === '{') depthCu++;
      else if (c === '}') depthCu--;
      else if (c === ',' && depthSq === 0 && depthCu === 0) {
        out.push(buffer);
        buffer = '';
        continue;
      }
      buffer += c;
    } else {
      buffer += c;
    }
  }
  if (buffer.trim()) out.push(buffer);
  return out;
}

function parseScalar(s: string): unknown {
  if (s === '' || s === 'null' || s === '~') return null;
  if (VALID_SCALARS.test(s)) return s.toLowerCase() === 'true';
  // Number
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Otherwise plain string
  return s;
}

// ── Serializer ────────────────────────────────────────────────────────

/** Serialize a JS value back to our YAML subset. */
export function serializeYaml(value: unknown, indent = 0): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    // Quote if contains special chars
    if (/[:#\n\[\]\{\},&*!|>'"%@`]/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    // Flow-style for arrays of scalars AND arrays of objects (simpler parser).
    if (value.length === 0) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) {
      return `[${value.map(serializeScalarInline).join(', ')}]`;
    }
    // Array of objects → flow-style with JSON-like objects inside.
    return `[${value.map((v) => '{' + serializeInlineObject(v) + '}').join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return entries
      .map(([k, v]) => {
        if (v === null || v === undefined) return `${k}:`;
        // Scalars and arrays (of any kind) — write inline.
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          return `${k}: ${serializeScalarInline(v)}`;
        }
        if (Array.isArray(v)) {
          // Arrays always inline (flow-style). Empty → [].
          if (v.length === 0) return `${k}: []`;
          if (v.every((x) => x === null || typeof x !== 'object')) {
            return `${k}: [${v.map(serializeScalarInline).join(', ')}]`;
          }
          return `${k}: [${v.map((x) => '{' + serializeInlineObject(x) + '}').join(', ')}]`;
        }
        // Nested object → block-style on subsequent indented lines.
        return `${k}:\n${serializeYaml(v, indent + 2)}`;
      })
      .map((line) => `${' '.repeat(indent)}${line}`)
      .join('\n');
  }
  return String(value);
}

function serializeScalarInline(v: unknown): string {
  if (typeof v === 'string' && /[:#\n\[\]\{\},&*!|>'"%@`]/.test(v)) return JSON.stringify(v);
  return String(v);
}

/** Serialize an object inline as `key: val, key2: val2` (no surrounding braces). */
function serializeInlineObject(v: unknown): string {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return serializeScalarInline(v);
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== undefined);
  return entries.map(([k, val]) => `${k}: ${serializeYaml(val)}`).join(', ');
}

function countIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

// ── File I/O ──────────────────────────────────────────────────────────

export class Storage {
  /** Read a Markdown file with frontmatter. Throws if not found. */
  read<TMeta = Record<string, unknown>>(path: string): ParsedDoc<TMeta> {
    if (!existsSync(path)) {
      throw new Error(`File not found: ${path}`);
    }
    const md = readFileSync(path, 'utf8');
    return parseFrontmatter<TMeta>(md);
  }

  /** Read a Markdown file; returns null if not found. */
  readIfExists<TMeta = Record<string, unknown>>(path: string): ParsedDoc<TMeta> | null {
    if (!existsSync(path)) return null;
    return this.read<TMeta>(path);
  }

  /**
   * Write a Markdown file atomically (tmp + rename). Creates parent dirs.
   * The meta object is serialized as YAML frontmatter; body as Markdown.
   */
  write<TMeta>(path: string, meta: TMeta, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp-' + process.pid;
    const md = serializeFrontmatter(meta, body);
    writeFileSync(tmp, md, 'utf8');
    renameSync(tmp, path); // atomic on POSIX
  }

  /** List all .md files in a directory (non-recursive). */
  listMarkdown(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .map((f) => join(dir, f));
  }
}

/** Simple per-path mutex for concurrent write serialization. */
class KeyedMutex {
  private chains = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    // v0.7.3: keep the chained promise in a variable — the old cleanup
    // compared against a FRESH `prev.then(...)` promise, so it never matched
    // and entries leaked forever.
    const chained = prev.then(() => next);
    this.chains.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // Cleanup if this was the last in chain.
      if (this.chains.get(key) === chained) {
        this.chains.delete(key);
      }
    }
  }
}

export const workspaceMutex = new KeyedMutex();