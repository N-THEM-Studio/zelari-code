/**
 * headless-flags.test.ts — pure-logic tests for parseHeadlessFlags.
 *
 * Covers CLI flag parsing for `zelari-code --headless --task X [...]`.
 * No fs, no env, no React. Tests run in <50ms.
 *
 * @since 0.5.0
 */
import { describe, it, expect } from 'vitest';
import { parseHeadlessFlags } from '../../src/cli/headless.js';

describe('parseHeadlessFlags', () => {
  it('returns null options when --headless is absent', () => {
    const r = parseHeadlessFlags(['--task', 'hello']);
    expect(r.options).toBeNull();
    expect(r.error).toBeUndefined();
  });

  it('returns null options for empty argv', () => {
    expect(parseHeadlessFlags([]).options).toBeNull();
  });

  it('parses the minimal --headless --task X invocation', () => {
    const r = parseHeadlessFlags(['--headless', '--task', 'add tests']);
    expect(r.error).toBeUndefined();
    expect(r.options).toEqual({
      task: 'add tests',
      output: 'json',
      useCouncil: false,
      provider: undefined,
      model: undefined,
    });
  });

  it('errors when --task is missing', () => {
    const r = parseHeadlessFlags(['--headless']);
    expect(r.options).toBeNull();
    expect(r.error).toMatch(/--headless requires --task/);
  });

  it('errors when --task is empty/whitespace', () => {
    expect(parseHeadlessFlags(['--headless', '--task', '']).error).toBeDefined();
    expect(parseHeadlessFlags(['--headless', '--task', '   ']).error).toBeDefined();
  });

  it('parses --output json and plain', () => {
    expect(parseHeadlessFlags(['--headless', '--task', 'x', '--output', 'json']).options?.output)
      .toBe('json');
    expect(parseHeadlessFlags(['--headless', '--task', 'x', '--output', 'plain']).options?.output)
      .toBe('plain');
  });

  it('errors on invalid --output value', () => {
    const r = parseHeadlessFlags(['--headless', '--task', 'x', '--output', 'yaml']);
    expect(r.options).toBeNull();
    expect(r.error).toMatch(/--output requires 'json' or 'plain'/);
  });

  it('errors on missing --output value', () => {
    const r = parseHeadlessFlags(['--headless', '--task', 'x', '--output']);
    expect(r.error).toMatch(/--output requires 'json' or 'plain'/);
  });

  it('parses --council flag', () => {
    const r = parseHeadlessFlags(['--headless', '--task', 'x', '--council']);
    expect(r.options?.useCouncil).toBe(true);
  });

  it('parses --provider and --model', () => {
    const r = parseHeadlessFlags([
      '--headless', '--task', 'x', '--provider', 'minimax', '--model', 'MiniMax-M3',
    ]);
    expect(r.options?.provider).toBe('minimax');
    expect(r.options?.model).toBe('MiniMax-M3');
  });

  it('handles flags in any order', () => {
    const r = parseHeadlessFlags([
      '--provider', 'glm', '--headless', '--council', '--task', 'audit', '--output', 'plain',
    ]);
    expect(r.error).toBeUndefined();
    expect(r.options).toEqual({
      task: 'audit',
      output: 'plain',
      useCouncil: true,
      provider: 'glm',
      model: undefined,
    });
  });

  it('captures task with embedded spaces (single argv token)', () => {
    // shell-style: --task "fix the bug" arrives as one argv element
    const r = parseHeadlessFlags(['--headless', '--task', 'fix the bug in auth.ts']);
    expect(r.options?.task).toBe('fix the bug in auth.ts');
  });
});
