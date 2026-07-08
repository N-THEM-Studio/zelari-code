/**
 * lsp/manager — spawn + lifecycle for language servers, exposing normalized
 * navigation operations (the `LspProvider` the LSP tools depend on).
 *
 * One server process is started lazily per language and reused for the
 * session. Documents are opened/synced on demand. All operations are
 * best-effort: a missing server binary, a spawn failure, or a request
 * timeout resolves to an empty/neutral result so the tools degrade cleanly.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { LspClient, type LspTransport } from './client.js';
import { pathToUri, uriToPath, type Location } from './protocol.js';
import { resolveServerCommand, languageIdForFile } from './servers.js';

export interface SymbolInfo {
  name: string;
  /** Human-readable symbol kind (e.g. 'Function', 'Class'). */
  kind: string;
  /** 1-based line of the symbol. */
  line: number;
}

export interface RenameFileEdit {
  file: string;
  /** Number of textual edits in this file. */
  count: number;
}

export interface RenameResult {
  files: RenameFileEdit[];
  /** Total edits across all files. */
  totalEdits: number;
}

/** Normalized navigation surface used by the LSP tools. */
export interface LspProvider {
  definition(file: string, line: number, character: number): Promise<Location[]>;
  references(file: string, line: number, character: number): Promise<Location[]>;
  hover(file: string, line: number, character: number): Promise<string | null>;
  documentSymbols(file: string): Promise<SymbolInfo[]>;
  rename(file: string, line: number, character: number, newName: string): Promise<RenameResult | null>;
  dispose(): void;
}

/** Spawn a child process and adapt its stdio to an LspTransport. */
function processTransport(child: ChildProcessWithoutNullStreams): LspTransport {
  return {
    send: (data) => {
      if (child.stdin.writable) child.stdin.write(data);
    },
    onData: (cb) => child.stdout.on('data', (b: Buffer) => cb(b.toString('utf8'))),
    onClose: (cb) => child.on('exit', cb),
    dispose: () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

const SYMBOL_KINDS: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class', 6: 'Method',
  7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum', 11: 'Interface',
  12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
  17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key', 21: 'Null',
  22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
};

interface ServerEntry {
  client: LspClient;
  initialized: Promise<void>;
  opened: Map<string, number>; // uri → version
  dispose: () => void;
}

export interface LspManagerOptions {
  cwd?: string;
  /** Inject a spawn implementation (tests). Defaults to child_process.spawn. */
  spawnImpl?: typeof spawn;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Sink for once-per-language "server unavailable" notices (default: console.error). */
  onWarn?: (message: string) => void;
}

export class LspManager implements LspProvider {
  private readonly cwd: string;
  private readonly spawnImpl: typeof spawn;
  private readonly timeoutMs: number;
  private readonly onWarn: (message: string) => void;
  private servers = new Map<string, ServerEntry | null>(); // language → entry (null = unavailable)
  private warnedMissing = new Set<string>(); // languages already flagged as unavailable

  constructor(options: LspManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.onWarn = options.onWarn ?? ((m) => console.error(m));
  }

  /** Lazily start (or reuse) the server for a file's language. Null if none. */
  private getServer(file: string): ServerEntry | null {
    const cmd = resolveServerCommand(file, this.cwd);
    if (!cmd) return null;
    const cached = this.servers.get(cmd.language);
    if (cached !== undefined) return cached;

    // The 'error' event (e.g. ENOENT for a missing binary) fires asynchronously,
    // so a synchronous try/catch around spawn() cannot catch it. We build the
    // initialize promise from an explicit controller so the handler below can
    // reject it and flip the cache to null — mirroring the documented contract
    // that a missing/spawning server resolves to an empty/neutral result.
    let resolveInit!: () => void;
    let rejectInit!: (e: Error) => void;
    const initialized = new Promise<void>((resolve, reject) => {
      resolveInit = resolve;
      rejectInit = reject;
    });

    let entry: ServerEntry | null = null;
    try {
      const child = this.spawnImpl(cmd.command, cmd.args, {
        cwd: this.cwd,
      }) as ChildProcessWithoutNullStreams;
      const client = new LspClient(processTransport(child), { timeoutMs: this.timeoutMs });

      // Handle spawn failures (missing binary, EACCES, …) that emit 'error'
      // AFTER spawn() returned. Without this, the event is unhandled and kills
      // the whole process. Mark the language unavailable so we never retry and
      // any in-flight call rejects into the withDoc() fallback.
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (this.servers.get(cmd.language) === null) return; // already handled
        this.servers.set(cmd.language, null);
        rejectInit(err instanceof Error ? err : new Error(String(err)));
        try {
          client.dispose();
        } catch {
          /* ignore */
        }
        if (!this.warnedMissing.has(cmd.language)) {
          this.warnedMissing.add(cmd.language);
          this.onWarn(
            `[zelari-code] ${cmd.command} unavailable (LSP tools disabled for ${cmd.language}): ${
              err?.code === 'ENOENT' ? 'binary not found on PATH' : err?.message ?? String(err)
            }`,
          );
        }
      });

      client
        .request('initialize', {
          processId: process.pid,
          rootUri: pathToUri(this.cwd),
          capabilities: {},
          workspaceFolders: [{ uri: pathToUri(this.cwd), name: 'root' }],
        })
        .then(() => {
          client.notify('initialized', {});
          resolveInit();
        })
        .catch((e: unknown) => rejectInit(e instanceof Error ? e : new Error(String(e))));

      entry = { client, initialized, opened: new Map(), dispose: () => client.dispose() };
    } catch (e) {
      // Synchronous spawn failure (rare; most failures surface via 'error').
      this.servers.set(cmd.language, null);
      this.warnMissing(cmd.language, cmd.command, e);
      return null;
    }
    this.servers.set(cmd.language, entry);
    return entry;
  }

  private warnMissing(language: string, command: string, err: unknown): void {
    if (this.warnedMissing.has(language)) return;
    this.warnedMissing.add(language);
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const msg = code === 'ENOENT'
      ? 'binary not found on PATH'
      : (err as Error | undefined)?.message ?? String(err);
    this.onWarn(`[zelari-code] ${command} unavailable (LSP tools disabled for ${language}): ${msg}`);
  }

  /** Ensure a document is open (or synced) on the server. */
  private async openDoc(entry: ServerEntry, file: string): Promise<string> {
    await entry.initialized;
    const uri = pathToUri(file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
    const prev = entry.opened.get(uri);
    if (prev === undefined) {
      entry.client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageIdForFile(file), version: 1, text },
      });
      entry.opened.set(uri, 1);
    } else {
      const version = prev + 1;
      entry.client.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      entry.opened.set(uri, version);
    }
    return uri;
  }

  private async withDoc<T>(
    file: string,
    fn: (entry: ServerEntry, uri: string) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const entry = this.getServer(file);
    if (!entry) return fallback;
    try {
      const uri = await this.openDoc(entry, file);
      return await fn(entry, uri);
    } catch {
      return fallback;
    }
  }

  async definition(file: string, line: number, character: number): Promise<Location[]> {
    return this.withDoc(
      file,
      async (entry, uri) => {
        const res = await entry.client.request('textDocument/definition', {
          textDocument: { uri },
          position: { line, character },
        });
        return normalizeLocations(res);
      },
      [],
    );
  }

  async references(file: string, line: number, character: number): Promise<Location[]> {
    return this.withDoc(
      file,
      async (entry, uri) => {
        const res = await entry.client.request('textDocument/references', {
          textDocument: { uri },
          position: { line, character },
          context: { includeDeclaration: true },
        });
        return normalizeLocations(res);
      },
      [],
    );
  }

  async hover(file: string, line: number, character: number): Promise<string | null> {
    return this.withDoc(
      file,
      async (entry, uri) => {
        const res = (await entry.client.request('textDocument/hover', {
          textDocument: { uri },
          position: { line, character },
        })) as { contents?: unknown } | null;
        return extractHoverText(res);
      },
      null,
    );
  }

  async documentSymbols(file: string): Promise<SymbolInfo[]> {
    return this.withDoc(
      file,
      async (entry, uri) => {
        const res = (await entry.client.request('textDocument/documentSymbol', {
          textDocument: { uri },
        })) as unknown[];
        return normalizeSymbols(res);
      },
      [],
    );
  }

  async rename(
    file: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<RenameResult | null> {
    return this.withDoc(
      file,
      async (entry, uri) => {
        const res = (await entry.client.request('textDocument/rename', {
          textDocument: { uri },
          position: { line, character },
          newName,
        })) as { changes?: Record<string, unknown[]>; documentChanges?: unknown[] } | null;
        return normalizeRename(res);
      },
      null,
    );
  }

  dispose(): void {
    for (const entry of this.servers.values()) entry?.dispose();
    this.servers.clear();
  }
}

// ---------------------------------------------------------------------------
// Shared singleton — LSP servers are heavy, so one manager is reused across
// turns and disposed on process exit (rather than one per tool registry).
// ---------------------------------------------------------------------------

let shared: { cwd: string; manager: LspManager } | null = null;

export function getSharedLspManager(cwd: string = process.cwd()): LspManager {
  if (shared && shared.cwd === cwd) return shared.manager;
  // cwd changed (rare) — dispose the old one and start fresh.
  shared?.manager.dispose();
  const manager = new LspManager({ cwd });
  shared = { cwd, manager };
  return manager;
}

export function disposeSharedLspManager(): void {
  shared?.manager.dispose();
  shared = null;
}

// Best-effort cleanup so language servers don't outlive the CLI.
if (typeof process !== 'undefined' && typeof process.once === 'function') {
  process.once('exit', () => {
    try {
      shared?.manager.dispose();
    } catch {
      /* ignore */
    }
  });
}

// ---------------------------------------------------------------------------
// Response normalizers (exported for unit testing)
// ---------------------------------------------------------------------------

export function normalizeLocations(res: unknown): Location[] {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  const out: Location[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const loc = item as { uri?: string; targetUri?: string; range?: unknown; targetRange?: unknown };
    const uri = loc.uri ?? loc.targetUri;
    const range = (loc.range ?? loc.targetRange) as Location['range'] | undefined;
    if (typeof uri === 'string' && range) out.push({ uri, range });
  }
  return out;
}

export function extractHoverText(res: { contents?: unknown } | null): string | null {
  if (!res || !res.contents) return null;
  const c = res.contents;
  if (typeof c === 'string') return c.trim() || null;
  if (Array.isArray(c)) {
    return (
      c
        .map((x) => (typeof x === 'string' ? x : (x as { value?: string })?.value ?? ''))
        .filter(Boolean)
        .join('\n')
        .trim() || null
    );
  }
  if (typeof c === 'object' && 'value' in (c as object)) {
    return ((c as { value?: string }).value ?? '').trim() || null;
  }
  return null;
}

export function normalizeSymbols(res: unknown): SymbolInfo[] {
  if (!Array.isArray(res)) return [];
  const out: SymbolInfo[] = [];
  const visit = (nodes: unknown[]) => {
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const s = n as {
        name?: string;
        kind?: number;
        range?: { start?: { line?: number } };
        location?: { range?: { start?: { line?: number } } };
        children?: unknown[];
      };
      const line0 = s.range?.start?.line ?? s.location?.range?.start?.line;
      if (typeof s.name === 'string' && typeof line0 === 'number') {
        out.push({ name: s.name, kind: SYMBOL_KINDS[s.kind ?? 0] ?? 'Symbol', line: line0 + 1 });
      }
      if (Array.isArray(s.children)) visit(s.children);
    }
  };
  visit(res);
  return out;
}

export function normalizeRename(
  res: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] } | null,
): RenameResult | null {
  if (!res) return null;
  const files: RenameFileEdit[] = [];
  let total = 0;
  if (res.changes && typeof res.changes === 'object') {
    for (const [uri, edits] of Object.entries(res.changes)) {
      const count = Array.isArray(edits) ? edits.length : 0;
      files.push({ file: uriToPath(uri), count });
      total += count;
    }
  }
  if (Array.isArray(res.documentChanges)) {
    for (const dc of res.documentChanges) {
      const d = dc as { textDocument?: { uri?: string }; edits?: unknown[] };
      if (d?.textDocument?.uri) {
        const count = Array.isArray(d.edits) ? d.edits.length : 0;
        files.push({ file: uriToPath(d.textDocument.uri), count });
        total += count;
      }
    }
  }
  if (files.length === 0) return null;
  return { files, totalEdits: total };
}
