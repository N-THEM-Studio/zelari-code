import { describe, expect, it } from 'vitest';
import {
  buildLanguagePolicyModule,
  buildLanguagePolicySplit,
  STABLE_LANGUAGE_DIRECTIVE,
} from './languagePolicy.js';

describe('buildLanguagePolicySplit — cache-stable language directive', () => {
  it('keeps the system module byte-identical whatever language the turn is in', () => {
    const it = buildLanguagePolicySplit('puoi sistemare il test che fallisce?', {});
    const en = buildLanguagePolicySplit('can you fix the failing test?', {});
    expect(it.module.content).toBe(STABLE_LANGUAGE_DIRECTIVE);
    expect(en.module.content).toBe(it.module.content);
    expect(it.module.type).toBe(en.module.type);
    expect(it.module.priority).toBe(en.module.priority);
  });

  it('carries the detected language on a per-request context line', () => {
    expect(buildLanguagePolicySplit('puoi sistemare il test che fallisce?', {}).contextLine).toContain('Italian');
    expect(buildLanguagePolicySplit('can you fix the failing test?', {}).contextLine).toContain('English');
  });

  it('a pinned ZELARI_RESPONSE_LANG keeps the full directive (already stable)', () => {
    const pinned = buildLanguagePolicySplit('can you fix the failing test in the parser module?', { ZELARI_RESPONSE_LANG: 'it' });
    expect(pinned.module.content).toBe(buildLanguagePolicyModule('it').content);
    expect(pinned.contextLine).toBe('');
  });

  it('ZELARI_LANGUAGE_DIRECTIVE=system restores the per-turn system directive', () => {
    const legacy = buildLanguagePolicySplit('can you fix the failing test in the parser module?', { ZELARI_LANGUAGE_DIRECTIVE: 'system' });
    expect(legacy.module.content).toBe(buildLanguagePolicyModule('en').content);
    expect(legacy.contextLine).toBe('');
  });
});
