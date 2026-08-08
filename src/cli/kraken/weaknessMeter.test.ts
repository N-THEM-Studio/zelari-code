/**
 * Tests for the LLM weakness meter wiring.
 *
 * These tests exercise the parsing + env-gating only — they never call
 * a real provider. A small `fetchImpl` stub stands in for the network.
 *
 * @since v1.31.x
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWeaknessMeterCacheForTests,
  isWeaknessMeterEnabled,
  measureWeaknessViaLLM,
  parseMeterContent,
} from './weaknessMeter.js';

afterEach(() => {
  _resetWeaknessMeterForTests();
  vi.restoreAllMocks();
});

function _resetWeaknessMeterForTests() {
  _resetWeaknessMeterCacheForTests();
}

describe('isWeaknessMeterEnabled', () => {
  it('defaults to false', () => {
    expect(isWeaknessMeterEnabled({})).toBe(false);
  });

  it('treats "1", "true", "yes" as enabled', () => {
    expect(isWeaknessMeterEnabled({ ZELARI_KRAKEN_WEAKNESS_METER: '1' })).toBe(true);
    expect(isWeaknessMeterEnabled({ ZELARI_KRAKEN_WEAKNESS_METER: 'true' })).toBe(true);
    expect(isWeaknessMeterEnabled({ ZELARI_KRAKEN_WEAKNESS_METER: 'yes' })).toBe(true);
  });

  it('treats other truthy values as disabled (avoid surprise)', () => {
    expect(isWeaknessMeterEnabled({ ZELARI_KRAKEN_WEAKNESS_METER: 'enabled' })).toBe(false);
    expect(isWeaknessMeterEnabled({ ZELARI_KRAKEN_WEAKNESS_METER: 'on' })).toBe(false);
  });

  it('memoizes the env read for the process', () => {
    expect(isWeaknessMeterEnabled({ ZELARI_KRAKEN_WEAKNESS_METER: '1' })).toBe(true);
    // Even if we re-call without the var, the cache wins until reset.
    expect(isWeaknessMeterEnabled({})).toBe(true);
    _resetWeaknessMeterForTests();
    expect(isWeaknessMeterEnabled({})).toBe(false);
  });
});

describe('measureWeaknessViaLLM (gating)', () => {
  it('returns null when the meter is disabled (default)', async () => {
    const out = await measureWeaknessViaLLM('hello', {
      env: {},
      providerOverride: {
        providerId: 'openai-compatible',
        model: 'gpt-4o-mini',
        endpoint: 'https://example.invalid',
        apiKey: 'k',
      },
      fetchImpl: vi.fn(),
    });
    expect(out).toBeNull();
  });

  it('returns null on empty / whitespace text even when enabled', async () => {
    const out = await measureWeaknessViaLLM('   \n  ', {
      env: { ZELARI_KRAKEN_WEAKNESS_METER: '1' },
      providerOverride: {
        providerId: 'openai-compatible',
        model: 'gpt-4o-mini',
        endpoint: 'https://example.invalid',
        apiKey: 'k',
      },
      fetchImpl: vi.fn(),
    });
    expect(out).toBeNull();
  });
});

describe('measureWeaknessViaLLM (HTTP path)', () => {
  function goodFetch(): typeof fetch {
    return vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  specificity: 0.42,
                  assumptions: ['the file is at /x', 'version is 1.2.3'],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  }

  it('parses a clean JSON payload', async () => {
    const out = await measureWeaknessViaLLM('I MUST always EXACTLY at line 42 version 1.2.3.', {
      env: { ZELARI_KRAKEN_WEAKNESS_METER: '1' },
      providerOverride: {
        providerId: 'openai-compatible',
        model: 'gpt-4o-mini',
        endpoint: 'https://example.invalid',
        apiKey: 'k',
      },
      fetchImpl: goodFetch(),
    });
    expect(out).not.toBeNull();
    expect(out!.meter.specificity).toBe(0.42);
    expect(out!.meter.assumptions).toHaveLength(2);
    expect(out!.weakness).toBeCloseTo(0.58, 5);
    expect(out!.model).toBe('gpt-4o-mini');
  });

  it('parses a ```json fenced payload', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '```json\n{"specificity": 0.9, "assumptions": []}\n```',
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = await measureWeaknessViaLLM('Looks good.', {
      env: { ZELARI_KRAKEN_WEAKNESS_METER: '1' },
      providerOverride: {
        providerId: 'openai-compatible',
        model: 'gpt-4o-mini',
        endpoint: 'https://example.invalid',
        apiKey: 'k',
      },
      fetchImpl,
    });
    expect(out).not.toBeNull();
    expect(out!.weakness).toBeCloseTo(0.1, 5);
  });

  it('returns null on HTTP non-2xx', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;
    const out = await measureWeaknessViaLLM('Whatever.', {
      env: { ZELARI_KRAKEN_WEAKNESS_METER: '1' },
      providerOverride: {
        providerId: 'openai-compatible',
        model: 'gpt-4o-mini',
        endpoint: 'https://example.invalid',
        apiKey: 'k',
      },
      fetchImpl,
    });
    expect(out).toBeNull();
  });

  it('returns null on malformed JSON (silent failure)', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{not valid' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = await measureWeaknessViaLLM('Whatever.', {
      env: { ZELARI_KRAKEN_WEAKNESS_METER: '1' },
      providerOverride: {
        providerId: 'openai-compatible',
        model: 'gpt-4o-mini',
        endpoint: 'https://example.invalid',
        apiKey: 'k',
      },
      fetchImpl,
    });
    expect(out).toBeNull();
  });

  it('returns null when the payload fails zod validation', async () => {
    const fetchImpl = vi.fn(async () => {
      // specificity out of range — zod should reject.
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ specificity: 1.7, assumptions: [] }) } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = await measureWeaknessViaLLM('Whatever.', {
      env: { ZELARI_KRAKEN_WEAKNESS_METER: '1' },
      providerOverride: {
        providerId: 'openai-compatible',
        model: 'gpt-4o-mini',
        endpoint: 'https://example.invalid',
        apiKey: 'k',
      },
      fetchImpl,
    });
    expect(out).toBeNull();
  });

  it('returns null on a fetch rejection (network / timeout)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const out = await measureWeaknessViaLLM('Whatever.', {
      env: { ZELARI_KRAKEN_WEAKNESS_METER: '1' },
      providerOverride: {
        providerId: 'openai-compatible',
        model: 'gpt-4o-mini',
        endpoint: 'https://example.invalid',
        apiKey: 'k',
      },
      fetchImpl,
    });
    expect(out).toBeNull();
  });
});

describe('parseMeterContent (unit)', () => {
  it('accepts raw JSON', () => {
    const out = parseMeterContent(
      JSON.stringify({ specificity: 0.2, assumptions: ['a'] }),
      'm',
      42,
    );
    expect(out).not.toBeNull();
    expect(out!.meter.specificity).toBe(0.2);
    expect(out!.durationMs).toBe(42);
  });

  it('accepts a ```json fenced payload', () => {
    const out = parseMeterContent(
      '```json\n{"specificity": 0.5, "assumptions": []}\n```',
      'm',
      0,
    );
    expect(out).not.toBeNull();
    expect(out!.meter.specificity).toBe(0.5);
  });

  it('returns null on a too-many-assumptions payload (>12)', () => {
    const tooMany = Array.from({ length: 13 }, (_, i) => `a${i}`);
    const out = parseMeterContent(
      JSON.stringify({ specificity: 0.5, assumptions: tooMany }),
      'm',
      0,
    );
    expect(out).toBeNull();
  });
});
