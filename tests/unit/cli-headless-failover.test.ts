import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isHeadlessFailoverEnabled,
  wrapWithHeadlessFailover,
} from '../../src/cli/crossProviderFailover.js';
import { collectDeltas, providerFailover } from '../../src/cli/providerFailover.js';
import type { ProviderDelta, ProviderStreamFn } from '@zelari/core/harness';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PARAMS = { messages: [] } as unknown as Parameters<ProviderStreamFn>[0];

function okStream(text: string): ProviderStreamFn {
  return async function* () {
    yield { kind: 'text', delta: text };
    yield { kind: 'finish', reason: 'stop' };
  };
}

function errorStream(message: string): ProviderStreamFn {
  return async function* () {
    yield { kind: 'error', message };
  };
}

describe('isHeadlessFailoverEnabled (Int5b)', () => {
  it('is off by default', () => {
    expect(isHeadlessFailoverEnabled({})).toBe(false);
    expect(isHeadlessFailoverEnabled({ ZELARI_HEADLESS_FAILOVER: '0' })).toBe(false);
    expect(isHeadlessFailoverEnabled({ ZELARI_HEADLESS_FAILOVER: '1', ANATHEMA_FAILOVER: '0' })).toBe(false);
  });

  it('is on only when ZELARI_HEADLESS_FAILOVER=1 and ANATHEMA_FAILOVER is not 0', () => {
    expect(isHeadlessFailoverEnabled({ ZELARI_HEADLESS_FAILOVER: '1' })).toBe(true);
  });
});

describe('wrapWithHeadlessFailover (Int5b)', () => {
  const valid = ['glm', 'grok'];

  it('returns the same primary when flag is off (bit-identical)', async () => {
    const primary = okStream('p');
    const wrapped = await wrapWithHeadlessFailover({
      primary,
      primaryProviderId: 'glm',
      env: {},
      validProviderIds: valid,
      lookupFallbackConfig: async () => ({ id: 'grok' }),
      buildStream: () => okStream('SHOULD NOT'),
    });
    expect(wrapped).toBe(primary);
  });

  it('does not wrap when ANATHEMA_FAILOVER=0 even if headless flag is 1', async () => {
    const primary = okStream('p');
    const wrapped = await wrapWithHeadlessFailover({
      primary,
      primaryProviderId: 'glm',
      env: {
        ZELARI_HEADLESS_FAILOVER: '1',
        ANATHEMA_FAILOVER: '0',
        ANATHEMA_FAILOVER_PROVIDER: 'grok',
      },
      validProviderIds: valid,
      lookupFallbackConfig: async () => ({ id: 'grok' }),
      buildStream: () => okStream('nope'),
    });
    expect(wrapped).toBe(primary);
  });

  it('swaps to fallback on transient error when flag is on and provider resolves', async () => {
    const primary = errorStream('boom');
    const fallback = okStream('from-grok');
    const wrapped = await wrapWithHeadlessFailover({
      primary,
      primaryProviderId: 'glm',
      env: { ZELARI_HEADLESS_FAILOVER: '1', ANATHEMA_FAILOVER_PROVIDER: 'grok' },
      validProviderIds: valid,
      lookupFallbackConfig: async (id) => (id === 'grok' ? { id: 'grok' } : null),
      buildStream: () => fallback,
    });
    expect(wrapped).not.toBe(primary);
    const out = await collectDeltas(wrapped, PARAMS);
    expect(out.some((d) => d.kind === 'text' && d.delta === 'from-grok')).toBe(true);
    expect(out.some((d) => d.kind === 'error' && d.message.includes('switching to grok'))).toBe(true);
  });

  it('does not swap on a clean finish', async () => {
    const primary = okStream('all-good');
    const wrapped = await wrapWithHeadlessFailover({
      primary,
      primaryProviderId: 'glm',
      env: { ZELARI_HEADLESS_FAILOVER: '1', ANATHEMA_FAILOVER_PROVIDER: 'grok' },
      validProviderIds: valid,
      lookupFallbackConfig: async () => ({ id: 'grok' }),
      buildStream: () => okStream('SHOULD NOT APPEAR'),
    });
    const out = await collectDeltas(wrapped, PARAMS);
    expect(out.find((d) => d.kind === 'text' && d.delta === 'SHOULD NOT APPEAR')).toBeUndefined();
    expect(out.some((d) => d.kind === 'text' && d.delta === 'all-good')).toBe(true);
  });

  it('surfaces a warning for an unknown failover provider without swapping identity of fallback', async () => {
    const warnings: string[] = [];
    const primary = okStream('p');
    await wrapWithHeadlessFailover({
      primary,
      primaryProviderId: 'glm',
      env: { ZELARI_HEADLESS_FAILOVER: '1', ANATHEMA_FAILOVER_PROVIDER: 'not-a-provider' },
      validProviderIds: valid,
      lookupFallbackConfig: async () => ({ id: 'x' }),
      buildStream: () => okStream('nope'),
      onWarning: (w) => warnings.push(w),
    });
    expect(warnings[0]).toMatch(/not a known provider/);
  });
});

describe('providerFailover onFailover audit (Int5b)', () => {
  it('fires on error-delta swap and not on clean pass-through', async () => {
    const events: string[] = [];
    const primary = errorStream('upstream timeout');
    const fallback = okStream('fb');
    const wrapped = providerFailover({
      primary,
      fallback,
      fallbackLabel: 'grok',
      onFailover: (info) => events.push(info.phase),
    });
    await collectDeltas(wrapped, PARAMS);
    expect(events).toEqual(['swap-delta']);

    events.length = 0;
    const clean = providerFailover({
      primary: okStream('ok'),
      fallback: okStream('nope'),
      onFailover: (info) => events.push(info.phase),
    });
    await collectDeltas(clean, PARAMS);
    expect(events).toEqual([]);
  });

  it('fires swap-throw then fallback-failed when both throw', async () => {
    const events: string[] = [];
    const primary: ProviderStreamFn = async function* () {
      throw new Error('primary down');
    };
    const fallback: ProviderStreamFn = async function* () {
      throw new Error('fallback down');
    };
    const wrapped = providerFailover({
      primary,
      fallback,
      onFailover: (info) => events.push(info.phase),
    });
    await collectDeltas(wrapped, PARAMS);
    expect(events).toEqual(['swap-throw', 'fallback-failed']);
  });

  it('swallows onFailover throws so the stream still yields', async () => {
    const primary = errorStream('boom');
    const fallback = okStream('recovered');
    const wrapped = providerFailover({
      primary,
      fallback,
      onFailover: () => {
        throw new Error('audit exploded');
      },
    });
    const out = await collectDeltas(wrapped, PARAMS);
    expect(out.some((d: ProviderDelta) => d.kind === 'text' && d.delta === 'recovered')).toBe(true);
  });
});

describe('static wiring Int5b', () => {
  it('runHeadless.ts reads ZELARI_HEADLESS_FAILOVER and wrapWithHeadlessFailover', () => {
    const src = readFileSync(join(ROOT, 'src/cli/runHeadless.ts'), 'utf-8');
    expect(src).toMatch(/ZELARI_HEADLESS_FAILOVER/);
    expect(src).toMatch(/wrapWithHeadlessFailover/);
  });

  it('toolRegistry tentacle factory wraps streams', () => {
    const src = readFileSync(join(ROOT, 'src/cli/toolRegistry.ts'), 'utf-8');
    expect(src).toMatch(/wrapWithHeadlessFailover/);
    expect(src).toMatch(/wrapTentacleStream/);
  });

  it('taskTool 404 retry path is preserved', () => {
    const src = readFileSync(join(ROOT, 'src/cli/tools/taskTool.ts'), 'utf-8');
    expect(src).toMatch(/isUnknownModelError/);
  });
});
