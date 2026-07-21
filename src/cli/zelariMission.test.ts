import { describe, it, expect } from 'vitest';
import {
  resolveMaxCost,
  resolveMaxTokens,
  resolveMaxIterations,
  resolveMaxStall,
} from './zelariMission.js';

describe('resolveMaxCost (ADR-0013)', () => {
  it('returns undefined when env var is not set', () => {
    expect(resolveMaxCost({})).toBeUndefined();
  });

  it('parses a valid USD value', () => {
    expect(resolveMaxCost({ ZELARI_MISSION_MAX_COST: '5.00' })).toBe(5.0);
    expect(resolveMaxCost({ ZELARI_MISSION_MAX_COST: '0.50' })).toBe(0.5);
  });

  it('returns undefined for zero or negative', () => {
    expect(resolveMaxCost({ ZELARI_MISSION_MAX_COST: '0' })).toBeUndefined();
    expect(resolveMaxCost({ ZELARI_MISSION_MAX_COST: '-1' })).toBeUndefined();
  });

  it('returns undefined for non-numeric', () => {
    expect(resolveMaxCost({ ZELARI_MISSION_MAX_COST: 'abc' })).toBeUndefined();
    expect(resolveMaxCost({ ZELARI_MISSION_MAX_COST: '' })).toBeUndefined();
  });
});

describe('resolveMaxTokens (ADR-0013)', () => {
  it('returns undefined when env var is not set', () => {
    expect(resolveMaxTokens({})).toBeUndefined();
  });

  it('parses a valid token count', () => {
    expect(resolveMaxTokens({ ZELARI_MISSION_MAX_TOKENS: '2000000' })).toBe(2_000_000);
    expect(resolveMaxTokens({ ZELARI_MISSION_MAX_TOKENS: '100000' })).toBe(100_000);
  });

  it('returns undefined for zero or negative', () => {
    expect(resolveMaxTokens({ ZELARI_MISSION_MAX_TOKENS: '0' })).toBeUndefined();
    expect(resolveMaxTokens({ ZELARI_MISSION_MAX_TOKENS: '-5' })).toBeUndefined();
  });

  it('returns undefined for non-integer', () => {
    expect(resolveMaxTokens({ ZELARI_MISSION_MAX_TOKENS: 'abc' })).toBeUndefined();
    expect(resolveMaxTokens({ ZELARI_MISSION_MAX_TOKENS: '' })).toBeUndefined();
  });
});

// Sanity: existing resolve functions still work alongside the new ones.
describe('resolveMaxIterations / resolveMaxStall (regression)', () => {
  it('returns defaults when env is empty', () => {
    expect(resolveMaxIterations({})).toBeGreaterThan(0);
    expect(resolveMaxStall({})).toBeGreaterThanOrEqual(0);
  });
});
