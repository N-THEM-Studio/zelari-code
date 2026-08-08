/**
 * Kraken personas — tests.
 *
 * Covers:
 *   - `extractRequirementsBlock` (per-requirement JSON in a reply)
 *   - `parsePersonaVerdict` (trailer + table)
 *   - Persona registry: spec + conformance register on import
 *   - `isReviewerKind` returns true for verify, spec, conformance
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  parsePersonaVerdict,
  extractRequirementsBlock,
} from '../verdict.js';
import {
  registerPersona,
  getPersona,
  listPersonas,
  isReviewerKind,
  type Persona,
} from './registry.js';
import './specReviewer.js';
import './conformance.js';

describe('extractRequirementsBlock', () => {
  it('returns [] for an empty input', () => {
    expect(extractRequirementsBlock('')).toEqual([]);
    expect(extractRequirementsBlock(undefined)).toEqual([]);
    expect(extractRequirementsBlock(null)).toEqual([]);
  });

  it('returns [] when there is no JSON block', () => {
    expect(extractRequirementsBlock('Some text without a block.')).toEqual([]);
  });

  it('parses a well-formed requirements block', () => {
    const text = `
The implementation:
- exports slugify(input: string): string
- has a test covering unicode

\`\`\`json
{
  "requirements": [
    { "requirement": "exports slugify", "met": "pass", "evidence": "src/util.ts:12" },
    { "requirement": "unicode test", "met": "fail", "evidence": "tests/util.test.ts missing" }
  ]
}
\`\`\`

VERDICT: FAIL
`;
    expect(extractRequirementsBlock(text)).toEqual([
      { requirement: 'exports slugify', met: 'pass', evidence: 'src/util.ts:12' },
      { requirement: 'unicode test', met: 'fail', evidence: 'tests/util.test.ts missing' },
    ]);
  });

  it('takes the LAST JSON block when there are multiple', () => {
    const text = `
first draft:
\`\`\`json
{ "requirements": [{ "requirement": "x", "met": "fail" }] }
\`\`\`

final:
\`\`\`json
{ "requirements": [{ "requirement": "y", "met": "pass" }] }
\`\`\`
`;
    const out = extractRequirementsBlock(text);
    expect(out).toEqual([{ requirement: 'y', met: 'pass' }]);
  });

  it('tolerates malformed JSON (returns [] rather than throwing)', () => {
    const text = '```json\n{ "requirements": [\n```\nVERDICT: PASS';
    expect(extractRequirementsBlock(text)).toEqual([]);
  });

  it('normalizes the met field to pass/fail/unknown', () => {
    const text = `\`\`\`json
{ "requirements": [
  { "requirement": "a", "met": "true" },
  { "requirement": "b", "met": "false" },
  { "requirement": "c", "met": "PASS" },
  { "requirement": "d", "met": "???" }
] }
\`\`\``;
    const out = extractRequirementsBlock(text);
    expect(out.map((r) => r.met)).toEqual(['pass', 'fail', 'pass', 'unknown']);
  });

  it('skips rows that are missing the requirement field', () => {
    const text = `\`\`\`json
{ "requirements": [
  { "requirement": "ok", "met": "pass" },
  { "met": "pass" }
] }
\`\`\``;
    const out = extractRequirementsBlock(text);
    expect(out).toHaveLength(1);
    expect(out[0].requirement).toBe('ok');
  });
});

describe('parsePersonaVerdict', () => {
  it('returns pass + findings when trailer is PASS', () => {
    const r = parsePersonaVerdict('All good.\n\nVERDICT: PASS');
    expect(r.verdict).toBe('pass');
    expect(r.findings).toContain('All good');
    expect(r.requirements).toEqual([]);
  });

  it('returns fail + findings when trailer is FAIL with a table', () => {
    const text = `The slugify function does not strip accents.
No test covers unicode.

\`\`\`json
{ "requirements": [
  { "requirement": "strips accents", "met": "fail", "evidence": "src/util.ts:12" }
] }
\`\`\`

VERDICT: FAIL`;
    const r = parsePersonaVerdict(text);
    expect(r.verdict).toBe('fail');
    expect(r.findings).toContain('does not strip accents');
    expect(r.requirements).toEqual([
      { requirement: 'strips accents', met: 'fail', evidence: 'src/util.ts:12' },
    ]);
  });

  it('returns unknown when there is no trailer', () => {
    const r = parsePersonaVerdict('I forgot the trailer.');
    expect(r.verdict).toBe('unknown');
  });

  it('attaches a weaknessScore in [0, 1] computed from the free text', () => {
    // Bennett 2023: weakness is "how little the reviewer's free-text claims".
    // Vague prose → high weakness (close to 1); pinned specifics → low (close to 0).
    const vague = parsePersonaVerdict('All good.\n\nVERDICT: PASS');
    const pinned = parsePersonaVerdict(
      'I GUARANTEED EXACTLY line 42 uses version 1.2.3 at /src/util.ts. MUST always.\n\nVERDICT: PASS',
    );
    expect(vague.weaknessScore).toBeGreaterThan(0.5);
    expect(pinned.weaknessScore).toBeLessThan(0.5);
    expect(vague.weaknessScore).toBeGreaterThan(pinned.weaknessScore);
    expect(vague.weaknessScore).toBeGreaterThanOrEqual(0);
    expect(vague.weaknessScore).toBeLessThanOrEqual(1);
  });

  it('weaknessScore is 1 (maximally weak) for the no-trailer / all-empty case', () => {
    expect(parsePersonaVerdict('').weaknessScore).toBe(1);
    expect(parsePersonaVerdict(undefined).weaknessScore).toBe(1);
    expect(parsePersonaVerdict(null).weaknessScore).toBe(1);
    expect(parsePersonaVerdict('   \n  ').weaknessScore).toBe(1);
  });

  it('weaknessScore is independent of the verdict (gate and metadata are separate)', () => {
    // A FAIL and a PASS with the same prose should get the same weakness
    // score — the gate is the trailer, the weakness is the *texture* of
    // the prose. This is the contract: weakness never overrides the gate.
    const prose =
      'I MUST always EXACTLY at line 42 version 1.2.3. GUARANTEED. REQUIRES. ' +
      'MANDATORY. PRECISELY. The file is at /x/y/z.';
    const a = parsePersonaVerdict(`${prose}\n\nVERDICT: PASS`);
    const b = parsePersonaVerdict(`${prose}\n\nVERDICT: FAIL`);
    expect(a.verdict).toBe('pass');
    expect(b.verdict).toBe('fail');
    expect(a.weaknessScore).toBe(b.weaknessScore);
  });
});

describe('persona registry', () => {
  beforeAll(() => {
    // The spec + conformance personas register on import (handled by
    // the top-level imports above). Add a synthetic 'oracle' persona
    // here to exercise registerPersona / getPersona directly.
    const oracle: Persona = {
      kind: 'verify' as never, // we use a no-op kind for the test
      label: 'oracle-test',
      description: 'test fixture',
      systemPrompt: 'fixture',
    };
    // Skip the 'verify' override — keep the built-in one in place.
    void oracle;
  });

  it('has spec and conformance registered after import', () => {
    const spec = getPersona('spec');
    expect(spec).toBeDefined();
    expect(spec?.label).toBe('spec-reviewer');
    expect(spec?.systemPrompt).toMatch(/CONSERVATIVE/i);
    const conf = getPersona('conformance');
    expect(conf).toBeDefined();
    expect(conf?.label).toBe('conformance-reviewer');
    expect(conf?.systemPrompt).toMatch(/LITERAL/i);
  });

  it('listPersonas returns at least 2 (spec + conformance)', () => {
    const all = listPersonas();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const kinds = all.map((p) => p.kind);
    expect(kinds).toContain('spec');
    expect(kinds).toContain('conformance');
  });

  it('registerPersona is idempotent (re-registering overwrites)', () => {
    const before = getPersona('spec');
    registerPersona({
      kind: 'spec',
      label: 'spec-test',
      description: 'replaced',
      systemPrompt: 'replaced',
    });
    const after = getPersona('spec');
    expect(after?.label).toBe('spec-test');
    expect(after?.systemPrompt).toBe('replaced');
    expect(before).not.toBe(after);
    // Restore the original so other tests aren't affected.
    registerPersona(before!);
  });
});

describe('isReviewerKind', () => {
  it('returns true for verify, spec, conformance', () => {
    expect(isReviewerKind('verify')).toBe(true);
    expect(isReviewerKind('spec')).toBe(true);
    expect(isReviewerKind('conformance')).toBe(true);
  });
  it('returns false for non-reviewer kinds', () => {
    expect(isReviewerKind('explore')).toBe(false);
    expect(isReviewerKind('general')).toBe(false);
    expect(isReviewerKind('fix')).toBe(false);
    expect(isReviewerKind('merge')).toBe(false);
  });
});
