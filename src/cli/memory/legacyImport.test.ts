import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultMemoryService, MemoryPolicyError } from '@zelari/core/memory';
import { importLegacyMemoryLog, LEGACY_IMPORT_MARKER } from './legacyImport.js';
import { SQLiteMemoryBackend } from './sqliteBackend.js';
import { SqliteWorkerRpc } from './sqliteRpc.js';
import { canonicalProjectId } from './serviceFactory.js';

const dirs: string[] = [];

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-legacy-import-'));
  dirs.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of dirs.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function openMemory(root: string): Promise<{ backend: SQLiteMemoryBackend; service: DefaultMemoryService }> {
  const backend = new SQLiteMemoryBackend();
  await backend.init(root);
  const service = new DefaultMemoryService(await canonicalProjectId(root), backend);
  return { backend, service };
}

function memoryDir(root: string): string {
  return path.join(root, '.zelari', 'memory');
}

function markerPath(root: string): string {
  return path.join(memoryDir(root), LEGACY_IMPORT_MARKER);
}

function legacyLine(id: string, content: string): string {
  return JSON.stringify({
    id,
    content,
    metadata: { source: 'council', memoryKind: 'decision' },
    createdAt: '2026-08-01T00:00:00.000Z',
  });
}

async function writeLog(root: string, lines: string[]): Promise<string> {
  const directory = memoryDir(root);
  await fs.mkdir(directory, { recursive: true });
  const logPath = path.join(directory, 'log.jsonl');
  await fs.writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');
  return logPath;
}

describe('legacy JSONL import', () => {
  it('keeps the same counts as the per-row implementation', async () => {
    const root = await project();
    await writeLog(root, [
      legacyLine('new-1', 'Legacy decision one.'),
      legacyLine('dup', 'Already imported legacy fact.'),
      '{ not json',
      JSON.stringify({ id: 'no-content', metadata: { source: 'council' } }),
      legacyLine('new-2', 'Legacy decision two.'),
    ]);
    const { backend, service } = await openMemory(root);
    const alreadyImported = await service.remember({
      kind: 'fact', content: 'Already imported legacy fact.', writeClass: 'auto',
    });
    await backend.recordImport('jsonl:dup', alreadyImported.id);

    // No marker yet: the log is read and every row is processed.
    await expect(fs.access(markerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    const result = await importLegacyMemoryLog(backend, service);
    expect(result).toEqual({ found: 5, imported: 2, skipped: 1, corrupt: 2 });
    expect((await service.stats()).nodes).toBe(3);
    expect(JSON.parse(await fs.readFile(markerPath(root), 'utf8')).found).toBe(5);
    await service.close();
  });

  it('skips log.jsonl and every import lookup once the marker exists', async () => {
    const root = await project();
    await writeLog(root, [legacyLine('legacy-1', 'Legacy fact imported once.')]);
    const first = await openMemory(root);
    expect(await importLegacyMemoryLog(first.backend, first.service))
      .toEqual({ found: 1, imported: 1, skipped: 0, corrupt: 0 });
    await first.service.close();

    // A line appended after completion must stay invisible while the marker lives.
    await fs.appendFile(
      path.join(memoryDir(root), 'log.jsonl'),
      `${legacyLine('legacy-2', 'Appended after completion.')}\n`,
      'utf8',
    );
    const second = await openMemory(root);
    const batchSpy = vi.spyOn(SQLiteMemoryBackend.prototype, 'hasImports');
    const singleSpy = vi.spyOn(SQLiteMemoryBackend.prototype, 'hasImport');
    const readSpy = vi.spyOn(fs, 'readFile');
    expect(await importLegacyMemoryLog(second.backend, second.service))
      .toEqual({ found: 0, imported: 0, skipped: 0, corrupt: 0 });
    expect(readSpy.mock.calls.filter(([file]) => String(file).endsWith('log.jsonl'))).toHaveLength(0);
    expect(batchSpy).not.toHaveBeenCalled();
    expect(singleSpy).not.toHaveBeenCalled();
    expect((await second.service.stats()).nodes).toBe(1);
    await second.service.close();

    // Deleting the marker is the documented manual re-import switch.
    await fs.rm(markerPath(root));
    const third = await openMemory(root);
    expect(await importLegacyMemoryLog(third.backend, third.service))
      .toEqual({ found: 2, imported: 1, skipped: 1, corrupt: 0 });
    expect((await third.service.stats()).nodes).toBe(2);
    await third.service.close();
  });

  it('writes the marker even when leftover lines stay corrupt', async () => {
    const root = await project();
    await writeLog(root, [legacyLine('ok-1', 'Corrupt-tolerant import.'), '{ broken']);
    const { backend, service } = await openMemory(root);
    expect(await importLegacyMemoryLog(backend, service))
      .toEqual({ found: 2, imported: 1, skipped: 0, corrupt: 1 });
    const marker = JSON.parse(await fs.readFile(markerPath(root), 'utf8')) as { found: number; at: string };
    expect(marker.found).toBe(2);
    expect(Number.isFinite(Date.parse(marker.at))).toBe(true);
    await service.close();
  });

  it('does not write the marker when a row fails for a transient reason', async () => {
    const root = await project();
    await writeLog(root, [legacyLine('retry-1', 'Transient failure stays unmarked.')]);
    const { backend, service } = await openMemory(root);
    vi.spyOn(service, 'remember').mockRejectedValueOnce(new Error('SQLite worker exited with code 1.'));
    expect(await importLegacyMemoryLog(backend, service))
      .toEqual({ found: 1, imported: 0, skipped: 1, corrupt: 0 });
    await expect(fs.access(markerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await service.close();
  });

  it('treats a policy rejection as a permanent skip and writes the marker', async () => {
    const root = await project();
    await writeLog(root, [legacyLine('secret-1', 'Legacy line rejected by the secret scanner.')]);
    const { backend, service } = await openMemory(root);
    vi.spyOn(service, 'remember').mockRejectedValueOnce(new MemoryPolicyError('Memory content was rejected by policy.'));
    expect(await importLegacyMemoryLog(backend, service))
      .toEqual({ found: 1, imported: 0, skipped: 1, corrupt: 0 });
    expect((JSON.parse(await fs.readFile(markerPath(root), 'utf8')) as { found: number }).found).toBe(1);
    await service.close();
  });

  it('leaves no marker when the legacy log is absent', async () => {
    const root = await project();
    const { backend, service } = await openMemory(root);
    expect(await importLegacyMemoryLog(backend, service))
      .toEqual({ found: 0, imported: 0, skipped: 0, corrupt: 0 });
    await expect(fs.access(markerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await service.close();
  });

  it('batches hasImports in chunks of 500 with correct membership', async () => {
    const root = await project();
    const { backend, service } = await openMemory(root);
    for (const id of ['imp-1', 'imp-3']) {
      const node = await service.remember({
        kind: 'fact', content: `Recorded import ${id}.`, writeClass: 'auto',
      });
      await backend.recordImport(id, node.id);
    }
    const statementSpy = vi.spyOn(SqliteWorkerRpc.prototype, 'statement');
    const ids = Array.from({ length: 501 }, (_, index) => `probe-${index}`);
    ids[0] = 'imp-1';
    ids[500] = 'imp-3';

    const found = await backend.hasImports(ids);
    expect(found).toEqual(new Set(['imp-1', 'imp-3']));
    const importQueries = statementSpy.mock.calls
      .filter(([step]) => String((step as { sql?: string }).sql).includes('memory_imports'));
    expect(importQueries).toHaveLength(2);
    expect(await backend.hasImport('imp-1')).toBe(true);
    expect(await backend.hasImport('probe-7')).toBe(false);
    await service.close();
  });
});
