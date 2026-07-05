/** Tokenize for Jaccard similarity (lowercase words ≥3 chars). */
export function tokenizeForSignature(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/\W+/)) {
    if (w.length >= 3) out.add(w);
  }
  return out;
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

/** Normalize check message for stable signatures (strip paths, lines, numbers). */
export function normalizeForSignature(checkId: string, message: string): string {
  const base = `${checkId} ${message}`
    .toLowerCase()
    .replace(/[A-Za-z]:\\[^\s]+/g, 'path')
    .replace(/\/[\w./-]+/g, 'path')
    .replace(/l\d{1,6}/gi, 'line')
    .replace(/\d+/g, 'n');
  return [...tokenizeForSignature(base)].sort().join(' ');
}
