/**
 * core-observationCompactor.test.ts — S2: in-place compaction contract.
 *
 * `compactToolResult` is the extracted truncation mechanism (see
 * packages/core/src/core/tools/observationCompactor.ts). It must mutate the
 * result in place and return the SAME reference, leave errors untouched, and
 * never write to disk when spill:false.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactToolResult } from '@zelari/core/harness/tools/registry';
import type { TypedResult } from '@zelari/core/harness/tools/toolTypes';

function bigText(lines = 500): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n');
}

describe('compactToolResult', () => {
  const realEnv = { ...process.env };
  let spillDir: string;

  beforeEach(() => {
    process.env = { ...realEnv };
    spillDir = mkdtempSync(join(tmpdir(), 'zelari-compact-'));
    process.env.ZELARI_TOOL_OUTPUT_DIR = spillDir;
    process.env.ZELARI_TOOL_SPILL = '1';
  });

  afterEach(() => {
    process.env = { ...realEnv };
    try {
      rmSync(spillDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('truncates a string value in place and returns the same reference', () => {
    const original = bigText(500);
    const result: TypedResult<string> = { ok: true, value: original };
    const out = compactToolResult(result, { cap: 50, spill: false });
    expect(out).toBe(result); // same reference
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).not.toBe(original);
      expect(out.value).toMatch(/lines omitted/);
    }
  });

  it('truncates object.content in place on the SAME object reference', () => {
    const value = { content: bigText(500), other: 'keep' };
    const result: TypedResult<{ content: string; other: string }> = { ok: true, value };
    const out = compactToolResult(result, { cap: 50, spill: false });
    expect(out).toBe(result); // same outer reference
    if (out.ok) {
      expect(out.value).toBe(value); // same inner object (no spread/clone)
      expect(out.value.other).toBe('keep');
      expect(out.value.content).toMatch(/lines omitted/);
    }
  });

  it('returns an error result as-is (value never touched)', () => {
    const result: TypedResult<string> = { ok: false, error: 'boom' };
    const out = compactToolResult(result, { spill: false });
    expect(out).toBe(result);
    expect(out).toEqual({ ok: false, error: 'boom' });
  });

  it('passes small payloads through verbatim (same reference, unchanged)', () => {
    const result: TypedResult<string> = { ok: true, value: 'short' };
    const out = compactToolResult(result, { spill: false });
    expect(out).toBe(result);
    if (out.ok) expect(out.value).toBe('short');
  });

  it('spill:false never writes files to the managed dir', () => {
    const result: TypedResult<string> = { ok: true, value: bigText(500) };
    compactToolResult(result, { cap: 50, spill: false });
    expect(readdirSync(spillDir)).toEqual([]);
  });

  it('spill defaults to true and writes the full text to the managed dir', () => {
    const text = bigText(500);
    const result: TypedResult<string> = { ok: true, value: text };
    const out = compactToolResult(result, { cap: 50, toolName: 'read_file' });
    if (out.ok) expect(out.value).toMatch(/full output spilled to:/);
    expect(readdirSync(spillDir).length).toBe(1);
  });

  it('does not throw and returns the same reference on an error-shaped result', () => {
    const result = { ok: false, error: 'x', meta: { status: 'failed' } } as TypedResult<never>;
    let out: TypedResult<never>;
    expect(() => {
      out = compactToolResult(result, { spill: false });
    }).not.toThrow();
    expect(out!).toBe(result);
  });
});
