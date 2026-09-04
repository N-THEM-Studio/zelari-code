import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage } from '../components/ChatStream.js';
import type { MemoryIndexResult } from '@zelari/core/memory';
import { appendSystem } from '../hooks/messageHelpers.js';
import { getMemoryService } from '../memory/serviceFactory.js';
import { promoteMemoryToAgentsMd } from '../memory/promotion.js';

export interface MemorySlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  cwd: string;
}

const USAGE = [
  '/memory — backend summary',
  '/memory search <query>',
  '/memory show <id>',
  '/memory related <id>',
  '/memory history <id>',
  '/memory retract <id> [reason]',
  '/memory forget <id> --yes',
  '/memory consolidate [query]',
  '/memory index [--force]',
  '/memory promote <id> — append durable knowledge to managed AGENTS.md section',
  '/memory stats | doctor | export [project-relative-path]',
].join('\n  ');

function compact(value: unknown, max = 500): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sourceLine(source: object): string {
  const entries = Object.entries(source).filter(([, value]) => value !== undefined && value !== '');
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(' · ') : 'unknown';
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function safeExportPath(cwd: string, requested: string | undefined): Promise<string> {
  const lexicalRoot = path.resolve(cwd);
  const root = await fs.realpath(lexicalRoot).catch(() => lexicalRoot);
  const fallback = path.join(root, '.zelari', 'memory', `export-${Date.now()}.json`);
  const target = requested?.trim() ? path.resolve(root, requested.trim()) : fallback;
  if (!isInside(root, target)) {
    throw new Error('Export path must stay inside the active project.');
  }
  const parent = path.dirname(target);
  const relativeParent = path.relative(root, parent);
  let cursor = root;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error('Export path must not traverse a symbolic link.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) {
      throw new Error('Export target must not be a symbolic link.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

export async function handleMemoryCommand(
  ctx: MemorySlashContext,
  subcommand = 'stats',
  args: string[] = [],
): Promise<void> {
  const warnings: string[] = [];
  const memory = await getMemoryService(ctx.cwd, process.env, {
    force: true,
    onWarning: (warning) => warnings.push(warning),
  });
  const emit = (message: string) => appendSystem(
    ctx.setMessages,
    warnings.length ? `${warnings.join('\n')}\n${message}` : message,
  );
  try {
    switch (subcommand) {
      case '':
      case 'stats': {
        const stats = await memory.stats();
        emit(
          `[memory] backend=${stats.backend} · schema=v${stats.schemaVersion}\n` +
          `  nodes ${stats.nodes} (active ${stats.active}, superseded ${stats.superseded}, ` +
          `retracted ${stats.retracted}, archived ${stats.archived})\n` +
          `  edges ${stats.edges} · candidates ${stats.unconsolidatedCandidates} · ` +
          `semantic ${stats.semanticIndex}` +
          (stats.semanticModel ? ` (${stats.semanticModel}: ${stats.semanticIndexed ?? 0} indexed, ${stats.semanticStale ?? 0} stale)` : '') +
          (stats.path ? `\n  db ${stats.path}` : '') +
          `\n  ${USAGE}`,
        );
        return;
      }
      case 'search': {
        const query = args.join(' ').trim();
        if (!query) { emit('Usage: /memory search <query>'); return; }
        const hits = await memory.recall({ text: query, useGraph: true, limit: 12 });
        if (!hits.length) { emit(`[memory] no active matches for “${query}”.`); return; }
        emit(`[memory] ${hits.length} match(es)\n` + hits.map(({ node, score }) =>
          `  ${node.id} · ${node.kind} · ${score.toFixed(2)} · ${compact(node.content, 240)}`,
        ).join('\n'));
        return;
      }
      case 'show': {
        const node = args[0] ? await memory.get(args[0]) : null;
        if (!args[0]) { emit('Usage: /memory show <id>'); return; }
        if (!node) { emit(`[memory] ${args[0]} not found in this project.`); return; }
        emit(
          `[memory] ${node.id}\n  kind=${node.kind} status=${node.status} ` +
          `visibility=${node.visibility ?? 'project'} ` +
          `importance=${node.importance.toFixed(2)} confidence=${node.confidence.toFixed(2)}\n` +
          `  created=${node.createdAt} updated=${node.updatedAt}\n` +
          `  source: ${sourceLine(node.source)}\n` +
          `  tags: ${node.tags.join(', ') || '—'}\n` +
          `  ${node.content}\n  metadata: ${compact(node.metadata, 1_000)}`,
        );
        return;
      }
      case 'related': {
        const memoryId = args[0];
        if (!memoryId) { emit('Usage: /memory related <id>'); return; }
        const related = await memory.related(memoryId, { direction: 'both', limit: 100 });
        emit(related.length
          ? `[memory] related to ${memoryId}\n` + related.map(({ edge, node }) =>
              `  ${edge.from} -${edge.relation}-> ${edge.to} · ${node.kind} · ${compact(node.content, 180)}`,
            ).join('\n')
          : `[memory] no relations for ${memoryId}.`);
        return;
      }
      case 'history': {
        const memoryId = args[0];
        if (!memoryId) { emit('Usage: /memory history <id>'); return; }
        const versions = await memory.history(memoryId);
        emit(versions.length
          ? `[memory] history ${memoryId}\n` + versions.map((version) =>
              `  r${version.revision} · ${version.recordedAt} · ${version.reason ?? 'updated'} · ` +
              `${version.snapshot.status} · conf=${version.snapshot.confidence.toFixed(2)}`,
            ).join('\n')
          : `[memory] ${memoryId} not found or has no history.`);
        return;
      }
      case 'retract': {
        const memoryId = args[0];
        if (!memoryId) { emit('Usage: /memory retract <id> [reason]'); return; }
        await memory.retract(memoryId, args.slice(1).join(' ').trim() || undefined);
        emit(`[memory] retracted ${memoryId}; immutable history retained.`);
        return;
      }
      case 'forget': {
        const memoryId = args.find((arg) => !arg.startsWith('-'));
        const confirmed = args.includes('--yes') || args.includes('-y');
        if (!memoryId) { emit('Usage: /memory forget <id> --yes'); return; }
        if (!confirmed) {
          emit(`[memory] hard deletion removes node, edges, and history. Re-run /memory forget ${memoryId} --yes to confirm; use retract to retain provenance.`);
          return;
        }
        emit((await memory.forget(memoryId))
          ? `[memory] permanently deleted ${memoryId}.`
          : `[memory] ${memoryId} not found.`);
        return;
      }
      case 'consolidate': {
        const result = await memory.consolidate({
          query: args.join(' ').trim() || undefined,
          source: { agent: 'user-cli' },
        });
        emit(`[memory] consolidation scanned ${result.scanned} candidate(s), created ${result.created.length} durable node(s), archived ${result.archivedSourceIds.length} source duplicate(s).`);
        return;
      }
      case 'index': {
        const result: MemoryIndexResult = memory.index
          ? await memory.index({ force: args.includes('--force') || args.includes('-f') })
          : { status: 'disabled', scanned: 0, indexed: 0, skipped: 0, failed: 0, interrupted: false };
        emit(
          `[memory index] ${result.status}` +
          (result.model ? ` · ${result.model}` : '') +
          ` · scanned ${result.scanned} · indexed ${result.indexed} · failed ${result.failed}` +
          (result.interrupted ? ' · interrupted' : '') +
          (result.error ? `\n  ${result.error}` : ''),
        );
        return;
      }
      case 'promote': {
        const memoryId = args[0];
        if (!memoryId) { emit('Usage: /memory promote <id>'); return; }
        const node = await memory.get(memoryId);
        if (!node) { emit(`[memory] ${memoryId} not found in this project.`); return; }
        const promoted = await promoteMemoryToAgentsMd(ctx.cwd, node);
        emit(promoted.added
          ? `[memory] promoted ${memoryId} to ${promoted.path}`
          : `[memory] ${memoryId} not promoted: ${promoted.reason ?? 'policy rejected it'}.`);
        return;
      }
      case 'doctor': {
        const doctor = await memory.doctor();
        emit(`[memory doctor] ${doctor.ok ? 'PASS' : 'FAIL'} · ${doctor.backend}` +
          (doctor.path ? `\n  ${doctor.path}` : '') + '\n' +
          doctor.checks.map((check) => `  ${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`).join('\n'));
        return;
      }
      case 'export': {
        const target = await safeExportPath(ctx.cwd, args.join(' ').trim() || undefined);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const root = await fs.realpath(ctx.cwd).catch(() => path.resolve(ctx.cwd));
        const realParent = await fs.realpath(path.dirname(target));
        if (!isInside(root, realParent)) {
          throw new Error('Export path resolves outside the active project.');
        }
        await fs.writeFile(target, JSON.stringify(await memory.export(), null, 2) + '\n', 'utf8');
        emit(`[memory] export written to ${target}`);
        return;
      }
      case 'audit': {
        // W4.2: read-only decay + contradiction report. Contradictions are
        // flagged for council review (Minosse) — this NEVER mutates nodes.
        const { decayReport, detectContradictions } = await import('../memory/audit.js');
        type AuditNode = import('../memory/audit.js').AuditNode;
        const dump = (await memory.export()) as unknown;
        const nodes = (Array.isArray(dump) ? dump : ((dump as { nodes?: unknown[] }).nodes ?? [])) as AuditNode[];
        const contradictions = detectContradictions(nodes);
        const decayed = decayReport(nodes).slice(0, 10);
        emit(
          `[memory audit] ${nodes.length} node(s) · ${contradictions.length} contradiction(s) · ${decayed.length} decayed (top 10)` +
            (contradictions.length
              ? '\n  contradictions (flag for review):\n' +
                contradictions
                  .slice(0, 10)
                  .map((p) => `    ✗ ${p.a} ↔ ${p.b} · "${p.subject}" (${p.reason})`)
                  .join('\n')
              : '') +
            (decayed.length
              ? '\n  decay (30d half-life):\n' +
                decayed
                  .map((d) => `    ↓ ${d.id} · ${d.declared.toFixed(2)} → ${d.effective.toFixed(2)} (${Math.round(d.ageDays)}d)`)
                  .join('\n')
              : ''),
        );
        return;
      }
      default:
        emit(`[memory] unknown subcommand “${subcommand}”.\n  ${USAGE}`);
    }
  } catch (error) {
    emit(`[memory] error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await memory.close().catch(() => undefined);
  }
}
