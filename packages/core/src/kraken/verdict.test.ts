import { describe, it, expect } from 'vitest';
import { parseVerifyVerdict, MAX_FINDINGS_CHARS } from './verdict.js';

describe('parseVerifyVerdict', () => {
  it('reads a PASS trailer', () => {
    const r = parseVerifyVerdict('Ran the tests, all green.\n\nVERDICT: PASS');
    expect(r.verdict).toBe('pass');
    expect(r.findings).toBe('Ran the tests, all green.');
  });

  it('reads a FAIL trailer and keeps the reasoning as findings', () => {
    const r = parseVerifyVerdict(
      'The slugify function does not strip accents.\nNo test covers unicode.\n\nVERDICT: FAIL',
    );
    expect(r.verdict).toBe('fail');
    expect(r.findings).toContain('does not strip accents');
    expect(r.findings).toContain('No test covers unicode');
    expect(r.findings).not.toContain('VERDICT');
  });

  it('returns unknown when there is no trailer at all', () => {
    const r = parseVerifyVerdict('Looks fine to me, I guess.');
    expect(r.verdict).toBe('unknown');
    // Findings are still retained: an unknown verdict is reported, not discarded.
    expect(r.findings).toBe('Looks fine to me, I guess.');
  });

  it('returns unknown for empty / nullish input', () => {
    expect(parseVerifyVerdict('').verdict).toBe('unknown');
    expect(parseVerifyVerdict('   \n  ').verdict).toBe('unknown');
    expect(parseVerifyVerdict(undefined).verdict).toBe('unknown');
    expect(parseVerifyVerdict(null).verdict).toBe('unknown');
  });

  it('lets the LAST trailer win when the model echoes the instruction first', () => {
    // The failure this guards: a first-match scan reads the echoed instruction
    // as the answer, inverting the gate on verbose runs.
    const r = parseVerifyVerdict(
      'I was asked to end with VERDICT: PASS or VERDICT: FAIL.\n' +
        'Checking now.\n' +
        'The acceptance criteria are not met.\n' +
        'VERDICT: FAIL',
    );
    expect(r.verdict).toBe('fail');
  });

  it('is case-insensitive on the keyword and the value', () => {
    expect(parseVerifyVerdict('ok\nverdict: fail').verdict).toBe('fail');
    expect(parseVerifyVerdict('ok\nVerdict: Pass').verdict).toBe('pass');
  });

  it('tolerates markdown decoration around the trailer', () => {
    expect(parseVerifyVerdict('ok\n**VERDICT: FAIL**').verdict).toBe('fail');
    expect(parseVerifyVerdict('ok\n- VERDICT: PASS').verdict).toBe('pass');
    expect(parseVerifyVerdict('ok\n> VERDICT: FAIL').verdict).toBe('fail');
  });

  it('tolerates trailing text on the verdict line', () => {
    const r = parseVerifyVerdict('checked\nVERDICT: FAIL — 3 gaps found');
    expect(r.verdict).toBe('fail');
  });

  it('does not match VERDICT mid-sentence', () => {
    // Only a line-initial trailer counts; prose mentioning the word must not
    // flip the gate. Both of these are `unknown`, which the executor treats as
    // non-blocking while still reporting that the trailer was missing.
    expect(parseVerifyVerdict('My final VERDICT: PASS was hard to reach.').verdict).toBe(
      'unknown',
    );
    expect(parseVerifyVerdict('I reached a verdict: pass is deserved.').verdict).toBe('unknown');
  });

  it('caps findings and marks the truncation', () => {
    const long = 'x'.repeat(MAX_FINDINGS_CHARS + 500);
    const r = parseVerifyVerdict(`${long}\nVERDICT: FAIL`);
    expect(r.verdict).toBe('fail');
    expect(r.findings.length).toBeLessThan(MAX_FINDINGS_CHARS + 40);
    expect(r.findings).toContain('[truncated]');
  });

  it('handles a trailer with nothing before it', () => {
    const r = parseVerifyVerdict('VERDICT: PASS');
    expect(r.verdict).toBe('pass');
    expect(r.findings).toBe('');
  });
});
