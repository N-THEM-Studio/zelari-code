import { describe, it, expect } from 'vitest';
import { resolveCouncilTier, COUNCIL_TIER_SIZES } from '../../src/cli/councilConfig.js';

describe('resolveCouncilTier', () => {
  it('defaults to full council (6 members)', () => {
    const r = resolveCouncilTier({});
    expect(r.tier).toBe('full');
    expect(r.councilSize).toBe(6);
  });

  it('honours explicit councilSize', () => {
    expect(resolveCouncilTier({ explicitSize: 3 }).councilSize).toBe(3);
    expect(resolveCouncilTier({ explicitSize: 6 }).councilSize).toBe(6);
  });

  it('clamps councilSize to 1..6', () => {
    expect(resolveCouncilTier({ explicitSize: 0 }).councilSize).toBe(1);
    expect(resolveCouncilTier({ explicitSize: 99 }).councilSize).toBe(6);
  });

  it('ZELARI_COUNCIL_TIER=lite → 3 members', () => {
    const r = resolveCouncilTier({ env: { ZELARI_COUNCIL_TIER: 'lite' } });
    expect(r.tier).toBe('lite');
    expect(r.councilSize).toBe(COUNCIL_TIER_SIZES.lite);
  });

  it('ZELARI_COUNCIL_SIZE env overrides default', () => {
    expect(resolveCouncilTier({ env: { ZELARI_COUNCIL_SIZE: '4' } }).councilSize).toBe(4);
  });
});
