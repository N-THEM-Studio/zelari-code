import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = SqlValue[] | Record<string, SqlValue>;
export type SqlMode = 'run' | 'get' | 'all';

export interface SqlStep {
  sql: string;
  params?: SqlParams;
  mode?: SqlMode;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type SqliteError = Error & { code?: string; sqliteCode?: number };

function isBusy(error: unknown): boolean {
  const candidate = error as SqliteError;
  return candidate?.sqliteCode === 5 || candidate?.sqliteCode === 6 ||
    /(?:database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED)/i.test(
      candidate?.message ?? '',
    );
}

function resolveWorkerUrl(): URL {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const direct = path.join(here, 'sqliteWorker.mjs');
  if (existsSync(direct)) return pathToFileURL(direct);
  // In the single-file esbuild output import.meta.url is dist/cli/*.js,
  // while the copied worker remains under dist/cli/memory/.
  return pathToFileURL(path.join(here, 'memory', 'sqliteWorker.mjs'));
}

export class SqliteWorkerRpc {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closing = false;

  async open(args: {
    dbPath: string;
    schemaSql: string;
    ftsSql: string;
    schemaVersion: number;
    migrations?: ReadonlyArray<{ version: number; sql: string }>;
    timeoutMs?: number;
    migrationLockTimeoutMs?: number;
  }): Promise<{ fts: boolean; migratedFrom?: number; backupPath?: string }> {
    if (this.worker) return { fts: true };
    // Node 24 still labels `node:sqlite` experimental. Keep that runtime-only
    // warning inside the dedicated worker so every recall does not pollute the
    // TUI/headless protocol; operational errors still travel over RPC.
    const worker = new Worker(resolveWorkerUrl(), { execArgv: ['--no-warnings'] });
    this.worker = worker;
    worker.on('message', (message: {
      id: number;
      ok: boolean;
      value?: unknown;
      error?: {
        name?: string;
        message?: string;
        stack?: string;
        code?: string;
        errcode?: number;
      };
    }) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.ok) request.resolve(message.value);
      else {
        const error = new Error(message.error?.message ?? 'SQLite worker failed.');
        error.name = message.error?.name ?? 'Error';
        if (message.error?.stack) error.stack = message.error.stack;
        if (message.error?.code) (error as Error & { code?: string }).code = message.error.code;
        if (message.error?.errcode !== undefined) {
          (error as SqliteError).sqliteCode = Number(message.error.errcode);
        }
        request.reject(error);
      }
    });
    worker.on('error', (error) =>
      this.failAll(error instanceof Error ? error : new Error(String(error))),
    );
    worker.on('exit', (code) => {
      this.worker = null;
      if (!this.closing && code !== 0) {
        this.failAll(new Error(`SQLite worker exited with code ${code}.`));
      }
    });
    return this.requestWithBusyRetry('open', args) as Promise<{
      fts: boolean;
      migratedFrom?: number;
      backupPath?: string;
    }>;
  }

  statement<T>(step: SqlStep): Promise<T> {
    return this.requestWithBusyRetry('statement', step) as Promise<T>;
  }

  vectorSearch<T>(args: {
    sql: string;
    params: SqlParams;
    vector: number[];
    limit: number;
  }): Promise<T> {
    return this.requestWithBusyRetry('vectorSearch', args) as Promise<T>;
  }

  semanticStatus<T>(args: { model: string; projectId: string }): Promise<T> {
    return this.requestWithBusyRetry('semanticStatus', args) as Promise<T>;
  }

  batch<T = unknown[]>(steps: SqlStep[], immediate = true): Promise<T> {
    return this.requestWithBusyRetry('batch', { steps, immediate }) as Promise<T>;
  }

  exec(sql: string): Promise<void> {
    return this.requestWithBusyRetry('exec', { sql }) as Promise<void>;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.closing = true;
    try {
      await this.request('close', {});
    } finally {
      await worker.terminate();
      this.worker = null;
      this.closing = false;
    }
  }

  private request(operation: string, args: unknown): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('SQLite worker is not open.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, operation, args });
    });
  }

  private async requestWithBusyRetry(operation: string, args: unknown): Promise<unknown> {
    let attempt = 0;
    while (true) {
      try {
        return await this.request(operation, args);
      } catch (error) {
        if (!isBusy(error) || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
        attempt += 1;
      }
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
