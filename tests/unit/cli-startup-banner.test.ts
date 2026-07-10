/**
 * cli-startup-banner — smoke that StartupBanner module exports and brand
 * art remains non-empty (logo must be visible glyphs, not blank Braille).
 */
import { describe, it, expect } from 'vitest';
import { BRAND_LOGO_ASCII, BRAND_LOGO_COMPACT } from '../../src/cli/components/brandArt.js';

describe('CLI brand logo visibility', () => {
  it('ASCII full logo uses classic %-glyphs (Windows-safe)', () => {
    expect(BRAND_LOGO_ASCII).toMatch(/#|%|@/);
    expect(BRAND_LOGO_ASCII.split('\n').length).toBeGreaterThanOrEqual(8);
  });

  it('compact logo is short but still visible', () => {
    const lines = BRAND_LOGO_COMPACT.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => /#|%|@|\*/.test(l))).toBe(true);
  });
});
