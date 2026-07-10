/**
 * desktop-config.test.ts — pure tests for print/set-config flag parsing.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSetConfigFlags,
  wantsPrintConfig,
} from '../../src/cli/desktopConfig.js';

describe('wantsPrintConfig', () => {
  it('detects --print-config', () => {
    expect(wantsPrintConfig(['--print-config'])).toBe(true);
    expect(wantsPrintConfig(['--headless'])).toBe(false);
  });
});

describe('parseSetConfigFlags', () => {
  it('returns null when flag absent', () => {
    expect(parseSetConfigFlags(['--headless']).request).toBeNull();
  });

  it('errors when --set-config without provider/model', () => {
    const r = parseSetConfigFlags(['--set-config']);
    expect(r.request).toBeNull();
    expect(r.error).toMatch(/requires --provider/);
  });

  it('parses provider only', () => {
    const r = parseSetConfigFlags(['--set-config', '--provider', 'minimax']);
    expect(r.error).toBeUndefined();
    expect(r.request).toEqual({ provider: 'minimax', model: undefined });
  });

  it('parses model only', () => {
    const r = parseSetConfigFlags(['--set-config', '--model', 'grok-4']);
    expect(r.request).toEqual({ provider: undefined, model: 'grok-4' });
  });

  it('parses both', () => {
    const r = parseSetConfigFlags([
      '--set-config', '--provider', 'glm', '--model', 'glm-4.6',
    ]);
    expect(r.request).toEqual({ provider: 'glm', model: 'glm-4.6' });
  });
});
