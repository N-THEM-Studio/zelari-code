/**
 * Quality-bar / blind A/B for the critic. The critic never sees builder
 * identity. A single `bar` is the gold artifact on disk. Two bars are
 * shuffled into unlabeled A/B.
 */
export interface BlindPair {
  A: string;
  B: string;
  /** Original items[0] landed on this label. */
  firstLabel: 'A' | 'B';
}

export function assignBlindLabels(
  items: readonly [string, string],
  rand: () => number = Math.random,
): BlindPair {
  if (rand() < 0.5) {
    return { A: items[0], B: items[1], firstLabel: 'A' };
  }
  return { A: items[1], B: items[0], firstLabel: 'B' };
}

export function qualityBarSection(
  bars: readonly string[] | undefined,
  rand: () => number = Math.random,
): string {
  if (!bars || bars.length === 0) return '';
  if (bars.length === 1) {
    return [
      '## Quality bar (blind)',
      'Inspect this reference on disk. PASS only if the work in Scope meets or beats it.',
      'Do not assume the new files are better — compare concretely.',
      `- ${bars[0]}`,
    ].join('\n');
  }
  const pair = assignBlindLabels([bars[0]!, bars[1]!], rand);
  return [
    '## Blind A/B',
    'Two unlabeled artifacts on disk. Compare them against the piece acceptance.',
    'Do not assume which is newer or which you are "supposed" to prefer.',
    `A: ${pair.A}`,
    `B: ${pair.B}`,
    'Also emit: WINNER: A | B | TIE',
  ].join('\n');
}

const WINNER_RE = /\bWINNER:\s*(A|B|TIE)\b/i;

export function parseBlindWinner(text: string): 'A' | 'B' | 'TIE' | undefined {
  const m = WINNER_RE.exec(text);
  if (!m) return undefined;
  const v = m[1]!.toUpperCase();
  if (v === 'A' || v === 'B' || v === 'TIE') return v;
  return undefined;
}
