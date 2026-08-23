import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  DefaultMemoryService,
  NoopMemoryService,
  type MemoryEventSink,
  type MemoryEmbeddingProvider,
  type MemoryService,
} from '@zelari/core/memory';
import { importLegacyMemoryLog } from './legacyImport.js';
import { SQLiteMemoryBackend } from './sqliteBackend.js';
import { buildProviderEmbedFn, embedModel } from '../semantic/provider.js';

export interface MemoryServiceFactoryOptions {
  /** Build SQLite even when the V2 feature flag is off (used by /memory). */
  force?: boolean;
  onEvent?: MemoryEventSink;
  onWarning?: (message: string) => void;
  /** Test/host injection; production resolves the active provider when enabled. */
  embeddingProvider?: MemoryEmbeddingProvider;
}

export function isMemoryV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ZELARI_MEMORY === '0') return false;
  if (env.ZELARI_MEMORY_BACKEND === 'file' || env.ZELARI_MEMORY_BACKEND === 'jsonl') return false;
  return env.ZELARI_MEMORY_V2 === '1' || env.ZELARI_MEMORY_BACKEND === 'sqlite';
}

export function isMemoryAutoWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isMemoryV2Enabled(env) && env.ZELARI_MEMORY_AUTO_WRITE !== '0';
}

export function isMemorySemanticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isMemoryV2Enabled(env) && env.ZELARI_MEMORY_SEMANTIC === '1';
}

function semanticMinScore(env: NodeJS.ProcessEnv): number | undefined {
  const value = Number(env.ZELARI_MEMORY_SEMANTIC_MIN_SCORE);
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : undefined;
}

export async function canonicalProjectId(projectRoot: string): Promise<string> {
  let canonical: string;
  try { canonical = await fs.realpath(projectRoot); }
  catch { canonical = path.resolve(projectRoot); }
  canonical = canonical.replace(/\\/g, '/').replace(/\/$/, '');
  if (process.platform === 'win32') canonical = canonical.toLocaleLowerCase('en-US');
  return `project_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

/** Resolve, initialize, and legacy-import the project-scoped native service. */
export async function getMemoryService(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: MemoryServiceFactoryOptions = {},
): Promise<MemoryService> {
  const projectId = await canonicalProjectId(projectRoot);
  if (env.ZELARI_MEMORY === '0') return new NoopMemoryService(projectId);
  if (!options.force && !isMemoryV2Enabled(env)) return new NoopMemoryService(projectId);
  const backend = new SQLiteMemoryBackend();
  try {
    await backend.init(projectRoot);
    let embeddingProvider = options.embeddingProvider;
    if (!embeddingProvider && isMemorySemanticEnabled(env)) {
      try {
        const embed = await buildProviderEmbedFn();
        if (embed) embeddingProvider = { model: embedModel(), embed };
        else options.onWarning?.('[memory] semantic retrieval requested but no embedding-capable provider is configured; lexical fallback active.');
      } catch (error) {
        options.onWarning?.(
          `[memory] semantic provider initialization failed; lexical fallback active (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }
    const service = new DefaultMemoryService(projectId, backend, {
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(embeddingProvider ? { embeddingProvider } : {}),
      ...(semanticMinScore(env) !== undefined ? { minSemanticRelevance: semanticMinScore(env) } : {}),
    });
    if (backend.lastMigration) {
      const migration = backend.lastMigration;
      options.onWarning?.(
        `[memory] migrated SQLite schema v${migration.from} -> v${migration.to}` +
        (migration.backupPath ? `; backup: ${migration.backupPath}` : ''),
      );
      if (options.onEvent) {
        await Promise.resolve(options.onEvent({
          type: 'memory_migration',
          at: new Date().toISOString(),
          backend: 'sqlite',
          reason: `v${migration.from}->v${migration.to}`,
        })).catch(() => undefined);
      }
    }
    const imported = await importLegacyMemoryLog(backend, service);
    if (imported.imported > 0) {
      options.onWarning?.(`[memory] imported ${imported.imported} legacy JSONL record(s).`);
    }
    return service;
  } catch (error) {
    await backend.close().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    if (env.ZELARI_MEMORY_STRICT === '1') throw error;
    options.onWarning?.(`[memory] SQLite unavailable; continuing without V2 memory (${detail}).`);
    return new NoopMemoryService(projectId, detail);
  }
}
