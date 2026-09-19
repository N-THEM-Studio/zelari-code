/**
 * fuzzyMatch — dependency-free fuzzy filter for the interactive pickers.
 *
 * Matching (documented choice): the query is split on whitespace into terms
 * and EVERY term must match — a multi-term query is an AND, never an OR. Each
 * term matches when its characters appear IN ORDER anywhere in the candidate's
 * lowercased `searchText` (classic fuzzy-finder subsequence matching, the
 * fzf/`:Telescope` model): "kr gr" hits "kraken graph", "kwk" hits
 * "kraken-worktree-key". Terms run against the whole searchText, not per-field,
 * so a single term may span fields ("kraken /repo").
 *
 * Ranking (deliberately small and deterministic):
 *   1. a whole-query substring hit outranks scattered term hits;
 *   2. prefix hits outrank mid-string hits;
 *   3. earlier first-match and word-start hits score higher;
 *   4. adjacent (consecutive) matches score higher;
 *   5. shorter searchText wins remaining ties; original order breaks the rest.
 *
 * Pure: no DOM, no I/O, no deps — the pickers pass plain `{searchText}` items.
 */

/** Anything carrying the haystack the query is matched against. */
export interface FuzzyCandidate {
  /** Haystack. Absent/empty = never matches a non-empty query (no false hits). */
  searchText?: string;
}

/** True for characters that continue a word (`-`, `_`, `/`, `.` are separators). */
function isWordChar(ch: string): boolean {
  return /[a-z0-9]/i.test(ch);
}

/**
 * Score one term against one haystack (lowercased by the caller).
 * Returns null when the term is not a subsequence of `text`.
 */
function scoreTerm(term: string, text: string): number | null {
  let ti = 0;
  let last = -1;
  let first = -1;
  let score = 0;
  for (let i = 0; i < text.length && ti < term.length; i++) {
    if (text[i] !== term[ti]) continue;
    if (first < 0) first = i;
    // Word-start hits (index 0 or right after a separator) are the strongest
    // signal a fuzzy finder has: "gr" should find "graph", not "grep".
    score += i === 0 || !isWordChar(text[i - 1] ?? '') ? 3 : 1;
    if (last >= 0 && i === last + 1) score += 1; // consecutive run
    last = i;
    ti++;
  }
  if (ti < term.length) return null;
  if (first === 0) score += 4; // starts the haystack
  else if (first > 0 && !isWordChar(text[first - 1] ?? '')) score += 2; // word start
  // Earlier matches win: a hit at index 0-3 gets a small positional bonus.
  score += Math.max(0, 3 - first);
  return score;
}

/**
 * Score a full query (possibly several whitespace-separated terms) against a
 * haystack. `null` = no match; 0 = empty query (matches everything).
 */
export function fuzzyScore(query: string, searchText: string): number | null {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return 0;
  const text = searchText.toLowerCase();
  let total = 0;
  for (const term of terms) {
    const s = scoreTerm(term, text);
    if (s === null) return null; // AND: one failing term drops the candidate
    total += s;
  }
  const whole = query.toLowerCase().trim().replace(/\s+/g, ' ');
  // Exact-ish feel: the query as typed (spaces squashed) appearing verbatim.
  if (whole.length > 1 && text.includes(whole)) total += 20;
  else if (text.startsWith(terms[0]!)) total += 4; // prefix of the haystack
  return total;
}

/**
 * Rank `items` for `query`. An empty/whitespace-only query returns every item
 * in its ORIGINAL order (the picker then shows the unfiltered list); otherwise
 * matching items come back best-first, ties broken by original order.
 */
export function fuzzyMatch<T extends FuzzyCandidate>(
  query: string,
  items: readonly T[],
): T[] {
  const terms = query.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [...items];
  const ranked: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query, item.searchText ?? '');
    if (score === null) return;
    ranked.push({ item, score, index });
  });
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const la = (a.item.searchText ?? '').length;
    const lb = (b.item.searchText ?? '').length;
    if (la !== lb) return la - lb; // denser haystacks win
    return a.index - b.index; // stable
  });
  return ranked.map((r) => r.item);
}
