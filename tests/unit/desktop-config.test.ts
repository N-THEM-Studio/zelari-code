/**
 * desktop-config.test.ts — pure tests for print/set-config/set-key flag parsing.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDiscoverModelsFlags,
  parseSetConfigFlags,
  parseSetKeyFlags,
  wantsDiscoverModels,
  wantsPrintConfig,
  wantsSetKey,
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

  it('errors when --set-config without args', () => {
    const r = parseSetConfigFlags(['--set-config']);
    expect(r.request).toBeNull();
    expect(r.error).toMatch(/requires/);
  });

  it('parses provider only', () => {
    const r = parseSetConfigFlags(['--set-config', '--provider', 'minimax']);
    expect(r.error).toBeUndefined();
    expect(r.request).toEqual({
      provider: 'minimax',
      model: undefined,
      endpoint: undefined,
      endpointClear: undefined,
    });
  });

  it('parses model only', () => {
    const r = parseSetConfigFlags(['--set-config', '--model', 'grok-4']);
    expect(r.request?.model).toBe('grok-4');
  });

  it('parses both', () => {
    const r = parseSetConfigFlags([
      '--set-config', '--provider', 'glm', '--model', 'glm-4.6',
    ]);
    expect(r.request).toMatchObject({ provider: 'glm', model: 'glm-4.6' });
  });

  it('parses --endpoint', () => {
    const r = parseSetConfigFlags([
      '--set-config',
      '--provider',
      'openai-compatible',
      '--endpoint',
      'http://127.0.0.1:11434/v1',
    ]);
    expect(r.request?.endpoint).toBe('http://127.0.0.1:11434/v1');
  });

  it('parses --endpoint-clear', () => {
    const r = parseSetConfigFlags([
      '--set-config',
      '--provider',
      'openai-compatible',
      '--endpoint-clear',
    ]);
    expect(r.request?.endpointClear).toBe(true);
  });

  it('errors on endpoint + endpoint-clear', () => {
    const r = parseSetConfigFlags([
      '--set-config',
      '--endpoint',
      'http://x',
      '--endpoint-clear',
    ]);
    expect(r.error).toMatch(/conflict/);
  });
});

describe('parseSetKeyFlags', () => {
  it('returns null when absent', () => {
    expect(parseSetKeyFlags([]).request).toBeNull();
  });

  it('requires provider and key', () => {
    expect(parseSetKeyFlags(['--set-key']).error).toMatch(/provider/);
    expect(
      parseSetKeyFlags(['--set-key', '--provider', 'minimax']).error,
    ).toMatch(/key/);
  });

  it('parses provider + key', () => {
    const r = parseSetKeyFlags([
      '--set-key',
      '--provider',
      'minimax',
      '--key',
      'sk-test-123',
    ]);
    expect(r.request).toEqual({ provider: 'minimax', key: 'sk-test-123' });
    expect(wantsSetKey(['--set-key'])).toBe(true);
  });
});

describe('parseDiscoverModelsFlags', () => {
  it('detects flag', () => {
    expect(wantsDiscoverModels(['--discover-models'])).toBe(true);
    expect(parseDiscoverModelsFlags(['--discover-models']).present).toBe(true);
    expect(parseDiscoverModelsFlags(['--discover-models']).provider).toBeNull();
  });

  it('parses provider', () => {
    const r = parseDiscoverModelsFlags([
      '--discover-models',
      '--provider',
      'minimax',
    ]);
    expect(r.provider).toBe('minimax');
  });
});
