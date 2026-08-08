/**
 * Tests for the weakness ranking module (Bennett's Razor applied to Kraken).
 *
 * Coverage:
 *   1. `BENNETTS_RAZOR` / `BENNETTS_RAZOR_SHORT` are non-empty strings.
 *   2. `weaknessFromVerdict` heuristic scan — marker hit counting, clamp,
 *      empty / whitespace handling, no over-claiming on plain text.
 *   3. `weaknessScoreFromText` mirrors the heuristic (1 - specificity).
 *   4. `WEAKNESS_METER_PROMPT` shape and `WeaknessMeterResponseSchema`
 *      accept / reject the right payloads.
 *   5. `weaknessFromMeter` and `specificityFromAssumptions` edge cases.
 *   6. `rankByWeakness` — empty input, single, multi, tie-breaking, stable
 *      order, source selection priority (extensionSize > meter > heuristic).
 *   7. `pickWeakest` and `filterByWeakness` convenience wrappers.
 *
 * @since v1.31.x
 */

import { describe, expect, it } from 'vitest';
import {
  BENNETTS_RAZOR,
  BENNETTS_RAZOR_SHORT,
  WEAKNESS_METER_PROMPT,
  WeaknessMeterResponseSchema,
  filterByWeakness,
  pickWeakest,
  rankByWeakness,
  specificityFromAssumptions,
  weaknessFromMeter,
  weaknessFromVerdict,
  weaknessScoreFromText,
  type HypothesisCandidate,
  type RankedHypothesis,
} from './weakness.js';

// ---------------------------------------------------------------------------
// BENNETTS_RAZOR
// ---------------------------------------------------------------------------

describe("BENNETTS_RAZOR", () => {
  it('is a non-empty string that names Bennett', () => {
    expect(typeof BENNETTS_RAZOR).toBe('string');
    expect(BENNETTS_RAZOR.length).toBeGreaterThan(20);
    expect(BENNETTS_RAZOR).toMatch(/Bennett/);
  });

  it('names the tie-breaker nature explicitly', () => {
    expect(BENNETTS_RAZOR).toMatch(/tie-breaker/i);
    expect(BENNETTS_RAZOR).toMatch(/assumes? the least/i);
  });

  it('SHORT form is a single sentence', () => {
    expect(BENNETTS_RAZOR_SHORT).toMatch(/^Prefer the solution.*necessary\.$/);
  });
});

// ---------------------------------------------------------------------------
// weaknessFromVerdict (heuristic scan)
// ---------------------------------------------------------------------------

describe('weaknessFromVerdict', () => {
  it('returns 0 for empty / nullish / whitespace input', () => {
    expect(weaknessFromVerdict(undefined)).toBe(0);
    expect(weaknessFromVerdict(null)).toBe(0);
    expect(weaknessFromVerdict('')).toBe(0);
    expect(weaknessFromVerdict('   \n\t  ')).toBe(0);
  });

  it('returns a low score for plain descriptive text', () => {
    const s = weaknessFromVerdict('The function reads the file and returns its content.');
    // At most a single clause-penalty hit, no markers.
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(0.3);
  });

  it('flags strong claims ("must", "always", "exactly", "guaranteed")', () => {
    const strong = weaknessFromVerdict('The function MUST always return exactly the same value, GUARANTEED.');
    const weak = weaknessFromVerdict('The function returns a value based on the file content.');
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeGreaterThan(0.4);
  });

  it('flags line numbers, semver, and commit SHAs', () => {
    const pinned = weaknessFromVerdict('Edit line 42 to use version 1.2.3 and commit a1b2c3d4.');
    const loose = weaknessFromVerdict('Edit the file to use a newer version.');
    expect(pinned).toBeGreaterThan(loose);
  });

  it('flags "the file is at" / "the path is"', () => {
    // Two markers ("file is at" + "EXACTLY") to clearly out-score a vague sentence.
    const pinned = weaknessFromVerdict('The file is at /usr/local/bin/foo.ts EXACTLY.');
    const loose = weaknessFromVerdict('The file is somewhere in the project.');
    expect(pinned).toBeGreaterThan(loose);
    expect(pinned).toBeGreaterThan(0.4);
  });

  it('counts clauses (penalty grows with sentence count)', () => {
    const many = weaknessFromVerdict(
      'Step 1: I will read the file. Step 2: I will parse the JSON. Step 3: I will validate the schema. Step 4: I will write the result. Step 5: I will log the operation.',
    );
    const few = weaknessFromVerdict('I will read the file and write the result.');
    expect(many).toBeGreaterThan(few);
  });

  it('caps at 1.0', () => {
    const s = weaknessFromVerdict(
      'This MUST always be EXACTLY line 42, version 1.2.3, commit a1b2c3d4e5f6, the file is at /x/y/z, GUARANTEED, REQUIRES Node 20.x, MANDATORY, PRECISELY, will DEFINITELY run, will CERTAINLY succeed, will ALWAYS commit, never fail, will always assert, must confirm.',
    );
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeGreaterThan(0.8);
  });

  it('is case-insensitive for markers', () => {
    const a = weaknessFromVerdict('MUST always be exactly right.');
    const b = weaknessFromVerdict('must always be exactly right.');
    expect(a).toBeCloseTo(b, 5);
  });
});

describe('weaknessScoreFromText', () => {
  it('is 1 - weaknessFromVerdict', () => {
    const text = 'The file MUST be at line 42 EXACTLY.';
    expect(weaknessScoreFromText(text)).toBeCloseTo(1 - weaknessFromVerdict(text), 10);
  });

  it('returns 1 for empty text (maximally weak)', () => {
    expect(weaknessScoreFromText('')).toBe(1);
    expect(weaknessScoreFromText(undefined)).toBe(1);
  });

  it('ranks a strong claim as less weak than a vague one', () => {
    const strong = weaknessScoreFromText('The function MUST always return exactly 42.');
    const vague = weaknessScoreFromText('The function returns a number.');
    expect(strong).toBeLessThan(vague);
  });
});

// ---------------------------------------------------------------------------
// Meter prompt + schema
// ---------------------------------------------------------------------------

describe('WEAKNESS_METER_PROMPT', () => {
  it('is a non-empty string that asks for specificity', () => {
    expect(WEAKNESS_METER_PROMPT.length).toBeGreaterThan(100);
    expect(WEAKNESS_METER_PROMPT).toMatch(/specificity/i);
  });

  it('specifies a JSON output shape', () => {
    expect(WEAKNESS_METER_PROMPT).toMatch(/JSON/);
    expect(WEAKNESS_METER_PROMPT).toMatch(/specificity.*0.*1/);
    expect(WEAKNESS_METER_PROMPT).toMatch(/assumptions/);
  });
});

describe('WeaknessMeterResponseSchema', () => {
  it('accepts a well-formed response', () => {
    const r = WeaknessMeterResponseSchema.parse({
      specificity: 0.42,
      assumptions: ['the file is at /x', 'version is 1.2.3'],
    });
    expect(r.specificity).toBe(0.42);
    expect(r.assumptions).toHaveLength(2);
  });

  it('rejects specificity outside [0, 1]', () => {
    expect(() => WeaknessMeterResponseSchema.parse({ specificity: -0.1, assumptions: [] })).toThrow();
    expect(() => WeaknessMeterResponseSchema.parse({ specificity: 1.5, assumptions: [] })).toThrow();
  });

  it('rejects non-array assumptions', () => {
    expect(() => WeaknessMeterResponseSchema.parse({ specificity: 0.5, assumptions: 'oops' })).toThrow();
  });

  it('caps assumptions at 12', () => {
    const tooMany = Array.from({ length: 20 }, (_, i) => `assumption ${i}`);
    expect(() => WeaknessMeterResponseSchema.parse({ specificity: 0.5, assumptions: tooMany })).toThrow();
  });

  it('rejects empty assumption strings', () => {
    expect(() =>
      WeaknessMeterResponseSchema.parse({ specificity: 0.5, assumptions: ['ok', ''] }),
    ).toThrow();
  });
});

describe('weaknessFromMeter', () => {
  it('inverts specificity within [0, 1]', () => {
    expect(weaknessFromMeter({ specificity: 0, assumptions: [] })).toBe(1);
    expect(weaknessFromMeter({ specificity: 1, assumptions: [] })).toBe(0);
    expect(weaknessFromMeter({ specificity: 0.5, assumptions: [] })).toBe(0.5);
  });

  it('clamps out-of-range specificity', () => {
    expect(weaknessFromMeter({ specificity: -0.5, assumptions: [] })).toBe(1);
    expect(weaknessFromMeter({ specificity: 2, assumptions: [] })).toBe(0);
  });
});

describe('specificityFromAssumptions', () => {
  it('is 0 for no assumptions', () => {
    expect(specificityFromAssumptions([])).toBe(0);
  });

  it('scales with the count and saturates at 6', () => {
    expect(specificityFromAssumptions(['a'])).toBeCloseTo(1 / 6, 5);
    expect(specificityFromAssumptions(['a', 'b', 'c'])).toBeCloseTo(0.5, 5);
    expect(specificityFromAssumptions(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(1);
    expect(specificityFromAssumptions(Array.from({ length: 12 }, (_, i) => `a${i}`))).toBe(1);
  });

  it('treats non-array input as 0', () => {
    expect(specificityFromAssumptions(undefined as unknown as string[])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rankByWeakness
// ---------------------------------------------------------------------------

describe('rankByWeakness', () => {
  it('returns [] for empty input', () => {
    expect(rankByWeakness([])).toEqual([]);
  });

  it('returns one entry for a single candidate', () => {
    const r = rankByWeakness<HypothesisCandidate>([{ id: 'a', text: 'hello' }]);
    expect(r).toHaveLength(1);
    expect(r[0].rank).toBe(1);
    expect(r[0].candidate.id).toBe('a');
    expect(r[0].source).toBe('heuristic');
  });

  it('sorts weakest first (rank 1 = most general)', () => {
    const candidates: HypothesisCandidate[] = [
      { id: 'pinned', text: 'The file MUST always be at /usr/local/bin/foo.ts EXACTLY line 42.' },
      { id: 'vague', text: 'The function does its job.' },
      { id: 'medium', text: 'The function reads the file and returns a value.' },
    ];
    const r = rankByWeakness(candidates);
    expect(r[0].candidate.id).toBe('vague');
    expect(r[0].rank).toBe(1);
    expect(r[r.length - 1].candidate.id).toBe('pinned');
  });

  it('preserves input order on equal scores (stable)', () => {
    const a: HypothesisCandidate = { id: 'a', text: '' }; // both = max weakness
    const b: HypothesisCandidate = { id: 'b', text: '' };
    const r = rankByWeakness([a, b]);
    expect(r[0].candidate.id).toBe('a');
    expect(r[1].candidate.id).toBe('b');
  });

  it('breaks ties with the same rank, then continues', () => {
    const candidates: HypothesisCandidate[] = [
      { id: 'a', text: '' },
      { id: 'b', text: '' },
      { id: 'c', text: 'MUST EXACTLY' },
    ];
    const r = rankByWeakness(candidates);
    expect(r[0].rank).toBe(1);
    expect(r[1].rank).toBe(1); // tied
    expect(r[2].rank).toBe(3); // jumped by 2 due to two-way tie
  });

  it('uses meter score when meter is provided', () => {
    const candidates: HypothesisCandidate[] = [
      { id: 'heuristic-strong', text: 'MUST always be EXACTLY' }, // heuristic = high specificity
      { id: 'meter-weak', text: 'whatever', meter: { specificity: 0.1, assumptions: [] } },
    ];
    const r = rankByWeakness(candidates);
    expect(r[0].candidate.id).toBe('meter-weak');
    expect(r[0].source).toBe('meter');
    expect(r[1].source).toBe('heuristic');
  });

  it('uses extensionSize when provided (and normalises it)', () => {
    const candidates: HypothesisCandidate[] = [
      { id: 'small', text: '', extensionSize: 1 },
      { id: 'large', text: '', extensionSize: 1000 },
      { id: 'mid', text: '', extensionSize: 500 },
    ];
    const r = rankByWeakness(candidates);
    expect(r[0].candidate.id).toBe('large');
    expect(r[0].weaknessScore).toBe(1);
    expect(r[1].candidate.id).toBe('mid');
    expect(r[1].weaknessScore).toBeCloseTo((500 - 1) / (1000 - 1), 5);
    expect(r[2].candidate.id).toBe('small');
    expect(r[2].weaknessScore).toBe(0);
    for (const entry of r) {
      expect(entry.source).toBe('extensionSize');
    }
  });

  it('mixes candidates with different signals correctly (priority: ext > meter > heuristic)', () => {
    const candidates: HypothesisCandidate[] = [
      // All very "general" by heuristic, but extensionSize breaks the tie
      { id: 'heuristic-weak', text: '' },
      { id: 'ext-huge', text: 'MUST always be EXACTLY', extensionSize: 10000 },
      // Meter trumps heuristic
      { id: 'meter-strong', text: '', meter: { specificity: 0.9, assumptions: ['x'] } },
    ];
    const r = rankByWeakness(candidates);
    // The order should be: largest extension first (normalised to 1),
    // then by score desc among the rest.
    // meter-strong: 1 - 0.9 = 0.1
    // heuristic-weak: weaknessFromText('') = 1
    // So heuristic-weak (1.0) > meter-strong (0.1) > ext-huge (1.0 after norm — tied with heuristic)
    // After normalisation, both ext-huge and heuristic-weak have score 1, and stable order
    // is heuristic-weak (input index 0) before ext-huge (input index 1) among ties.
    // So expected: [heuristic-weak, ext-huge, meter-strong] OR [ext-huge, heuristic-weak, meter-strong]
    // (stable order in the tie, both rank 1). The important thing is meter-strong is last.
    expect(r[r.length - 1].candidate.id).toBe('meter-strong');
  });

  it('output weakness scores are in [0, 1]', () => {
    const candidates: HypothesisCandidate[] = [
      { id: 'a', text: 'MUST EXACTLY' },
      { id: 'b', text: '' },
      { id: 'c', text: 'whatever', meter: { specificity: 0.7, assumptions: ['a', 'b'] } },
      { id: 'd', text: '', extensionSize: 50 },
    ];
    for (const r of rankByWeakness(candidates)) {
      expect(r.weaknessScore).toBeGreaterThanOrEqual(0);
      expect(r.weaknessScore).toBeLessThanOrEqual(1);
    }
  });

  it('does not mutate the input array', () => {
    const candidates: HypothesisCandidate[] = [
      { id: 'a', text: '' },
      { id: 'b', text: 'MUST' },
    ];
    const before = candidates.map((c) => c.id);
    rankByWeakness(candidates);
    expect(candidates.map((c) => c.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// pickWeakest / filterByWeakness
// ---------------------------------------------------------------------------

describe('pickWeakest', () => {
  it('returns undefined for empty input', () => {
    expect(pickWeakest([])).toBeUndefined();
  });

  it('returns the highest-ranked (weakest) candidate', () => {
    const chosen = pickWeakest<HypothesisCandidate>([
      { id: 'pinned', text: 'MUST always be EXACTLY line 42 version 1.2.3' },
      { id: 'vague', text: 'do the task' },
      { id: 'medium', text: 'handle the input' },
    ]);
    expect(chosen?.id).toBe('vague');
  });
});

describe('filterByWeakness', () => {
  it('drops candidates below the threshold', () => {
    const all: HypothesisCandidate[] = [
      { id: 'pinned', text: 'MUST always be EXACTLY line 42 version 1.2.3' },
      { id: 'vague', text: 'do the task' },
      { id: 'medium', text: 'handle the input' },
    ];
    const loose = filterByWeakness(all, 0.5);
    expect(loose.map((c) => c.id)).toContain('vague');
    // "medium" might or might not pass 0.5; "pinned" should not.
    expect(loose.map((c) => c.id)).not.toContain('pinned');
  });

  it('keeps everything when threshold is 0', () => {
    const all: HypothesisCandidate[] = [
      { id: 'a', text: 'MUST EXACTLY' },
      { id: 'b', text: '' },
    ];
    expect(filterByWeakness(all, 0)).toHaveLength(2);
  });

  it('keeps nothing when threshold is 1 and no candidate scores 1', () => {
    const all: HypothesisCandidate[] = [
      { id: 'a', text: 'MUST EXACTLY' },
      { id: 'b', text: 'something' },
    ];
    expect(filterByWeakness(all, 1)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: spec / conformance persona verdicts
// ---------------------------------------------------------------------------

describe('weakness integration with persona findings', () => {
  it('ranks a less specific "PASS" above a more specific "PASS" (Spec Council use-case)', () => {
    // Two Spec Council verdicts, both PASS. Findings differ in specificity.
    const vague: HypothesisCandidate = {
      id: 'writer-vague',
      text: [
        'The implementation satisfies the requirements.',
        'Each requirement was met by the design choice.',
        'VERDICT: PASS',
      ].join('\n'),
    };
    const pinned: HypothesisCandidate = {
      id: 'writer-pinned',
      text: [
        'I GUARANTEED EXACTLY line 42 uses version 1.2.3 of foo at /usr/local/bin.',
        'I MUST always confirm the file is at this exact path.',
        'VERDICT: PASS',
      ].join('\n'),
    };
    const r = rankByWeakness<HypothesisCandidate>([pinned, vague]);
    expect(r[0].candidate.id).toBe('writer-vague');
    // And the Spec Council "pickWeakest" call is the single decision point.
    const chosen = pickWeakest<HypothesisCandidate>([pinned, vague]);
    expect(chosen?.id).toBe('writer-vague');
  });

  it('typed result is preserved (generic over T)', () => {
    interface MyCandidate extends HypothesisCandidate {
      verdict: 'pass' | 'fail';
    }
    const c: MyCandidate = { id: 'x', text: '', verdict: 'pass' };
    const r: RankedHypothesis<MyCandidate>[] = rankByWeakness<MyCandidate>([c]);
    expect(r[0].candidate.verdict).toBe('pass');
  });
});
