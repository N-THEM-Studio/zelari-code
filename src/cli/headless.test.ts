/**
 * parseHeadlessFlags tests — --task-file / --kraken-graph-file slices.
 *
 * Covers the Windows argv-cap workaround (os error 206): the desktop
 * spills long prompts to a temp file and the CLI must read the task
 * from it exactly like the inline --task flag.
 *
 * @since v1.44.0
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHeadlessFlags } from './headless.js';

const dirs: string[] = [];

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelari-headless-test-'));
  dirs.push(dir);
  const p = join(dir, 'task.txt');
  writeFileSync(p, content, 'utf-8');
  return p;
}

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('parseHeadlessFlags --task-file', () => {
  it('reads the task prompt from a file (argv-cap workaround)', () => {
    const p = tmpFile('Refactor the workspace plan store and verify tests');
    const res = parseHeadlessFlags(['--headless', '--task-file', p]);
    expect(res.options).not.toBeNull();
    expect(res.options?.task).toBe(
      'Refactor the workspace plan store and verify tests',
    );
    expect(res.error).toBeUndefined();
  });

  it('inline --task wins over a previous --task-file (last flag wins)', () => {
    const p = tmpFile('from file');
    const res = parseHeadlessFlags([
      '--headless',
      '--task-file',
      p,
      '--task',
      'inline wins',
    ]);
    expect(res.options?.task).toBe('inline wins');
  });

  it('missing file leaves task undefined → clear validation error', () => {
    const res = parseHeadlessFlags([
      '--headless',
      '--task-file',
      'Z:/definitely/not/here/task.txt',
    ]);
    expect(res.options).toBeNull();
    expect(res.error).toMatch(/requires --task/);
  });

  it('empty file also degrades to the validation error', () => {
    const p = tmpFile('   ');
    const res = parseHeadlessFlags(['--headless', '--task-file', p]);
    expect(res.options).toBeNull();
    expect(res.error).toMatch(/requires --task/);
  });

  it('still mutually exclusive with --kraken-graph', () => {
    const p = tmpFile('do the graph thing');
    const res = parseHeadlessFlags([
      '--headless',
      '--task-file',
      p,
      '--kraken-graph',
      'goal',
    ]);
    expect(res.options).toBeNull();
    expect(res.error).toMatch(/mutually exclusive/);
  });
});

describe('parseHeadlessFlags --kraken-graph-file', () => {
  it('reads the graph goal from a file', () => {
    const p = tmpFile('Plan + execute the release DAG');
    const res = parseHeadlessFlags(['--headless', '--kraken-graph-file', p]);
    expect(res.options).not.toBeNull();
    expect(res.options?.krakenGraph).toBe('Plan + execute the release DAG');
  });

  it('inline --kraken-graph wins over a previous --kraken-graph-file', () => {
    const p = tmpFile('from file');
    const res = parseHeadlessFlags([
      '--headless',
      '--kraken-graph-file',
      p,
      '--kraken-graph',
      'inline goal',
    ]);
    expect(res.options?.krakenGraph).toBe('inline goal');
  });

  it('mutually exclusive with --task-file as well', () => {
    const a = tmpFile('task a');
    const b = tmpFile('graph b');
    const res = parseHeadlessFlags([
      '--headless',
      '--task-file',
      a,
      '--kraken-graph-file',
      b,
    ]);
    expect(res.options).toBeNull();
    expect(res.error).toMatch(/mutually exclusive/);
  });
});
