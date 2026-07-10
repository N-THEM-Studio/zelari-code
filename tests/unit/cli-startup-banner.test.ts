/**
 * cli-startup-banner — clean text header; logo art lives in Sidebar (Braille).
 */
import { describe, it, expect } from 'vitest';
import { BRAND_LOGO_ASCII, BRAND_LOGO_COMPACT } from '../../src/cli/components/brandArt.js';

describe('brandArt still available for optional uses', () => {
  it('ASCII full logo uses classic %-glyphs', () => {
    expect(BRAND_LOGO_ASCII).toMatch(/#|%|@/);
    expect(BRAND_LOGO_ASCII.split('\n').length).toBeGreaterThanOrEqual(8);
  });

  it('compact logo is short but still visible', () => {
    const lines = BRAND_LOGO_COMPACT.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => /#|%|@|\*/.test(l))).toBe(true);
  });
});
