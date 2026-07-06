import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseEslintJson,
  parseRuffJson,
  providerForFile,
  resolveBin,
  formatDiagnostics,
  runDiagnosticsForFile,
  type Runner,
  type Diagnostic,
} from '../../src/cli/diagnostics/engine.js';
import { mkdirSync } from 'node:fs';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('parseEslintJson', () => {
  it('extracts errors + warnings with severity mapping', () => {
    const stdout = JSON.stringify([
      {
        filePath: '/repo/src/a.ts',
        messages: [
          { ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used", line: 3, column: 7 },
          { ruleId: 'eqeqeq', severity: 1, message: 'Expected ===', line: 10, column: 2 },
        ],
      },
    ]);
    const diags = parseEslintJson(stdout, '/repo/src/a.ts');
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({ severity: 'error', line: 3, column: 7, code: 'no-unused-vars', source: 'eslint' });
    expect(diags[1]).toMatchObject({ severity: 'warning', line: 10, code: 'eqeqeq' });
  });

  it('returns [] for empty / non-JSON / no-messages', () => {
    expect(parseEslintJson('', 'x.ts')).toEqual([]);
    expect(parseEslintJson('not json', 'x.ts')).toEqual([]);
    expect(parseEslintJson(JSON.stringify([{ filePath: 'x.ts', messages: [] }]), 'x.ts')).toEqual([]);
  });
});

describe('parseRuffJson', () => {
  it('maps E999 to error and other codes to warning', () => {
    const stdout = JSON.stringify([
      { filename: 'm.py', code: 'F401', message: 'imported but unused', location: { row: 1, column: 8 } },
      { filename: 'm.py', code: 'E999', message: 'SyntaxError', location: { row: 5, column: 1 } },
    ]);
    const diags = parseRuffJson(stdout, 'm.py');
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({ severity: 'warning', code: 'F401', line: 1, source: 'ruff' });
    expect(diags[1]).toMatchObject({ severity: 'error', code: 'E999', line: 5 });
  });

  it('returns [] for empty / malformed', () => {
    expect(parseRuffJson('', 'm.py')).toEqual([]);
    expect(parseRuffJson('{}', 'm.py')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Selection + formatting
// ---------------------------------------------------------------------------

describe('providerForFile', () => {
  it('selects eslint for js/ts family and ruff for py', () => {
    expect(providerForFile('a.ts')?.name).toBe('eslint');
    expect(providerForFile('a.TSX')?.name).toBe('eslint');
    expect(providerForFile('a.py')?.name).toBe('ruff');
  });
  it('returns null for unsupported extensions', () => {
    expect(providerForFile('README.md')).toBeNull();
    expect(providerForFile('data.json')).toBeNull();
    expect(providerForFile('noext')).toBeNull();
  });
});

describe('resolveBin', () => {
  it('prefers project-local node_modules/.bin over PATH', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'resolvebin-'));
    try {
      const binDir = path.join(root, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(path.join(binDir, 'eslint'), '#!/bin/sh\n');
      expect(resolveBin('eslint', root)).toBe(path.join(binDir, 'eslint'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the bare name when no local bin exists', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'resolvebin-none-'));
    try {
      expect(resolveBin('ruff', root)).toBe('ruff');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('formatDiagnostics', () => {
  const mk = (over: Partial<Diagnostic>): Diagnostic => ({
    file: '/repo/a.ts', line: 1, severity: 'warning', message: 'm', source: 'eslint', ...over,
  });

  it('returns empty string for no diagnostics', () => {
    expect(formatDiagnostics([])).toBe('');
  });

  it('puts errors before warnings and includes a summary header', () => {
    const out = formatDiagnostics([
      mk({ severity: 'warning', line: 2, message: 'warn-a' }),
      mk({ severity: 'error', line: 9, message: 'err-b' }),
    ]);
    expect(out).toMatch(/2 diagnostics \(1 error, 1 warning\)/);
    expect(out.indexOf('err-b')).toBeLessThan(out.indexOf('warn-a'));
  });

  it('caps output and reports overflow', () => {
    const many = Array.from({ length: 25 }, (_, i) => mk({ line: i + 1, message: `m${i}` }));
    const out = formatDiagnostics(many, { maxLines: 20 });
    expect(out).toMatch(/… and 5 more/);
  });

  it('renders paths relative to a root when given', () => {
    const out = formatDiagnostics([mk({ file: '/repo/src/a.ts', line: 3, column: 4 })], { relativeTo: '/repo' });
    expect(out).toMatch(/src\/a\.ts:3:4/);
  });
});

// ---------------------------------------------------------------------------
// runDiagnosticsForFile (injected runner)
// ---------------------------------------------------------------------------

describe('runDiagnosticsForFile', () => {
  const eslintOut: Runner = async () => ({
    code: 1,
    stdout: JSON.stringify([{ filePath: '/x/a.ts', messages: [{ ruleId: 'r', severity: 2, message: 'boom', line: 1 }] }]),
    stderr: '',
  });

  it('runs the matching provider and parses output', async () => {
    const diags = await runDiagnosticsForFile('/x/a.ts', { runner: eslintOut });
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe('boom');
  });

  it('returns [] for unsupported file types without spawning', async () => {
    let called = false;
    const runner: Runner = async () => { called = true; return { code: 0, stdout: '', stderr: '' }; };
    expect(await runDiagnosticsForFile('notes.md', { runner })).toEqual([]);
    expect(called).toBe(false);
  });

  it('returns [] when the runner throws (missing binary)', async () => {
    const runner: Runner = async () => { throw new Error('ENOENT'); };
    expect(await runDiagnosticsForFile('a.ts', { runner })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full loop: edit tool → diagnostics appended to result (via registry)
// ---------------------------------------------------------------------------

describe('post-edit diagnostics loop (write_file)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'diag-loop-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('appends compiler diagnostics to a successful edit of a supported file', async () => {
    const runner: Runner = async (_cmd, _args) => ({
      code: 1,
      stdout: JSON.stringify([
        { filePath: path.join(root, 'a.ts'), messages: [{ ruleId: 'no-unused-vars', severity: 2, message: "'y' unused", line: 1, column: 7 }] },
      ]),
      stderr: '',
    });
    const { registry } = createBuiltinToolRegistry({ root, diagnostics: true, diagnosticsRunner: runner });
    const res = await registry.invoke<{ path: string; diagnostics?: string }>('write_file', {
      path: 'a.ts',
      content: 'const y = 1;\n',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.diagnostics).toMatch(/no-unused-vars/);
      expect(res.value.diagnostics).toMatch(/1 error/);
    }
    // The file was still written.
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toContain('const y');
  });

  it('does not append a diagnostics field when the checker is clean', async () => {
    const runner: Runner = async () => ({ code: 0, stdout: '[]', stderr: '' });
    const { registry } = createBuiltinToolRegistry({ root, diagnostics: true, diagnosticsRunner: runner });
    const res = await registry.invoke<{ path: string; diagnostics?: string }>('write_file', {
      path: 'clean.ts', content: 'export const ok = 1;\n',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.diagnostics).toBeUndefined();
  });

  it('does not append diagnostics for unsupported file types', async () => {
    let called = false;
    const runner: Runner = async () => { called = true; return { code: 0, stdout: '', stderr: '' }; };
    const { registry } = createBuiltinToolRegistry({ root, diagnostics: true, diagnosticsRunner: runner });
    const res = await registry.invoke<{ path: string; diagnostics?: string }>('write_file', {
      path: 'notes.md', content: '# hi\n',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.diagnostics).toBeUndefined();
    expect(called).toBe(false);
  });

  it('leaves results untouched when diagnostics are disabled', async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: JSON.stringify([{ filePath: path.join(root, 'a.ts'), messages: [{ ruleId: 'r', severity: 2, message: 'x', line: 1 }] }]),
      stderr: '',
    });
    const { registry } = createBuiltinToolRegistry({ root, diagnostics: false, diagnosticsRunner: runner });
    const res = await registry.invoke<{ path: string; diagnostics?: string }>('write_file', {
      path: 'a.ts', content: 'const y = 1;\n',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.diagnostics).toBeUndefined();
  });
});
