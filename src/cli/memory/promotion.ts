import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemoryNode } from '@zelari/core/memory';

const START = '<!-- zelari:memory-promotions:start -->';
const END = '<!-- zelari:memory-promotions:end -->';
const DURABLE_KINDS = new Set(['fact', 'decision', 'constraint', 'preference', 'procedure']);

export interface MemoryPromotionResult {
  added: boolean;
  path: string;
  reason?: string;
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
