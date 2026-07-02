/**
 * cli-toolFormat.test.ts — v0.7.1 pure-function tests for the tool formatters
 * (plan B1+B2).
 *
 * Pins the contracts that kill the v0.7.0 rendering problems:
 *   - raw JSON envelopes with escaped `\n` → real stdout lines for bash
 *   - raw-JSON args summary → human-readable per-tool summary
 *   - 600-char mid-string cut → line-based truncation with `… (+K lines)`
 *   - write_file/edit_file success → one-line inline result (no box)
 */
import { describe, it, expect } from 'vitest';
import { formatToolResult, formatToolSummary } from '../../src/cli/components/toolFormat.js';

describe('formatToolResult (B1) — per-tool body formatting', () => {
  it('bash: extracts real stdout lines (no escaped \\n), appends stderr + exit when present', () => {
    const result = JSON.stringify({
      stdout: 'line1\nline2\nline3',
      stderr: '',
      exitCode: 0,
    });
    const out = formatToolResult('bash', result);
    expect(out.lines).toEqual(['line1', 'line2', 'line3']);
    expect(out.meta).toBeUndefined();
    expect(out.oneLine).not.toBe(true);
  });

  it('bash: surfaces non-zero exit + stderr in meta', () => {
    const result = JSON.stringify({ stdout: 'ok', stderr: 'oops', exitCode: 2 });
    const out = formatToolResult('bash', result);
    expect(out.lines).toEqual(['ok']);
    expect(out.meta).toMatch(/stderr: oops/);
    expect(out.meta).toMatch(/exit 2/);
  });

  it('read_file: uses the content field with real newlines', () => {
    const result = JSON.stringify({ path: '/a/b.txt', content: 'alpha\nbeta', sizeBytes: 10 });
    const out = formatToolResult('read_file', result);
    expect(out.lines).toEqual(['alpha', 'beta']);
  });

  it('write_file: success is a single one-line result (no box)', () => {
    const path = require('node:path');
    const abs = path.join(process.cwd(), 'foo.txt');
    const result = JSON.stringify({ path: abs, bytesWritten: 106496 });
    const out = formatToolResult('write_file', result);
    expect(out.oneLine).toBe(true);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/wrote .+ → /);
    // Path is made relative to cwd when possible.
    expect(out.lines[0]).toContain('foo.txt');
  });

  it('edit_file: success reports occurrences replaced, one-line', () => {
    const path = require('node:path');
    const abs = path.join(process.cwd(), 'bar.ts');
    const result = JSON.stringify({ path: abs, occurrencesReplaced: 3 });
    const out = formatToolResult('edit_file', result);
    expect(out.oneLine).toBe(true);
    expect(out.lines[0]).toMatch(/replaced 3 occurrence/);
  });

  it('list_files: shows entry count + first ~10 names', () => {
    const path = require('node:path');
    const dir = path.join(process.cwd());
    const result = JSON.stringify({
      dir,
      entries: [
        { name: 'a.ts', type: 'file' },
        { name: 'b.ts', type: 'file' },
      ],
      truncated: false,
    });
    const out = formatToolResult('list_files', result);
    expect(out.lines).toEqual(['a.ts', 'b.ts']);
    expect(out.meta).toMatch(/2 entries/);
  });

  it('truncates by LINES with a … (+K lines) tail, not mid-string', () => {
    const many = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const result = JSON.stringify({ stdout: many, stderr: '', exitCode: 0 });
    const out = formatToolResult('bash', result);
    // Default cap is 8 lines → 8 kept + 1 marker.
    expect(out.lines.length).toBe(9);
    expect(out.lines[out.lines.length - 1]).toMatch(/\(\+22 lines\)/);
    // No mid-string split of a JSON value.
    expect(out.lines.some((l) => l.includes('"'))).toBe(false);
  });

  it('falls back to plain text for unparseable / unknown tool results', () => {
    const out = formatToolResult('unknown_tool', 'just a plain string\nsecond line');
    expect(out.lines).toEqual(['just a plain string', 'second line']);
  });

  it('grep/search: renders match count + entries', () => {
    const result = JSON.stringify({ matches: ['src/a.ts:1:foo', 'src/b.ts:4:foo'] });
    const out = formatToolResult('grep_content', result);
    expect(out.lines).toEqual(['src/a.ts:1:foo', 'src/b.ts:4:foo']);
    expect(out.meta).toMatch(/2 match/);
  });
});

describe('formatToolSummary (B2) — per-tool summary line', () => {
  it('bash: the command string', () => {
    expect(formatToolSummary('bash', { command: 'npm test' })).toBe('npm test');
  });

  it('read_file: path relative to cwd when under cwd', () => {
    // Use a path joined from process.cwd() so it is genuinely relative on
    // every platform (the tools build paths via path.join(cwd, ...) too).
    const path = require('node:path');
    const abs = path.join(process.cwd(), 'package.json');
    const s = formatToolSummary('read_file', { path: abs });
    expect(s).toBe('package.json');
  });

  it('write_file: the path', () => {
    const path = require('node:path');
    const abs = path.join(process.cwd(), 'src', 'x.ts');
    const s = formatToolSummary('write_file', { path: abs });
    expect(s).toContain('x.ts');
  });

  it('list_files: dir + depth', () => {
    const path = require('node:path');
    const abs = path.join(process.cwd(), 'src');
    const s = formatToolSummary('list_files', { dir: abs, maxDepth: 2 });
    expect(s).toContain('src');
    expect(s).toMatch(/depth 2/);
  });

  it('grep_content: pattern + path', () => {
    const path = require('node:path');
    const abs = path.join(process.cwd(), 'src');
    const s = formatToolSummary('grep_content', { pattern: 'TODO', path: abs });
    expect(s).toMatch(/^TODO/);
    expect(s).toContain('src');
  });

  it('truncates at maxWidth with a single trailing … (no mid-token JSON cut)', () => {
    const long = { command: 'x'.repeat(200) };
    const s = formatToolSummary('bash', long, 40);
    expect(s.length).toBe(40);
    expect(s.endsWith('…')).toBe(true);
  });

  it('falls back to compact JSON for unknown tools, capped at width', () => {
    const s = formatToolSummary('mystery_tool', { a: 1, b: 2 }, 50);
    expect(s.length).toBeLessThanOrEqual(50);
    expect(s.startsWith('{')).toBe(true);
  });
});
