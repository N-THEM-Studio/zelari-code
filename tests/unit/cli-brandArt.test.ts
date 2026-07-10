import { describe, it, expect } from 'vitest';
import {
  formatBannerWithLogoRight,
  BRAND_LOGO_ASCII,
  BRAND_LOGO_COMPACT,
} from '../../src/cli/components/brandArt.js';

describe('formatBannerWithLogoRight', () => {
  it('places logo lines to the right of left meta', () => {
    const out = formatBannerWithLogoRight({
      leftLines: ['zelari-code · grok/x', 'cwd: ~/proj'],
      version: '1.8.0',
      columns: 80,
      compact: true,
    });
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    // First line has left content and some logo glyph on the right.
    expect(lines[0]).toMatch(/zelari-code/);
    expect(lines[0]).toMatch(/#|%|@|\*/);
    // Wordmark on a later line, right-side.
    expect(out).toMatch(/ZELARI CODE\s+v1\.8\.0/);
  });

  it('uses full logo when not compact', () => {
    const out = formatBannerWithLogoRight({
      leftLines: ['left'],
      version: '1.0.0',
      columns: 100,
      compact: false,
    });
    // Full logo has more rows than compact.
    expect(out.split('\n').length).toBeGreaterThan(BRAND_LOGO_COMPACT.split('\n').length);
    expect(out.split('\n').length).toBeGreaterThanOrEqual(BRAND_LOGO_ASCII.split('\n').length);
  });

  it('does not throw on narrow columns', () => {
    expect(() =>
      formatBannerWithLogoRight({
        leftLines: ['a'.repeat(40)],
        version: '1',
        columns: 40,
        compact: true,
      }),
    ).not.toThrow();
  });
});
