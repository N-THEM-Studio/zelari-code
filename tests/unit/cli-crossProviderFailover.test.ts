/**
 * cli-crossProviderFailover.test.ts — Tasks J.3.1–J.3.6 (v3-J)
 *
 * Coverage:
 *   - J.3.1: providerFailover with `fallbackLabel` includes label in messages
 *   - J.3.2: providerFailover without `fallbackLabel` is unchanged
 *   - J.3.3: app.tsx wires `resolveFailoverStream` + reads the env var
 *   - J.3.4: resolveFailoverStream → unknown provider id → graceful
 *   - J.3.5: resolveFailoverStream → missing API key → graceful
 *   - J.3.6: resolveFailoverStream → same as primary → no-op (no warning)
 *
 * Also verifies the `resolveFailoverStream` reason field for each branch
 * (`disabled` / `unset` / `unknown` / `same-as-primary` / `missing-key`
 * / `resolved`) so future refactors can't silently change behavior.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  providerFailover,
  collectDeltas,
} from '../../src/cli/providerFailover.js';
import { resolveFailoverStream } from '../../src/cli/crossProviderFailover.js';
import type {
  ProviderDelta,
  ProviderStreamFn,
} from '@zelari/core/harness';

const APP_TSX_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'cli',
  'app.tsx',
);
const USE_CHAT_TURN_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'cli',
  'hooks',
  'useChatTurn.ts',
);

const PARAMS = { messages: [] } as unknown as Parameters<ProviderStreamFn>[0];

function okProvider(deltas: ProviderDelta[]): ProviderStreamFn {
  return async function* () {
    for (const d of deltas) yield d;
  };
}

describe('providerFailover fallbackLabel (Task J.3.1)', () => {
  it('includes fallbackLabel in the "primary failed" message', async () => {
    const primary = okProvider([
      { kind: 'text', delta: 'before ' },
      { kind: 'error', message: 'upstream down' },
    ]);
    const fallback = okProvider([
      { kind: 'text', delta: 'from fallback' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const wrapped = providerFailover({
      primary,
      fallback,
      fallbackLabel: 'glm',
    });
    const out = await collectDeltas(wrapped, PARAMS);
    const msgs = out.filter((d) => d.kind === 'error').map((d) => {
      if (d.kind === 'error') return d.message;
      return '';
    });
    expect(msgs).toContain('upstream down');
    expect(msgs).toContain('[failover] primary failed, switching to glm');
  });

  it('includes fallbackLabel in the "primary threw" message', async () => {
    const primary: ProviderStreamFn = (async function* () {
      throw new Error('ECONNRESET');
    }) as never;
    const fallback = okProvider([
      { kind: 'text', delta: 'fb' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const wrapped = providerFailover({
      primary,
      fallback,
      fallbackLabel: 'minimax',
    });
    const out = await collectDeltas(wrapped, PARAMS);
    const errMsgs = out.filter((d) => d.kind === 'error').map((d) => {
      if (d.kind === 'error') return d.message;
      return '';
    });
    expect(errMsgs).toContain(
      '[failover] primary threw, switching to minimax: ECONNRESET',
    );
  });

  it('includes fallbackLabel in the "fallback also failed" message', async () => {
    const primary = okProvider([{ kind: 'error', message: 'p' }]);
    const fallback: ProviderStreamFn = (async function* () {
      throw new Error('fb-fail');
    }) as never;
    const wrapped = providerFailover({
      primary,
      fallback,
      fallbackLabel: 'grok',
    });
    const out = await collectDeltas(wrapped, PARAMS);
    const errMsgs = out.filter((d) => d.kind === 'error').map((d) => {
      if (d.kind === 'error') return d.message;
      return '';
    });
    expect(errMsgs).toContain(
      '[failover] fallback (grok) also failed: fb-fail',
    );
  });
});

describe('providerFailover backward-compat without fallbackLabel (Task J.3.2)', () => {
  it('uses v3-G messages when fallbackLabel is omitted', async () => {
    const primary = okProvider([{ kind: 'error', message: 'upstream down' }]);
    const fallback = okProvider([
      { kind: 'text', delta: 'fb' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const wrapped = providerFailover({ primary, fallback });
    const out = await collectDeltas(wrapped, PARAMS);
    const errMsgs = out.filter((d) => d.kind === 'error').map((d) => {
      if (d.kind === 'error') return d.message;
      return '';
    });
    expect(errMsgs).toContain('upstream down');
    expect(errMsgs).toContain(
      '[failover] primary failed, switching to fallback',
    );
  });

  it('does not inject "(switching to ..." suffix when fallbackLabel is omitted', async () => {
    const primary: ProviderStreamFn = (async function* () {
      throw new Error('NETWORK');
    }) as never;
    const fallback = okProvider([
      { kind: 'text', delta: 'fb' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const wrapped = providerFailover({ primary, fallback });
    const out = await collectDeltas(wrapped, PARAMS);
    const errMsgs = out.filter((d) => d.kind === 'error').map((d) => {
      if (d.kind === 'error') return d.message;
      return '';
    });
    // The v3-G exact string must be present.
    expect(errMsgs).toContain('[failover] primary threw: NETWORK');
    // And the J.1 variant must NOT be present (no fallbackLabel).
    expect(errMsgs.some((m) => m.includes('switching to'))).toBe(false);
  });
});

describe('useChatTurn.ts wiring of cross-provider failover (Task J.3.3)', () => {
  it('imports resolveFailoverStream from ../crossProviderFailover.js', () => {
    const src = readFileSync(USE_CHAT_TURN_PATH, 'utf-8');
    expect(src).toMatch(
      /import\s*\{[^}]*\bresolveFailoverStream\b[^}]*\}\s*from\s*['"][^'"]*crossProviderFailover\.js['"]/,
    );
  });

  it('reads ANATHEMA_FAILOVER_PROVIDER env var in dispatchPrompt', () => {
    const src = readFileSync(USE_CHAT_TURN_PATH, 'utf-8');
    const idx = src.indexOf('const dispatchPrompt');
    expect(idx).toBeGreaterThan(-1);
    // Window must cover ask_user wiring that precedes failover in dispatchPrompt.
    const window = src.slice(idx, idx + 16000);
    expect(window).toMatch(/ANATHEMA_FAILOVER_PROVIDER/);
    expect(window).toMatch(/resolveFailoverStream\s*\(\s*\{/);
  });
});

describe('resolveFailoverStream — graceful degradation (Tasks J.3.4–J.3.6)', () => {
  const VALID_IDS = ['openai-compatible', 'minimax', 'glm', 'grok', 'custom'];
  const primary = okProvider([]);

  function makeStream(): ProviderStreamFn {
    return async function* () {
      yield { kind: 'finish', reason: 'stop' };
    };
  }

  it('J.3.4: unknown provider id → reason=unknown, warning, fallback=primary, no label', async () => {
    const result = await resolveFailoverStream({
      failoverEnabled: true,
      envValue: 'mystery-provider',
      primaryProviderId: 'grok',
      primary,
      validProviderIds: VALID_IDS,
      lookupFallbackConfig: async () => ({}),
      buildStream: () => makeStream(),
    });
    expect(result.reason).toBe('unknown');
    expect(result.warning).toContain('mystery-provider');
    expect(result.warning).toContain('not a known provider');
    expect(result.fallback).toBe(primary);
    expect(result.fallbackLabel).toBeUndefined();
  });

  it('J.3.5: missing API key for fallback provider → reason=missing-key, warning, fallback=primary', async () => {
    const result = await resolveFailoverStream({
      failoverEnabled: true,
      envValue: 'glm',
      primaryProviderId: 'grok',
      primary,
      validProviderIds: VALID_IDS,
      lookupFallbackConfig: async () => null,
      buildStream: () => makeStream(),
    });
    expect(result.reason).toBe('missing-key');
    expect(result.warning).toContain('glm');
    expect(result.warning).toContain('No API key');
    expect(result.fallback).toBe(primary);
    expect(result.fallbackLabel).toBeUndefined();
  });

  it('J.3.6: same as primary → reason=same-as-primary, no warning, fallback=primary', async () => {
    const result = await resolveFailoverStream({
      failoverEnabled: true,
      envValue: 'grok',
      primaryProviderId: 'grok',
      primary,
      validProviderIds: VALID_IDS,
      lookupFallbackConfig: async () => {
        throw new Error('should not be called for same-as-primary');
      },
      buildStream: () => makeStream(),
    });
    expect(result.reason).toBe('same-as-primary');
    expect(result.warning).toBe('');
    expect(result.fallback).toBe(primary);
    expect(result.fallbackLabel).toBeUndefined();
  });

  it('unset env var → reason=unset, no warning, fallback=primary', async () => {
    const result = await resolveFailoverStream({
      failoverEnabled: true,
      envValue: undefined,
      primaryProviderId: 'grok',
      primary,
      validProviderIds: VALID_IDS,
      lookupFallbackConfig: async () => null,
      buildStream: () => makeStream(),
    });
    expect(result.reason).toBe('unset');
    expect(result.warning).toBe('');
    expect(result.fallback).toBe(primary);
    expect(result.fallbackLabel).toBeUndefined();
  });

  it('empty / whitespace env var → reason=unset (whitespace trimmed)', async () => {
    const result = await resolveFailoverStream({
      failoverEnabled: true,
      envValue: '   ',
      primaryProviderId: 'grok',
      primary,
      validProviderIds: VALID_IDS,
      lookupFallbackConfig: async () => null,
      buildStream: () => makeStream(),
    });
    expect(result.reason).toBe('unset');
  });

  it('ANATHEMA_FAILOVER=0 (master kill-switch) → reason=disabled, no lookup called', async () => {
    const result = await resolveFailoverStream({
      failoverEnabled: false,
      envValue: 'glm',
      primaryProviderId: 'grok',
      primary,
      validProviderIds: VALID_IDS,
      lookupFallbackConfig: async () => {
        throw new Error('should not be called when disabled');
      },
      buildStream: () => makeStream(),
    });
    expect(result.reason).toBe('disabled');
    expect(result.warning).toBe('');
    expect(result.fallback).toBe(primary);
    expect(result.fallbackLabel).toBeUndefined();
  });

  it('resolved path → reason=resolved, buildStream called with config, label set', async () => {
    let buildStreamCalled = false;
    let buildStreamReceivedConfig: unknown = null;
    const result = await resolveFailoverStream({
      failoverEnabled: true,
      envValue: 'glm',
      primaryProviderId: 'grok',
      primary,
      validProviderIds: VALID_IDS,
      lookupFallbackConfig: async () => ({ apiKey: 'k', baseUrl: 'u', model: 'glm-4.6', providerId: 'glm' }),
      buildStream: (cfg) => {
        buildStreamCalled = true;
        buildStreamReceivedConfig = cfg;
        return makeStream();
      },
    });
    expect(result.reason).toBe('resolved');
    expect(result.warning).toBe('');
    expect(result.fallbackLabel).toBe('glm');
    expect(result.fallback).not.toBe(primary);
    expect(buildStreamCalled).toBe(true);
    expect(buildStreamReceivedConfig).toEqual({ apiKey: 'k', baseUrl: 'u', model: 'glm-4.6', providerId: 'glm' });
  });
});
