import { describe, it, expect } from 'vitest';
import { classifyToolColor } from '../../src/cli/components/ToolOutput.js';

/**
 * Migrated from cli-collapsibleToolOutput.test.ts (v0.7.2 cleanup): the
 * `classifyToolColor` helper now lives in ToolOutput.tsx (CollapsibleToolOutput
 * was removed as dead code — it hasn't been mounted since the v0.7.0
 * static-scrollback refactor). The color policy itself is unchanged.
 */
describe('ToolOutput.classifyToolColor', () => {
  it('green for read tools', () => {
    expect(classifyToolColor('read_file')).toBe('green');
    expect(classifyToolColor('cat')).toBe('green');
    expect(classifyToolColor('grep_content')).toBe('green');
    expect(classifyToolColor('search')).toBe('green');
  });

  it('yellow for write/edit tools', () => {
    expect(classifyToolColor('write_file')).toBe('yellow');
    expect(classifyToolColor('edit_file')).toBe('yellow');
  });

  it('red for shell tools', () => {
    expect(classifyToolColor('bash')).toBe('red');
    expect(classifyToolColor('shell')).toBe('red');
    expect(classifyToolColor('exec')).toBe('red');
  });

  it('cyan for unknown tools', () => {
    expect(classifyToolColor('totally_unknown_tool')).toBe('cyan');
    expect(classifyToolColor('plan')).toBe('cyan');
  });

  it('red always wins on error (ok=false)', () => {
    expect(classifyToolColor('read_file', false)).toBe('red');
    expect(classifyToolColor('bash', false)).toBe('red');
  });

  it('ok=true uses the tool-class color', () => {
    expect(classifyToolColor('read_file', true)).toBe('green');
    expect(classifyToolColor('bash', true)).toBe('red');
    // Note: bash is red regardless of ok because it's a shell tool.
  });
});
