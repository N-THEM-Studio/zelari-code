/**
 * policyLoadMode — pure resolution tests (P0.B). Every input is passed
 * explicitly, so these NEVER mutate process.env.
 */
import { describe, expect, it } from 'vitest';
import {
  activePolicyLoadMode,
  activePolicyLoadSurface,
  POLICY_LOAD_BLOCK_REASON,
  POLICY_LOAD_EXIT_CODE,
  POLICY_LOAD_MODE_ENV,
  resolvePolicyLoadMode,
  setActivePolicyLoadSurface,
} from './policyLoadMode.js';

const base = { surface: 'tui' as const };

describe('resolvePolicyLoadMode (P0.B)', () => {
  it('defaults: headless + mission are strict, TUI is permissive', () => {
    expect(resolvePolicyLoadMode({ surface: 'headless' })).toBe('strict');
    expect(resolvePolicyLoadMode({ surface: 'mission' })).toBe('strict');
    expect(resolvePolicyLoadMode(base)).toBe('permissive');
  });

  it('CI=1 tightens even the interactive TUI default', () => {
    expect(resolvePolicyLoadMode({ ...base, ci: '1' })).toBe('strict');
    expect(resolvePolicyLoadMode({ ...base, ci: 'true' })).toBe('strict');
    // Non-truthy spellings must NOT flip the default.
    expect(resolvePolicyLoadMode({ ...base, ci: '0' })).toBe('permissive');
    expect(resolvePolicyLoadMode({ ...base, ci: '' })).toBe('permissive');
    expect(resolvePolicyLoadMode({ ...base, ci: undefined })).toBe('permissive');
  });

  it('env override wins over defaults — both directions', () => {
    // permissive beats a strict-by-default surface…
    expect(resolvePolicyLoadMode({ surface: 'headless', override: 'permissive' })).toBe('permissive');
    expect(resolvePolicyLoadMode({ surface: 'mission', override: ' Permissive ' })).toBe('permissive');
    // …and strict beats the permissive TUI default (with or without CI).
    expect(resolvePolicyLoadMode({ ...base, override: 'strict' })).toBe('strict');
    expect(resolvePolicyLoadMode({ ...base, override: 'STRICT', ci: '0' })).toBe('strict');
  });

  it('invalid override values are ignored and fall back to the surface default', () => {
    expect(resolvePolicyLoadMode({ surface: 'headless', override: 'bogus' })).toBe('strict');
    expect(resolvePolicyLoadMode(base)).toBe('permissive'); // typo never flips strictness
  });
});

describe('active-surface seam', () => {
  it('runHeadless-style registration flips activePolicyLoadMode to strict; env injected, not mutated', () => {
    setActivePolicyLoadSurface('headless');
    try {
      expect(activePolicyLoadSurface()).toBe('headless');
      expect(activePolicyLoadMode({})).toBe('strict');
      expect(activePolicyLoadMode({ [POLICY_LOAD_MODE_ENV]: 'permissive' })).toBe('permissive');
      expect(activePolicyLoadMode({ CI: '1', [POLICY_LOAD_MODE_ENV]: 'permissive' })).toBe(
        'permissive',
      );
      // Back to the default (TUI) host: permissive unless ambient CI demands it.
      expect(activePolicyLoadMode({})).not.toBe('permissive'); // still 'headless' here
      setActivePolicyLoadSurface('tui');
      expect(activePolicyLoadMode({})).toBe('permissive');
    } finally {
      setActivePolicyLoadSurface('tui');
    }
  });

  it('block constants document the exit-code integration point', () => {
    expect(POLICY_LOAD_BLOCK_REASON).toBe('policy-load-failed');
    // Exit 2 = "runtime error" in the headless map; 4 stays completion-gate-only.
    expect(POLICY_LOAD_EXIT_CODE).toBe(2);
  });
});
