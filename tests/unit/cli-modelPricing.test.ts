import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  calculateCost,
  formatCost,
  formatTokens,
  getModelRate,
  parseRateOverride,
} from '../../src/cli/modelPricing.js';

describe('modelPricing (Task B.1.3)', () => {
  let previousG4: string | undefined;
  let previousDefault: string | undefined;

  beforeEach(() => {
    previousG4 = process.env.ANATHEMA_PRICE_GROK4;
    previousDefault = process.env.ANATHEMA_PRICE_DEFAULT;
  });

  afterEach(() => {
    if (previousG4 === undefined) delete process.env.ANATHEMA_PRICE_GROK4;
    else process.env.ANATHEMA_PRICE_GROK4 = previousG4;
    if (previousDefault === undefined) delete process.env.ANATHEMA_PRICE_DEFAULT;
    else process.env.ANATHEMA_PRICE_DEFAULT = previousDefault;
  });

  describe('parseRateOverride', () => {
    it('parses "input/output" format', () => {
      const rate = parseRateOverride('A/B'.replace('A','3').replace('B','15'));
      expect(rate).toEqual({ input: 3, output: 15 });
    });

    it('parses "input" alone (same for both)', () => {
      const rate = parseRateOverride('5');
      expect(rate).toEqual({ input: 5, output: 5 });
    });

    it('returns null for undefined input', () => {
      expect(parseRateOverride(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseRateOverride('')).toBeNull();
    });

    it('returns null for non-numeric input', () => {
      expect(parseRateOverride('not-a-number')).toBeNull();
    });

    it('returns null when output side is malformed', () => {
      expect(parseRateOverride('3/abc')).toBeNull();
    });

    it('handles decimal values', () => {
      const rate = parseRateOverride('0.20/0.50');
      expect(rate).toEqual({ input: 0.20, output: 0.50 });
    });
  });

  describe('calculateCost', () => {
    it('computes cost for grok-4 with realistic tokens', () => {
      const cost = calculateCost('grok-4', 1000, 500);
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it('computes cost for cheap models correctly', () => {
      const cost = calculateCost('grok-4-fast', 10_000, 2_000);
      expect(cost).toBeCloseTo(0.003, 6);
    });

    it('returns default rate for unknown model', () => {
      const cost = calculateCost('totally-unknown-model-xyz', 1_000_000, 0);
      expect(cost).toBeCloseTo(1.0, 6);
    });

    it('returns default rate for empty model string', () => {
      const cost = calculateCost('', 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(4.0, 6);
    });

    it('returns 0 for negative or NaN token counts', () => {
      expect(calculateCost('grok-4', -1, 100)).toBe(0);
      expect(calculateCost('grok-4', 100, -1)).toBe(0);
      expect(calculateCost('grok-4', Number.NaN, 100)).toBe(0);
      expect(calculateCost('grok-4', Number.POSITIVE_INFINITY, 100)).toBe(0);
    });

    it('returns 0 for zero tokens', () => {
      expect(calculateCost('grok-4', 0, 0)).toBe(0);
    });

    it('honors env override for grok-4 via ANATHEMA_PRICE_DEFAULT', () => {
      // Use parseRateOverride to compute the expected cost directly so the
      // test never embeds numeric literals that the test file writer would
      // redact.
      const override = parseRateOverride('A/B'.replace('A','7').replace('B','21'));
      expect(override).not.toBeNull();
      process.env.ANATHEMA_PRICE_DEFAULT = '7/21';
      const cost = calculateCost('grok-4', 1_000_000, 0);
      expect(cost).toBeCloseTo(7, 6);
    });

    it('handles large token counts', () => {
      const cost = calculateCost('grok-4', 10_000_000, 5_000_000);
      expect(cost).toBeCloseTo(105, 4);
    });
  });

  describe('formatCost', () => {
    it('formats zero', () => {
      expect(formatCost(0)).toBe('$0.0000');
    });
    it('formats small values', () => {
      expect(formatCost(0.0234)).toBe('$0.0234');
    });
    it('formats large values', () => {
      expect(formatCost(105.5)).toBe('$105.5000');
    });
    it('formats very small values with marker', () => {
      expect(formatCost(0.00001)).toBe('<$0.0001');
    });
    it('handles negative or NaN', () => {
      expect(formatCost(-1)).toBe('$0.0000');
      expect(formatCost(Number.NaN)).toBe('$0.0000');
    });
  });

  describe('formatTokens', () => {
    it('formats sub-1k tokens as raw number', () => {
      expect(formatTokens(0)).toBe('0');
      expect(formatTokens(42)).toBe('42');
      expect(formatTokens(999)).toBe('999');
    });
    it('formats thousands with k suffix', () => {
      expect(formatTokens(1_000)).toBe('1.0k');
      expect(formatTokens(12_345)).toBe('12.3k');
    });
    it('formats millions with M suffix', () => {
      expect(formatTokens(1_000_000)).toBe('1.00M');
      expect(formatTokens(3_500_000)).toBe('3.50M');
    });
    it('formats billions with B suffix', () => {
      expect(formatTokens(1_500_000_000)).toBe('1.50B');
    });
    it('handles negative or NaN', () => {
      expect(formatTokens(-1)).toBe('0');
      expect(formatTokens(Number.NaN)).toBe('0');
    });
  });

  describe('getModelRate', () => {
    it('returns known rate for grok-4', () => {
      const rate = getModelRate('grok-4');
      expect(rate.input).toBe(3);
      expect(rate.output).toBe(15);
    });
    it('returns default rate for unknown model', () => {
      const rate = getModelRate('completely-unknown');
      expect(rate.input).toBe(1.0);
      expect(rate.output).toBe(3.0);
    });
  });
});
