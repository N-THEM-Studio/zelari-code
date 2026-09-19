/**
 * fuzzyMatch.test.ts — pure multi-term AND fuzzy matcher for the pickers.
 *
 * The interactive key handling needs raw-mode stdin (covered by the existing
 * picker tests / manual verification); everything here is pure logic.
 */
import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyScore } from './fuzzyMatch.js';

const items = (...texts: string[]): { searchText: string }[] =>
  texts.map((searchText) => ({ searchText }));

describe('fuzzyMatch — empty query', () => {
  it('returns every item in its original order', () => {
    const list = items('alpha', 'beta', 'gamma');
    expect(fuzzyMatch('', list)).toEqual(list);
    expect(fuzzyMatch('   ', list)).toEqual(list);
    expect(fuzzyMatch('', list)).not.toBe(list); // a copy, callers can mutate
  });
});

describe('fuzzyMatch — single term', () => {
  it('matches a case-insensitive subsequence', () => {
    const list = items('kraken-worktree-key', 'council-runner');
    expect(fuzzyMatch('KWK', list).map((i) => i.searchText)).toEqual([
      'kraken-worktree-key',
    ]);
  });

  it('matches a plain substring anywhere in the haystack', () => {
    const list = items('grok-4', 'glm-4.6', 'deepseek-chat');
    expect(fuzzyMatch('seek', list).map((i) => i.searchText)).toEqual([
      'deepseek-chat',
    ]);
  });

  it('drops candidates whose characters are out of order', () => {
    const list = items('abc');
    expect(fuzzyMatch('cba', list)).toEqual([]);
  });
});

describe('fuzzyMatch — multi-term AND', () => {
  it('requires EVERY term to match', () => {
    const list = items('kraken /home/zelari', 'kraken /var/log', 'council /home/zelari');
    const hit = fuzzyMatch('kraken home', list).map((i) => i.searchText);
    expect(hit).toEqual(['kraken /home/zelari']);
  });

  it('does not match when one term is missing', () => {
    const list = items('kraken /repo/zelari');
    expect(fuzzyMatch('kraken nope', list)).toEqual([]);
  });

  it('lets one term span fields (the terms are independent)', () => {
    const list = items('fix login bug kraken/v1 C:\\dev\\zelari-code');
    expect(fuzzyMatch('login kraken dev', list)).toHaveLength(1);
  });
});

describe('fuzzyMatch — ranking', () => {
  it('prefers the exact substring hit over scattered matches', () => {
    const list = items('k r a k e n', 'kraken');
    expect(fuzzyMatch('kraken', list)[0]?.searchText).toBe('kraken');
  });

  it('prefers a prefix hit over a mid-string hit', () => {
    const list = items('xxkraken', 'kraken-xx');
    expect(fuzzyMatch('kraken', list)[0]?.searchText).toBe('kraken-xx');
  });

  it('prefers word-start matches over mid-word matches', () => {
    const list = items('backgraf', 'build graph');
    expect(fuzzyMatch('gr', list)[0]?.searchText).toBe('build graph');
  });

  it('prefers the shorter haystack when scores tie, then original order', () => {
    const list = items('aaaaaa', 'aa');
    expect(fuzzyMatch('a', list)[0]?.searchText).toBe('aa');
    const ties = items('same one', 'same one');
    expect(fuzzyMatch('same', ties)[0]).toBe(ties[0]);
  });
});

describe('fuzzyScore', () => {
  it('scores an empty query as 0 and a miss as null', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('zzz', 'anything')).toBeNull();
  });

  it('scores an exact hit above a scattered one', () => {
    const exact = fuzzyScore('graph', 'kraken graph');
    const scattered = fuzzyScore('graph', 'g-r-a-p-h');
    expect(exact).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(exact!).toBeGreaterThan(scattered!);
  });
});
