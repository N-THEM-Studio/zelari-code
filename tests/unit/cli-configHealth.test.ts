/**
 * cli-configHealth.test.ts — `--doctor` flags stale provider config and
 * `--doctor --fix` only repairs what has evidence (2026-09-24 field report:
 * provider.json still held `grok / default-grok`, a model no provider serves).
 */
import { describe, expect, it } from 'vitest';
import { checkEndpoint, checkSavedModel, summarizeFindings } from '../../src/cli/configHealth.js';

const base = { provider: 'grok', staticModels: ['grok-4.6'], builtinDefault: 'grok-4.6' };

describe('checkSavedModel', () => {
  it('a model in the discovered list is fine', () => {
    expect(checkSavedModel({ ...base, model: 'grok-4.6-fast', discovered: ['grok-4.6', 'grok-4.6-fast'] }).level).toBe('ok');
  });

  it('a model missing from the DISCOVERED list is a warning with a fix to the default', () => {
    const f = checkSavedModel({ ...base, model: 'grok-3', discovered: ['grok-4.6', 'grok-4.6-fast'] });
    expect(f.level).toBe('warn');
    expect(f.fix).toEqual({ provider: 'grok', from: 'grok-3', to: 'grok-4.6' });
  });

  it('falls back to the first discovered id when the built-in default is not served', () => {
    const f = checkSavedModel({ ...base, model: 'old', discovered: ['grok-5'] });
    expect(f.fix?.to).toBe('grok-5');
  });

  it('a placeholder id is fixable even without discovery', () => {
    const f = checkSavedModel({ ...base, model: 'default-grok' });
    expect(f.level).toBe('warn');
    expect(f.fix).toEqual({ provider: 'grok', from: 'default-grok', to: 'grok-4.6' });
  });

  it('an unknown id WITHOUT discovery is unverified — reported, never "fixed" (P1)', () => {
    const f = checkSavedModel({ ...base, model: 'grok-4.7-preview' });
    expect(f.level).toBe('info');
    expect(f.fix).toBeUndefined();
    expect(f.message).toContain('--discover-models --provider grok');
  });

  it('a list discovered on ANOTHER server is not evidence (endpoint changed since)', () => {
    const f = checkSavedModel({
      ...base,
      provider: 'openai-compatible',
      model: 'free/qwen-3.8-max',
      discovered: ['qwen-max', 'qwen-plus'],
      discoveredFrom: 'https://token-plan.example.com/v1',
      currentBaseUrl: 'https://openrouter.example/api/v1',
    });
    expect(f.level).toBe('info');
    expect(f.fix).toBeUndefined();
    expect(f.message).toContain('from another server');
    // Same server (trailing slash / case differences ignored) stays authoritative.
    const same = checkSavedModel({
      ...base,
      model: 'old',
      discovered: ['grok-4.6'],
      discoveredFrom: 'https://api.x.ai/v1/',
      currentBaseUrl: 'https://API.x.ai/v1',
    });
    expect(same.level).toBe('warn');
  });

  it('an empty saved model gets the default', () => {
    expect(checkSavedModel({ ...base, model: '' }).fix?.to).toBe('grok-4.6');
  });
});

describe('checkEndpoint', () => {
  it('openai-compatible without an address warns about the legacy api.x.ai default', () => {
    const f = checkEndpoint({ provider: 'openai-compatible' });
    expect(f.level).toBe('warn');
    expect(f.message).toContain('api.x.ai');
  });

  it('a custom endpoint or OPENAI_BASE_URL satisfies it; other providers are not concerned', () => {
    expect(checkEndpoint({ provider: 'openai-compatible', customEndpoint: 'http://127.0.0.1:11434/v1' }).level).toBe('ok');
    expect(checkEndpoint({ provider: 'openai-compatible', envBaseUrl: 'https://proxy/v1' }).level).toBe('ok');
    expect(checkEndpoint({ provider: 'deepseek' }).level).toBe('ok');
  });
});

describe('summarizeFindings', () => {
  it('points at --doctor --fix only when something is fixable', () => {
    const fixable = summarizeFindings([checkSavedModel({ ...base, model: 'default-grok' })]);
    expect(fixable.ok).toBe(false);
    expect(fixable.message).toContain('zelari-code --doctor --fix');
    const unfixable = summarizeFindings([checkEndpoint({ provider: 'openai-compatible' })]);
    expect(unfixable.ok).toBe(false);
    expect(unfixable.message).not.toContain('--fix');
    expect(summarizeFindings([{ level: 'ok', message: 'grok / grok-4.6' }])).toEqual({ ok: true, message: 'grok / grok-4.6' });
  });
});
