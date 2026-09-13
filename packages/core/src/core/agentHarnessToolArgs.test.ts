import { describe, expect, it } from 'vitest';
import { parseMinimaxStyleToolCalls } from './AgentHarness.js';

/**
 * t103 contract: direct tool calls must deliver native JSON values.
 * Well-formed <parameter> bodies keep string[] as string[] instead of being
 * flattened to a display string that downstream comma-splitting mangles.
 */
describe('parseMinimaxStyleToolCalls — JSON-ish parameter values (t103)', () => {
  it('keeps string[] values native in well-formed <parameter> tags', () => {
    const [call] = parseMinimaxStyleToolCalls(
      '<invoke name="grep_content"><parameter name="exclude">["node_modules", "dist"]</parameter>' +
        '<parameter name="pattern">foo</parameter></invoke>',
    );
    expect(call?.name).toBe('grep_content');
    expect(call?.args.exclude).toEqual(['node_modules', 'dist']);
    expect(call?.args.pattern).toBe('foo');
  });

  it('parses JSON object parameter values', () => {
    const [call] = parseMinimaxStyleToolCalls(
      '<invoke name="t"><parameter name="opts">{"a": 1}</parameter></invoke>',
    );
    expect(call?.args.opts).toEqual({ a: 1 });
  });

  it('repairs a display-truncated array value (single missing bracket)', () => {
    const [call] = parseMinimaxStyleToolCalls(
      '<invoke name="t"><parameter name="include">["*.ts", "*.tsx"</parameter></invoke>',
    );
    expect(call?.args.include).toEqual(['*.ts', '*.tsx']);
  });

  it('keeps legacy scalar unquoting for plain values', () => {
    const [call] = parseMinimaxStyleToolCalls(
      '<invoke name="t"><parameter name="path">src/cli</parameter></invoke>',
    );
    expect(call?.args.path).toBe('src/cli');
  });

  it('parameter bodies no longer leak garbage keys into the loose parse', () => {
    const [call] = parseMinimaxStyleToolCalls(
      '<invoke name="t"><parameter name="body">foo: bar\nbaz: qux</parameter>' +
        '<parameter name="title">x</parameter></invoke>',
    );
    const args = call?.args ?? {};
    expect(args.body).toBe('foo: bar\nbaz: qux');
    expect(args.foo).toBeUndefined();
    expect(args.baz).toBeUndefined();
    expect(args.title).toBe('x');
  });

  it('still parses bare <k>v</k> fragments via the loose path', () => {
    const [call] = parseMinimaxStyleToolCalls(
      '<invoke name="t"><path>src/cli</path></invoke>',
    );
    expect(call?.name).toBe('t');
    expect(call?.args.path).toBe('src/cli');
  });
});
