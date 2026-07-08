import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  encodeMessage,
  createMessageParser,
  pathToUri,
  uriToPath,
} from '../../src/cli/lsp/protocol.js';
import { LspClient, type LspTransport } from '../../src/cli/lsp/client.js';
import {
  LspManager,
  normalizeLocations,
  extractHoverText,
  normalizeSymbols,
  normalizeRename,
  type LspProvider,
} from '../../src/cli/lsp/manager.js';
import { createLspTools } from '../../src/cli/lsp/tools.js';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';

// ---------------------------------------------------------------------------
// protocol
// ---------------------------------------------------------------------------

describe('lsp protocol framing', () => {
  it('encodes with a byte-accurate Content-Length (UTF-8)', () => {
    const framed = encodeMessage({ a: 'é' }); // 'é' is 2 bytes
    const header = framed.slice(0, framed.indexOf('\r\n\r\n'));
    const body = framed.slice(framed.indexOf('\r\n\r\n') + 4);
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
    expect(JSON.parse(body)).toEqual({ a: 'é' });
  });

  it('parses a single message', () => {
    const p = createMessageParser();
    const out = p.push(encodeMessage({ id: 1, result: 'ok' }));
    expect(out).toEqual([{ id: 1, result: 'ok' }]);
  });

  it('parses a message split across chunks', () => {
    const p = createMessageParser();
    const framed = encodeMessage({ id: 2, result: 'split' });
    const mid = Math.floor(framed.length / 2);
    expect(p.push(framed.slice(0, mid))).toEqual([]);
    expect(p.push(framed.slice(mid))).toEqual([{ id: 2, result: 'split' }]);
  });

  it('parses multiple messages in one chunk', () => {
    const p = createMessageParser();
    const combined = encodeMessage({ id: 1 }) + encodeMessage({ id: 2 });
    expect(p.push(combined)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('round-trips path ↔ uri (incl. spaces)', () => {
    const p = '/home/user/my project/a.ts';
    expect(uriToPath(pathToUri(p))).toBe(p);
    expect(pathToUri(p).startsWith('file://')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

function makeFakeTransport() {
  let dataCb: (c: string) => void = () => {};
  let closeCb: () => void = () => {};
  const sent: string[] = [];
  const transport: LspTransport = {
    send: (d) => sent.push(d),
    onData: (cb) => { dataCb = cb; },
    onClose: (cb) => { closeCb = cb; },
    dispose: () => {},
  };
  const decode = (framed: string) => JSON.parse(framed.slice(framed.indexOf('\r\n\r\n') + 4));
  return {
    transport,
    lastSent: () => decode(sent[sent.length - 1]),
    sentCount: () => sent.length,
    emit: (msg: unknown) => dataCb(encodeMessage(msg)),
    close: () => closeCb(),
  };
}

describe('LspClient', () => {
  it('resolves a request when the matching response arrives', async () => {
    const fake = makeFakeTransport();
    const client = new LspClient(fake.transport);
    const p = client.request('textDocument/hover', { x: 1 });
    const req = fake.lastSent();
    expect(req.method).toBe('textDocument/hover');
    fake.emit({ jsonrpc: '2.0', id: req.id, result: { contents: 'hi' } });
    await expect(p).resolves.toEqual({ contents: 'hi' });
  });

  it('rejects on a JSON-RPC error response', async () => {
    const fake = makeFakeTransport();
    const client = new LspClient(fake.transport);
    const p = client.request('m');
    fake.emit({ jsonrpc: '2.0', id: fake.lastSent().id, error: { code: -32601, message: 'nope' } });
    await expect(p).rejects.toThrow(/nope/);
  });

  it('replies to a server→client request so the server does not stall', () => {
    const fake = makeFakeTransport();
    // eslint-disable-next-line no-new
    new LspClient(fake.transport);
    fake.emit({ jsonrpc: '2.0', id: 99, method: 'workspace/configuration', params: {} });
    expect(fake.lastSent()).toMatchObject({ id: 99, result: null });
  });

  it('rejects pending requests when the transport closes', async () => {
    const fake = makeFakeTransport();
    const client = new LspClient(fake.transport);
    const p = client.request('m');
    fake.close();
    await expect(p).rejects.toThrow(/closed/);
  });
});

// ---------------------------------------------------------------------------
// normalizers
// ---------------------------------------------------------------------------

describe('lsp response normalizers', () => {
  it('normalizeLocations handles Location, array, and LocationLink', () => {
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
    expect(normalizeLocations({ uri: 'file:///a', range })).toHaveLength(1);
    expect(normalizeLocations([{ uri: 'file:///a', range }, { uri: 'file:///b', range }])).toHaveLength(2);
    expect(normalizeLocations({ targetUri: 'file:///c', targetRange: range })[0].uri).toBe('file:///c');
    expect(normalizeLocations(null)).toEqual([]);
  });

  it('extractHoverText handles string, MarkupContent, and arrays', () => {
    expect(extractHoverText({ contents: 'plain' })).toBe('plain');
    expect(extractHoverText({ contents: { value: '```ts\nx: number\n```' } })).toContain('x: number');
    expect(extractHoverText({ contents: ['a', { value: 'b' }] })).toBe('a\nb');
    expect(extractHoverText({ contents: '' })).toBeNull();
    expect(extractHoverText(null)).toBeNull();
  });

  it('normalizeSymbols flattens nested children and maps kinds', () => {
    const symbols = normalizeSymbols([
      {
        name: 'MyClass',
        kind: 5,
        range: { start: { line: 0 } },
        children: [{ name: 'method', kind: 6, range: { start: { line: 3 } } }],
      },
    ]);
    expect(symbols).toEqual([
      { name: 'MyClass', kind: 'Class', line: 1 },
      { name: 'method', kind: 'Method', line: 4 },
    ]);
  });

  it('normalizeRename counts edits from changes and documentChanges', () => {
    const fromChanges = normalizeRename({ changes: { 'file:///a.ts': [{}, {}], 'file:///b.ts': [{}] } });
    expect(fromChanges?.totalEdits).toBe(3);
    expect(fromChanges?.files).toHaveLength(2);
    const fromDocChanges = normalizeRename({
      documentChanges: [{ textDocument: { uri: 'file:///a.ts' }, edits: [{}, {}, {}] }],
    });
    expect(fromDocChanges?.totalEdits).toBe(3);
    expect(normalizeRename(null)).toBeNull();
    expect(normalizeRename({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tools (fake provider)
// ---------------------------------------------------------------------------

function fakeProvider(over: Partial<LspProvider> = {}): LspProvider & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async definition(file, line, character) {
      calls.push({ op: 'definition', file, line, character });
      return [{ uri: 'file:///repo/src/target.ts', range: { start: { line: 9, character: 4 }, end: { line: 9, character: 8 } } }];
    },
    async references() {
      return [
        { uri: 'file:///repo/src/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        { uri: 'file:///repo/src/b.ts', range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } } },
      ];
    },
    async hover() { return 'const x: number'; },
    async documentSymbols() { return [{ name: 'foo', kind: 'Function', line: 12 }]; },
    async rename() { return { files: [{ file: '/repo/src/a.ts', count: 2 }], totalEdits: 2 }; },
    dispose() {},
    ...over,
  };
}

describe('lsp tools', () => {
  const tools = (p: LspProvider) => {
    const map = new Map(createLspTools(p, '/repo').map((t) => [t.name, t]));
    return map;
  };
  const ctx = { signal: new AbortController().signal, cwd: '/repo', audit: () => {}, sessionId: 't' };

  it('go_to_definition converts 1-based position to 0-based and formats the target', async () => {
    const p = fakeProvider();
    const res = await tools(p).get('go_to_definition')!.execute({ path: 'src/a.ts', line: 5, column: 3 }, ctx);
    expect(p.calls[0]).toEqual({ op: 'definition', file: 'src/a.ts', line: 4, character: 2 });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { definitions: string[] }).definitions[0]).toBe('src/target.ts:10:5');
  });

  it('find_references lists all references relative to root', async () => {
    const res = await tools(fakeProvider()).get('find_references')!.execute({ path: 'src/a.ts', line: 1, column: 1 }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as { references: string[]; count: number };
      expect(v.count).toBe(2);
      expect(v.references).toContain('src/a.ts:1:1');
    }
  });

  it('rename_symbol previews the blast radius without writing', async () => {
    const res = await tools(fakeProvider()).get('rename_symbol')!.execute(
      { path: 'src/a.ts', line: 1, column: 1, newName: 'bar' }, ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as { totalEdits: number; files: string[] };
      expect(v.totalEdits).toBe(2);
      expect(v.files[0]).toMatch(/src\/a\.ts \(2 edits\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// registry wiring
// ---------------------------------------------------------------------------

describe('lsp tools in the registry', () => {
  it('are registered in the full registry (with an injected provider)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lsp-reg-'));
    try {
      const { tools } = createBuiltinToolRegistry({ root, lspProvider: fakeProvider() });
      const names = tools.map((t) => t.name);
      expect(names).toContain('go_to_definition');
      expect(names).toContain('find_references');
      expect(names).toContain('rename_symbol');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('are omitted when lspProvider is null (disabled)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lsp-off-'));
    try {
      const { tools } = createBuiltinToolRegistry({ root, lspProvider: null });
      expect(tools.map((t) => t.name)).not.toContain('go_to_definition');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('are omitted from a read-only (sub-agent) registry', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lsp-ro-'));
    try {
      const { tools } = createBuiltinToolRegistry({ root, readOnly: true, lspProvider: fakeProvider() });
      expect(tools.map((t) => t.name)).not.toContain('go_to_definition');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// manager: spawn-failure handling (regression for ENOENT process crash)
// ---------------------------------------------------------------------------

// A stand-in for a child_process the manager can drive. It mimics a missing
// binary by emitting 'error' { code: 'ENOENT' } on the next microtask — exactly
// how node behaves when spawn() can't find the command on PATH.
function makeMissingBinaryChild(): EventEmitter {
  const child = new EventEmitter();
  (child as { stdin?: unknown }).stdin = { writable: true, write: () => true };
  (child as { stdout?: unknown }).stdout = new EventEmitter();
  (child as { kill: () => void }).kill = () => {};
  queueMicrotask(() => {
    const err = Object.assign(new Error('spawn typescript-language-server ENOENT'), {
      code: 'ENOENT',
      errno: -4058,
      syscall: 'spawn typescript-language-server',
      path: 'typescript-language-server',
      spawnargs: ['--stdio'],
    });
    child.emit('error', err);
  });
  return child;
}

describe('LspManager spawn-failure handling', () => {
  it('degrades to empty results when the server binary is missing (no process crash)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lsp-enoent-'));
    // A .ts file is required so resolveServerCommand maps it to the TS server.
    const file = path.join(root, 'a.ts');
    writeFileSync(file, 'export const x = 1;\n');
    const warnings: string[] = [];
    let spawnCalls = 0;
    try {
      const manager = new LspManager({
        cwd: root,
        onWarn: (m) => warnings.push(m),
        spawnImpl: () => {
          spawnCalls++;
          return makeMissingBinaryChild() as never;
        },
      });

      // First call: spawns, the 'error' event fires, tool must return its
      // fallback instead of crashing the process with an unhandled 'error'.
      await expect(manager.definition(file, 1, 1)).resolves.toEqual([]);
      await expect(manager.documentSymbols(file)).resolves.toEqual([]);
      await expect(manager.hover(file, 1, 1)).resolves.toBeNull();

      // A single warning was surfaced, once per language.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/typescript-language-server/);
      expect(warnings[0]).toMatch(/ENOENT|PATH/);

      // Second call: cached as unavailable — no second spawn attempt.
      const callsBefore = spawnCalls;
      await expect(manager.references(file, 1, 1)).resolves.toEqual([]);
      expect(spawnCalls).toBe(callsBefore);
      expect(warnings).toHaveLength(1); // still only one warning
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
