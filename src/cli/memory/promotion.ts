import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemoryNode } from '@zelari/core/memory';

const START = '<!-- zelari:memory-promotions:start -->';
const END = '<!-- zelari:memory-promotions:end -->';
const DURABLE_KINDS = new Set(['fact', 'decision', 'constraint', 'preference', 'procedure']);

export const PROMOTE_MIN_IMPORTANCE = 0.7;
export const PROMOTE_MIN_CONFIDENCE = 0.8;

export interface MemoryPromotionResult {
  added: boolean;
  path: string;
  reason?: string;
}

/** Numeric floor, or an explicit verified/validated_by mark from ops-knowledge. */
export function meetsPromoteThreshold(node: MemoryNode): boolean {
  if (node.metadata?.verified === true) return true;
  if (node.metadata?.validatedBy === true) return true;
  return node.importance >= PROMOTE_MIN_IMPORTANCE && node.confidence >= PROMOTE_MIN_CONFIDENCE;
}

export function formatPromoteNotice(node: MemoryNode): string {
  const preview = node.content.replace(/\s+/g, ' ').trim().slice(0, 120);
  return `[memory] candidato AGENTS.MD: ${node.kind} “${preview}” — /memory promote ${node.id}`;
}

/** Argument shape of `/memory promote` (slice A adds `--as-check`). */
export interface PromoteArgs {
  /** Memory id to act on (first free token). */
  id?: string;
  /** True when the human asked for a WorldCheck append, not an AGENTS.md line. */
  asCheck: boolean;
  /** Human-typed command of the check. Never auto-filled from the failure. */
  command?: string;
  /** Expected exit code override (default: the proposal template, 0). */
  expectExit?: number;
  /** Parse error to surface instead of acting. */
  error?: string;
}

export const PROMOTE_USAGE =
  'Usage: /memory promote <id> [--as-check --command "<comando>" [--expect-exit N]]';

const COMMAND_FLAGS = new Set(['--command', '-c']);
const EXIT_FLAGS = new Set(['--expect-exit', '-e', '--expectExit']);

/**
 * Pure parser for `/memory promote` (the slash layer only splits on spaces, so
 * `--command` swallows every token up to the next flag and re-joins them).
 * Applying a check to `checks.json` is always explicit: the command must be
 * typed by a human, nothing is inferred from the failing run.
 */
export function parsePromoteArgs(args: readonly string[] = []): PromoteArgs {
  const result: PromoteArgs = { asCheck: false };
  const tokens = [...args];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const inline = token.startsWith('--') && token.includes('=') ? token.split('=') : null;
    const flag = inline ? (inline[0] ?? '') : token;
    const inlineValue = inline ? inline.slice(1).join('=') : undefined;
    if (flag === '--as-check') {
      result.asCheck = true;
      continue;
    }
    if (COMMAND_FLAGS.has(flag) || EXIT_FLAGS.has(flag)) {
      const parts: string[] = [];
      if (inlineValue !== undefined && inlineValue !== '') parts.push(inlineValue);
      else {
        while (i + 1 < tokens.length && !(tokens[i + 1] ?? '').startsWith('-')) {
          parts.push(tokens[i + 1] ?? '');
          i += 1;
        }
      }
      const value = parts
        .join(' ')
        .replace(/^\s*["']|["']\s*$/g, '')
        .trim();
      if (EXIT_FLAGS.has(flag)) {
        const exit = Number(value);
        if (!value || !Number.isInteger(exit)) {
          return { ...result, error: `expect-exit must be an integer, got “${value}”.` };
        }
        result.expectExit = exit;
        continue;
      }
      if (!value) return { ...result, error: 'missing value for --command.' };
      result.command = value;
      continue;
    }
    if (token.startsWith('-')) return { ...result, error: `unknown flag “${token}”.` };
    if (!result.id) result.id = token;
    else if (!result.command) return { ...result, error: `unexpected argument “${token}”.` };
  }
  return result;
}

function lineFor(node: MemoryNode): string {
  const content = node.content
    .replace(/\s+/g, ' ')
    .replace(/-->/g, '—>')
    .trim()
    .slice(0, 2_000);
  const provenance = node.source.agent ? `; source=${node.source.agent}` : '';
  return `- **${node.kind}**: ${content} <!-- memory:${node.id}${provenance} -->`;
}

/** Manual, idempotent promotion hook; consolidation never edits AGENTS.md automatically. */
export async function promoteMemoryToAgentsMd(
  projectRoot: string,
  node: MemoryNode,
): Promise<MemoryPromotionResult> {
  if (node.status !== 'active') {
    return { added: false, path: path.join(projectRoot, 'AGENTS.md'), reason: `memory is ${node.status}` };
  }
  if (!DURABLE_KINDS.has(node.kind)) {
    return { added: false, path: path.join(projectRoot, 'AGENTS.md'), reason: `${node.kind} is not a durable instruction kind` };
  }
  // The manual `/memory promote` path carries the SAME bar the notices assume
  // (importance ≥ 0.7 AND confidence ≥ 0.8, or an explicit verified mark):
  // nothing below it is worth a permanent AGENTS.md line.
  if (!meetsPromoteThreshold(node)) {
    return { added: false, path: path.join(projectRoot, 'AGENTS.md'), reason: 'below-threshold' };
  }
  const root = await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
  const target = path.join(root, 'AGENTS.md');
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('AGENTS.md must be a regular project file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let current = '';
  try { current = await fs.readFile(target, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (current.includes(`memory:${node.id}`)) return { added: false, path: target, reason: 'already promoted' };

  const entry = lineFor(node);
  let updated: string;
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start) throw new Error('AGENTS.md has an incomplete Zelari memory promotion block.');
    updated = `${current.slice(0, end).replace(/\s*$/, '\n')}${entry}\n${current.slice(end)}`;
  } else {
    const prefix = current.trimEnd();
    updated = `${prefix}${prefix ? '\n\n' : '# AGENTS.md\n\n'}${START}\n## Zelari durable memory\n\n${entry}\n${END}\n`;
  }
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, updated, { encoding: 'utf8', flag: 'wx' });
  try { await fs.rename(temporary, target); }
  catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
  return { added: true, path: target };
}
