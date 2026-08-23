import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemoryKind, MemoryService } from '@zelari/core/memory';
import { MEMORY_KINDS } from '@zelari/core/memory';
import type { SQLiteMemoryBackend } from './sqliteBackend.js';

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

/** Import the V1 JSONL log once per legacy id. The source file is untouched. */
export async function importLegacyMemoryLog(
  backend: SQLiteMemoryBackend,
  service: MemoryService,
): Promise<LegacyImportResult> {
  const result: LegacyImportResult = { found: 0, imported: 0, skipped: 0, corrupt: 0 };
  const logPath = path.join(path.dirname(backend.databasePath), 'log.jsonl');
  let raw: string;
  try { raw = await fs.readFile(logPath, 'utf8'); }
  catch { return result; }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    result.found += 1;
    let fact: LegacyFact;
    try { fact = JSON.parse(trimmed) as LegacyFact; }
    catch { result.corrupt += 1; continue; }
    const content = typeof fact.content === 'string' ? fact.content : fact.text;
    if (!content?.trim()) { result.corrupt += 1; continue; }
    const importId = sourceId(fact, trimmed);
    if (await backend.hasImport(importId)) { result.skipped += 1; continue; }
    const metadata = fact.metadata && typeof fact.metadata === 'object' ? fact.metadata : {};
    const createdAt = timestamp(fact.createdAt);
    try {
      const node = await service.remember({
        kind: kind(metadata),
        content,
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
          legacyId: fact.id,
          legacyCreatedAt: fact.createdAt,
          ...(fact.graph ? { legacyGraph: fact.graph } : {}),
        },
        writeClass: 'auto',
      });
      await backend.recordImport(importId, node.id);
      result.imported += 1;
    } catch {
      // A rejected secret or malformed legacy record is deliberately skipped.
      result.skipped += 1;
    }
  }
  return result;
}
