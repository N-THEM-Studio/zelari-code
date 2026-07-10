/**
 * brandArt — Zelari CODE ASCII emblem for the TUI banner (top-right).
 *
 * Kept pure (no React) so the Static banner can compose a multi-line string
 * with the logo right-aligned without Ink layout constraints.
 *
 * Source: compact splash art (EMBLEM_MICRO lineage) — the classic %-glyph logo.
 */

/** Classic ASCII emblem (trimmed for right-alignment). */
export const BRAND_LOGO_ASCII = [
  '    -#%=',
  '   +%%%%#.',
  ' :#%%%%%%%-',
  ':%%@@@@@@@@=',
  '-%@@@@@@@@@@@+',
  ':%@@@@@@%@@@@@@=',
  '-%%@@@@@.+%@@%@+',
  ' -@@@@@@:%++%@=',
  '=*%@@@@@@:@@%=*@#+.',
  '%%%%%@@@@:+++-*%@@*',
  '.%%%%%@@@@@+%+=:%@@@@:',
  '*@@@@@@@@@@@@@%@@@@@@*',
].join('\n');

/** Compact 4-line mark for narrow terminals. */
export const BRAND_LOGO_COMPACT = [
  '  -#%=',
  ' +%%%%#.',
  ':%%@@@@=',
  '*@@@@@@*',
].join('\n');

/**
 * Compose a multi-line banner: left column (meta) top-aligned, logo block
 * right-aligned within `columns`.
 */
export function formatBannerWithLogoRight(opts: {
  leftLines: readonly string[];
  version: string;
  columns: number;
  /** Prefer compact logo when terminal is short/narrow. */
  compact?: boolean;
}): string {
  const logoSrc = opts.compact ? BRAND_LOGO_COMPACT : BRAND_LOGO_ASCII;
  const logoLines = logoSrc.split('\n');
  const logoWidth = Math.max(...logoLines.map((l) => l.length));
  const cols = Math.max(logoWidth + 20, Math.min(opts.columns, 120));

  const left = [...opts.leftLines];
  // Wordmark under the logo, right-aligned with the art.
  const wordmark = `ZELARI CODE  v${opts.version}`;
  const rightExtra = [wordmark];

  const rightBlock = [...logoLines, ...rightExtra];
  const rows = Math.max(left.length, rightBlock.length);
  const out: string[] = [];

  for (let i = 0; i < rows; i++) {
    const L = left[i] ?? '';
    const R = rightBlock[i] ?? '';
    if (!R) {
      out.push(L);
      continue;
    }
    // Right-align R within cols; leave at least 2 spaces after L when both present.
    const maxLeft = Math.max(0, cols - R.length - 2);
    const leftClipped = L.length > maxLeft ? L.slice(0, Math.max(0, maxLeft - 1)) + '…' : L;
    const pad = Math.max(2, cols - leftClipped.length - R.length);
    out.push(leftClipped + ' '.repeat(pad) + R);
  }
  return out.join('\n');
}
