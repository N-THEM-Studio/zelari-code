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
