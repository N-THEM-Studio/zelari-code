import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToolResultForModel, stripAnsi } from './toolResultRender.js';

let spillDir = '';
beforeEach(() => {
  spillDir = mkdtempSync(join(tmpdir(), 'zelari-render-'));
});
afterEach(() => {
  rmSync(spillDir, { recursive: true, force: true });
});

const env = {};

describe('renderToolResultForModel — structure', () => {
  it('compacts structured results (no indentation)', () => {
    const value = { matches: [{ file: 'a.ts', line: 3, text: 'x' }], filesWalked: 12 };
    const pretty = JSON.stringify(value, null, 2);
    const out = renderToolResultForModel(pretty, { toolName: 'grep_content', env, spillDir });
    expect(out).toBe(JSON.stringify(value));
    expect(out.length).toBeLessThan(pretty.length);
  });

  it('renders long text fields verbatim under their own line, without JSON escaping', () => {
    const stdout = 'line "one"\n'.repeat(40);
    const pretty = JSON.stringify({ exitCode: 0, stdout, stderr: '', durationMs: 5 }, null, 2);
    const out = renderToolResultForModel(pretty, { toolName: 'bash', env, spillDir });
    expect(out.split('\n')[0]).toBe('{"exitCode":0,"stderr":"","durationMs":5}');
    expect(out).toContain('--- stdout ---\nline "one"\nline "one"');
    expect(out).not.toContain('\\n');
    expect(out).not.toContain('\\"');
  });

  it('strips terminal colors from text and from long fields', () => {
    expect(stripAnsi('\u001b[31;1merror\u001b[0m done')).toBe('error done');
    const pretty = JSON.stringify({ stdout: `\u001b[32mok\u001b[0m ${'x'.repeat(300)}` }, null, 2);
    expect(renderToolResultForModel(pretty, { toolName: 'bash', env, spillDir })).not.toContain('\u001b');
  });

  it('leaves plain text alone', () => {
    expect(renderToolResultForModel('Tool "task" aborted', { env, spillDir })).toBe('Tool "task" aborted');
  });

  it('ZELARI_TOOL_RESULT_FORMAT=json returns the harness string unchanged', () => {
    const pretty = JSON.stringify({ a: 1, b: [1, 2] }, null, 2);
    expect(renderToolResultForModel(pretty, { env: { ZELARI_TOOL_RESULT_FORMAT: 'json' }, spillDir })).toBe(pretty);
  });
});

describe('renderToolResultForModel — size cap', () => {
  const big = 'log line\n'.repeat(3000); // 27,000 chars

  it('caps large outputs to a head + tail window and spills the full text once', () => {
    const out = renderToolResultForModel(big, { toolName: 'bash', env, spillDir, maxChars: 1000 });
    expect(out.length).toBeLessThan(1200);
    const marker = out.split('\n').find((l) => l.startsWith('...'))!;
    expect(marker).toMatch(/^\.\.\.\d+ chars omitted; complete output in /);
    const path = marker.replace(/^.*complete output in /, '');
    expect(readFileSync(path, 'utf8')).toBe(big);
  });

  it('is deterministic: same output, same bytes, same spill file (cache-stable)', () => {
    const a = renderToolResultForModel(big, { toolName: 'bash', env, spillDir, maxChars: 1000 });
    const b = renderToolResultForModel(big, { toolName: 'bash', env, spillDir, maxChars: 1000 });
    expect(a).toBe(b);
    expect(readdirSync(spillDir)).toHaveLength(1);
  });

  it('does not cap read_file or task reports, nor anything when the cap is 0', () => {
    for (const toolName of ['read_file', 'task']) {
      expect(renderToolResultForModel(big, { toolName, env, spillDir, maxChars: 1000 })).toBe(big);
    }
    expect(renderToolResultForModel(big, { toolName: 'bash', env, spillDir, maxChars: 0 })).toBe(big);
  });

  it('defaults to 12,000 chars, tunable through ZELARI_TOOL_RESULT_MODEL_CHARS', () => {
    expect(renderToolResultForModel(big, { toolName: 'bash', env, spillDir }).length).toBeLessThan(12_200);
    const wider = renderToolResultForModel(big, {
      toolName: 'bash',
      env: { ZELARI_TOOL_RESULT_MODEL_CHARS: '30000' },
      spillDir,
    });
    expect(wider).toBe(big);
  });
});
