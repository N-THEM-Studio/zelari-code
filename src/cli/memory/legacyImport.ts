import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemoryKind, MemoryService } from '@zelari/core/memory';
import { MEMORY_KINDS, MemoryPolicyError } from '@zelari/core/memory';
import type { SQLiteMemoryBackend } from './sqliteBackend.js';

/** Sidecar completion marker next to `memory.db`; deleting it forces a re-import. */
export const LEGACY_IMPORT_MARKER = 'legacy-import-done.json';

interface LegacyFact {
  id?: string;
  content?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  graph?: unknown;
  createdAt?: string;
}

export interface LegacyImportResult {
  found: number;
  imported: number;
  skipped: number;
  corrupt: number;
}

function sourceId(fact: LegacyFact, line: string): string {
  return `jsonl:${fact.id ?? createHash('sha256').update(line).digest('hex')}`;
}

function kind(metadata: Record<string, unknown>): MemoryKind {
  const raw = metadata.memoryKind;
  if ((MEMORY_KINDS as readonly unknown[]).includes(raw)) return raw as MemoryKind;
  if (metadata.completionOk === true) return 'outcome';
  if (metadata.runMode === 'design-phase') return 'decision';
  return 'finding';
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

interface LegacyImportRow {
  fact: LegacyFact;
  content: string;
  importId: string;
}

/** A rejected secret or malformed record stays rejected on every pass; a backend
 *  or RPC failure is transient and must keep the completion marker unwritten. */
function isPermanentSkip(error: unknown): boolean {
  return error instanceof MemoryPolicyError ||
    (error as { name?: string } | null)?.name === 'ZodError';
}

async function isImportComplete(markerPath: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as { found?: unknown; at?: unknown };
    return typeof marker?.found === 'number' && typeof marker?.at === 'string';
  } catch { return false; }
}

async function markImportComplete(markerPath: string, found: number): Promise<void> {
  const temporary = `${markerPath}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ found, at: new Date().toISOString() })}\n`, 'utf8');
    await fs.rename(temporary, markerPath);
  } catch {
    // Best effort: without the marker the next boot simply re-imports the log.
  }
}

/**
 * Import the V1 JSONL log once per legacy id. The source file is untouched.
 *
 * A pass that resolves every line (imported / skipped / corrupt) writes
 * `legacy-import-done.json` next to the database, so later boots return before
 * reading `log.jsonl`; deleting the marker forces a manual re-import.
 */
export async function importLegacyMemoryLog(
  backend: SQLiteMemoryBackend,
  service: MemoryService,
): Promise<LegacyImportResult> {
  const result: LegacyImportResult = { found: 0, imported: 0, skipped: 0, corrupt: 0 };
  const memoryDir = path.dirname(backend.databasePath);
  const markerPath = path.join(memoryDir, LEGACY_IMPORT_MARKER);
  if (await isImportComplete(markerPath)) return result;

  let raw: string;
  try { raw = await fs.readFile(path.join(memoryDir, 'log.jsonl'), 'utf8'); }
  catch { return result; }

  const rows: LegacyImportRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    result.found += 1;
    let fact: LegacyFact;
    try { fact = JSON.parse(trimmed) as LegacyFact; }
    catch { result.corrupt += 1; continue; }
    const content = typeof fact.content === 'string' ? fact.content : fact.text;
    if (!content?.trim()) { result.corrupt += 1; continue; }
    rows.push({ fact, content, importId: sourceId(fact, trimmed) });
  }

  // One batched lookup instead of one hasImport RPC per row; ids imported
  // earlier in this same pass are treated as skipped to keep legacy counts.
  const known = rows.length > 0
    ? await backend.hasImports([...new Set(rows.map((row) => row.importId))])
    : new Set<string>();
  const importedHere = new Set<string>();
  let unresolved = 0;
  for (const row of rows) {
    if (known.has(row.importId) || importedHere.has(row.importId)) { result.skipped += 1; continue; }
    const metadata = row.fact.metadata && typeof row.fact.metadata === 'object' ? row.fact.metadata : {};
    const createdAt = timestamp(row.fact.createdAt);
    try {
      const node = await service.remember({
        kind: kind(metadata),
        content: row.content,
        importance: typeof metadata.importance === 'number' ? metadata.importance : 0.55,
        confidence: typeof metadata.confidence === 'number' ? metadata.confidence : 0.65,
        source: {
          agent: typeof metadata.source === 'string' ? metadata.source : 'legacy-jsonl',
          ...(typeof metadata.sessionId === 'string' ? { sessionId: metadata.sessionId } : {}),
          ...(typeof metadata.missionId === 'string' ? { missionId: metadata.missionId } : {}),
          ...(typeof metadata.sliceId === 'string' ? { sliceId: metadata.sliceId } : {}),
        },
        ...(createdAt ? { createdAt, recordedAt: createdAt } : {}),
        metadata: {
          ...metadata,
          legacyId: row.fact.id,
          legacyCreatedAt: row.fact.createdAt,
          ...(row.fact.graph ? { legacyGraph: row.fact.graph } : {}),
        },
        writeClass: 'auto',
      });
      await backend.recordImport(row.importId, node.id);
      importedHere.add(row.importId);
      result.imported += 1;
    } catch (error) {
      // A rejected secret or malformed legacy record is deliberately skipped.
      result.skipped += 1;
      if (!isPermanentSkip(error)) unresolved += 1;
    }
  }

  const everyRowResolved = result.imported + result.skipped + result.corrupt === result.found;
  if (everyRowResolved && unresolved === 0) await markImportComplete(markerPath, result.found);
  return result;
}
