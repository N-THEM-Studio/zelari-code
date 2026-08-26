/**
 * krakenModel family routing (P0.6) — cross-provider blind verification:
 * inferModelFamily buckets, pickDifferentFamily stability, and
 * resolveCrossModelVerifier priority (explicit env > different family >
 * opt-out null). resolveKrakenSubModel('verify') returns a QUALIFIED ref
 * when familyCandidates are supplied; without them behavior is unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
  inferModelFamily,
  parseQualifiedModelRef,
  pickDifferentFamily,
  resolveCrossModelVerifier,
  resolveKrakenSubModel,
} from './krakenModel.js';

describe('inferModelFamily', () => {
  it('buckets known provider families (provider or model id)', () => {
    expect(inferModelFamily('openai', 'gpt-5')).toBe('openai');
    expect(inferModelFamily('openai-compatible', 'o3-mini')).toBe('openai');
    expect(inferModelFamily('', 'chatgpt-4o')).toBe('openai');
    expect(inferModelFamily('', 'gpt-5-mini')).toBe('openai');
    expect(inferModelFamily('codex')).toBe('openai');
    expect(inferModelFamily('anthropic', 'claude-sonnet-4')).toBe('anthropic');
    expect(inferModelFamily('bedrock', 'claude-haiku')).toBe('anthropic');
    expect(inferModelFamily('google', 'gemini-2.5-flash')).toBe('google');
    expect(inferModelFamily('vertex')).toBe('vertex'); // unknown provider keeps its id
    expect(inferModelFamily('xai', 'grok-4')).toBe('xai');
    expect(inferModelFamily('zhipu', 'glm-4.7-air')).toBe('zhipu');
    expect(inferModelFamily('deepseek', 'deepseek-chat')).toBe('deepseek');
    expect(inferModelFamily('', '')).toBe('other');
  });
});

describe('pickDifferentFamily', () => {
  const candidates = [
    { provider: 'openai', model: 'gpt-5-mini' },
    { provider: 'anthropic', model: 'claude-sonnet-4' },
  ];

  it('returns the first candidate outside the builder family (stable order)', () => {
    expect(pickDifferentFamily({ provider: 'openai', model: 'gpt-5' }, candidates)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });
  });

  it('returns null when every candidate shares the builder family', () => {
    expect(
      pickDifferentFamily(
        { provider: 'openai', model: 'gpt-5' },
        [
          { provider: 'chatgpt', model: 'gpt-5' },
          { provider: 'openai', model: 'o4-mini' },
        ],
      ),
    ).toBeNull();
  });

  it('skips malformed entries and preserves candidate order', () => {
    expect(
      pickDifferentFamily({ provider: 'anthropic', model: 'claude-sonnet-4' }, [
        { provider: '', model: 'gpt-5' },
        { provider: 'google', model: '' },
        { provider: 'zhipu', model: 'glm-4.7-air' },
      ]),
    ).toEqual({ provider: 'zhipu', model: 'glm-4.7-air' });
  });
});

describe('resolveCrossModelVerifier', () => {
  const builder = { provider: 'openai', model: 'gpt-5' };
  const candidates = [{ provider: 'anthropic', model: 'claude-sonnet-4' }];

  it('explicit ZELARI_KRAKEN_VERIFY_MODEL wins (qualified ref parsed)', () => {
    expect(
      resolveCrossModelVerifier(builder, candidates, {
        ZELARI_KRAKEN_VERIFY_MODEL: 'grok/grok-4',
      }),
    ).toEqual({ provider: 'grok', model: 'grok-4' });
  });

  it('unqualified override inherits the builder provider (even same family)', () => {
    expect(
      resolveCrossModelVerifier(builder, candidates, {
        ZELARI_KRAKEN_VERIFY_MODEL: 'gpt-5-mini',
      }),
    ).toEqual({ provider: 'openai', model: 'gpt-5-mini' });
  });

  it('without env override picks the first different family', () => {
    expect(resolveCrossModelVerifier(builder, candidates, {})).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });
  });

  it('ZELARI_KRAKEN_CROSS_MODEL=0 opts out (inherit/same family kept)', () => {
    expect(resolveCrossModelVerifier(builder, candidates, { ZELARI_KRAKEN_CROSS_MODEL: '0' })).toBeNull();
    expect(resolveCrossModelVerifier(builder, candidates, { ZELARI_KRAKEN_CROSS_MODEL: 'off' })).toBeNull();
  });

  it('no different-family candidate → null (same-family fallback allowed)', () => {
    expect(
      resolveCrossModelVerifier(builder, [{ provider: 'openai', model: 'gpt-5-mini' }], {}),
    ).toBeNull();
  });
});

describe("resolveKrakenSubModel('verify') × familyCandidates", () => {
  const families = [
    { provider: 'openai', model: 'gpt-5-mini' },
    { provider: 'anthropic', model: 'claude-sonnet-4' },
  ];

  it('verify + familyCandidates returns a QUALIFIED different-family ref', () => {
    const picked = resolveKrakenSubModel('verify', 'gpt-5', {}, {
      provider: 'openai',
      familyCandidates: families,
    });
    expect(picked).toBe('anthropic/claude-sonnet-4');
    expect(parseQualifiedModelRef(picked)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });
  });

  it('kind-specific env still beats family candidates', () => {
    expect(
      resolveKrakenSubModel('verify', 'gpt-5', { ZELARI_KRAKEN_VERIFY_MODEL: 'glm/glm-4.7-air' }, {
        provider: 'openai',
        familyCandidates: families,
      }),
    ).toBe('glm/glm-4.7-air');
  });

  it('shared SUB_MODEL still takes precedence over the family pick', () => {
    expect(
      resolveKrakenSubModel('verify', 'gpt-5', { ZELARI_KRAKEN_SUB_MODEL: 'cheap-mini' }, {
        provider: 'openai',
        familyCandidates: families,
      }),
    ).toBe('cheap-mini');
  });

  it('no familyCandidates → unchanged auto-pick/parent behavior', () => {
    expect(resolveKrakenSubModel('verify', 'grok-4', {})).toBe('grok-4');
    expect(
      resolveKrakenSubModel('verify', 'grok-4', { ZELARI_KRAKEN_AUTO_MODEL: '1' }, {
        candidates: ['gemini-2.5-flash-lite'],
      }),
    ).toBe('gemini-2.5-flash-lite');
  });
});
