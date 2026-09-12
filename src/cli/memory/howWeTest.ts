/**
 * `.zelari/how-we-test.md` — the shared testing playbook (slice C of the
 * "steal Cursor Projects" plan).
 *
 * `opsKnowledge.ts` already remembers a verified `procedure` in Memory V2
 * every time a strict gate PASSes on deterministic, event-backed evidence.
 * That knowledge is only useful to agents that can *read* it, so this module
 * projects it into a human- and agent-readable markdown file.
 *
 * The projection is a pure function of the rows; the writer is atomic
 * (tmp → rename) and byte-idempotent, so regenerating on every promotion does
 * not churn the file when nothing changed.
 *
 * Never throws to the parent run — a projection failure must not affect a gate.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemoryNode } from '@zelari/core/memory';

export const HOW_WE_TEST_RELATIVE = path.join('.zelari', 'how-we-test.md');
/** Header marker: humans must not hand-edit a generated file. */
export const HOW_WE_TEST_HEADER =
  '<!-- generato — non editare (rigenera con /memory how-we-test) -->';

export interface HowWeTestRow {
  /** `metadata.opsKnowledgeKey` — the dedupe key written by opsKnowledge. */
  key: string;
  criterionId: string;
  command: string;
  digest: string;
  /** Verification seq of the observation that produced this procedure. */
  seq?: number;
}

export interface HowWeTestWriteResult {
  written: boolean;
  path: string;
  rows: number;
  reason?: string;
}

function metaString(node: MemoryNode, key: string): string | undefined {
  const value = node.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function metaNumber(node: MemoryNode, key: string): number | undefined {
  const value = node.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** One row per verified, active `procedure` node. Null when not projectable. */
export function rowFromNode(node: MemoryNode): HowWeTestRow | null {
  if (node.kind !== 'procedure' || node.status !== 'active') return null;
  if (node.metadata?.verified !== true) return null;
  const key = metaString(node, 'opsKnowledgeKey');
  const command = metaString(node, 'command');
  const digest = metaString(node, 'digest');
  if (!key || !command || !digest) return null;
  const seq = metaNumber(node, 'seq');
  return {
    key,
    criterionId: metaString(node, 'criterionId') ?? 'unknown',
    command,
    digest,
    ...(seq === undefined ? {} : { seq }),
  };
}

/**
 * Rows for the projection, deduped by `opsKnowledgeKey` (the same procedure
 * re-verified keeps the newest observation). Order-independent: the input is
 * sorted before deduping so any permutation projects to the same bytes.
 */
export function collectHowWeTestRows(nodes: readonly MemoryNode[]): HowWeTestRow[] {
  const rows = nodes.map(rowFromNode).filter((row): row is HowWeTestRow => row !== null);
  rows.sort((a, b) => a.key.localeCompare(b.key) || (a.seq ?? -1) - (b.seq ?? -1));
  const byKey = new Map<string, HowWeTestRow>();
  for (const row of rows) byKey.set(row.key, row);
  return [...byKey.values()].sort(
    (a, b) => a.criterionId.localeCompare(b.criterionId) || a.command.localeCompare(b.command),
  );
}

/** Short digest for display: enough to disambiguate, short enough to read. */
export function shortDigest(digest: string): string {
  return digest.length <= 8 ? digest : digest.slice(0, 8);
}

function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/`/g, "'").trim();
}

/** Pure: rows → markdown. Deterministic and idempotent. */
export function projectHowWeTest(rows: readonly HowWeTestRow[]): string {
  const lines: string[] = [
    '# How we test',
    '',
    HOW_WE_TEST_HEADER,
    '',
    'Procedure verificate (deterministiche, evidence-backed): quello che una run',
    'ha dimostrato resta qui per gli agenti e per gli umani che vengono dopo.',
    'Generato da zelari — rigenera con `/memory how-we-test`.',
    '',
  ];
  if (rows.length === 0) {
    lines.push('_Nessuna procedura verificata ancora: niente da proiettare._', '');
    return lines.join('\n');
  }
  let current: string | null = null;
  for (const row of rows) {
    if (row.criterionId !== current) {
      current = row.criterionId;
      lines.push(`## ${current}`, '');
    }
    const seq = row.seq === undefined ? '—' : `seq ${row.seq}`;
    lines.push(`- \`${escapeCell(row.command)}\` — exit 0 — digest \`${shortDigest(row.digest)}\` — ultima osservazione ${seq}`);
  }
  lines.push('');
  return lines.join('\n');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Atomic write to `<projectRoot>/.zelari/how-we-test.md` (tmp + rename), the
 * same pattern `promotion.ts` uses for AGENTS.md. Refuses symlink targets and
 * removes its temporary file on failure.
 */
export async function writeHowWeTest(
  projectRoot: string,
  rows: readonly HowWeTestRow[],
): Promise<HowWeTestWriteResult> {
  const target = path.join(projectRoot, HOW_WE_TEST_RELATIVE);
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) {
      return { written: false, path: target, rows: rows.length, reason: 'target is a symbolic link' };
    }
  } catch (error) {
    if (!isMissing(error)) {
      return {
        written: false,
        path: target,
        rows: rows.length,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, projectHowWeTest(rows), { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  return { written: true, path: target, rows: rows.length };
}

/**
 * Projection source. `MemoryService.export()` is the only enumeration seam the
 * narrow ops-knowledge memory interface exposes; a host without it (tests,
 * file-less backends) simply has nothing to project.
 */
export interface HowWeTestSource {
  export?(): Promise<unknown>;
}

function nodesFromDump(dump: unknown): MemoryNode[] {
  if (Array.isArray(dump)) return dump as MemoryNode[];
  const nodes = (dump as { nodes?: unknown } | null)?.nodes;
  return Array.isArray(nodes) ? (nodes as MemoryNode[]) : [];
}

/** All nodes, or null when the source cannot enumerate (no `export`). */
export async function listNodes(source: HowWeTestSource): Promise<MemoryNode[] | null> {
  if (typeof source.export !== 'function') return null;
  try {
    return nodesFromDump(await source.export());
  } catch {
    return null;
  }
}

/** Verified procedures only, or null when the source cannot enumerate. */
export async function listVerifiedProcedureNodes(
  source: HowWeTestSource,
): Promise<MemoryNode[] | null> {
  const nodes = await listNodes(source);
  if (!nodes) return null;
  return nodes.filter((node) => node.kind === 'procedure' && node.metadata?.verified === true);
}

/** Explicit regeneration (`/memory how-we-test`). Returns the outcome, never throws. */
export async function regenerateHowWeTest(
  source: HowWeTestSource,
  projectRoot: string,
): Promise<HowWeTestWriteResult> {
  const nodes = await listVerifiedProcedureNodes(source);
  if (!nodes) {
    return {
      written: false,
      path: path.join(projectRoot, HOW_WE_TEST_RELATIVE),
      rows: 0,
      reason: 'memory backend cannot enumerate procedures',
    };
  }
  try {
    return await writeHowWeTest(projectRoot, collectHowWeTestRows(nodes));
  } catch (error) {
    return {
      written: false,
      path: path.join(projectRoot, HOW_WE_TEST_RELATIVE),
      rows: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Slice C trigger: auto-regenerate after a promotion that created something.
 * Best-effort by contract; the caller is already behind the opt-in flag.
 */
export async function regenerateHowWeTestSafe(
  source: HowWeTestSource,
  projectRoot: string,
): Promise<HowWeTestWriteResult | null> {
  const nodes = await listVerifiedProcedureNodes(source);
  if (!nodes) return null;
  try {
    return await writeHowWeTest(projectRoot, collectHowWeTestRows(nodes));
  } catch {
    return null;
  }
}
