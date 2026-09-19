/**
 * statusChips.verdict — the paint-side of the `verdict` status-line item
 * (openharness-steal t124). The derive-only projection itself is covered by
 * statusline/verdictFeed.test.ts; here we pin the chip mapping: label from
 * verdictFeedText, honest tones, kill switch, and the memo-safe cache.
 */
import { describe, expect, it } from 'vitest';
import {
  cachedVerdictStatusChip,
  resetVerdictChipCacheForTests,
  verdictChipFromFeed,
} from './statusChips.js';
import { emptyVerdictFeed, type VerdictFeed } from '../statusline/verdictFeed.js';

function feed(partial: Partial<VerdictFeed>): VerdictFeed {
  return { ...emptyVerdictFeed(), ...partial };
}

describe('verdictChipFromFeed — label + honest tone (t124)', () => {
  it('nothing recorded ⇒ no chip (unknown ≠ pass, and never a dishonest blank chip)', () => {
    expect(verdictChipFromFeed(emptyVerdictFeed())).toBeNull();
    expect(verdictChipFromFeed(null)).toBeNull();
  });

  it('kill switch ZELARI_VERDICT_FEED=0 ⇒ null even with a recorded PASS', () => {
    const f = feed({ ready: true, verdict: 'PASS', seq: 7, passed: 3, total: 3 });
    expect(verdictChipFromFeed(f, { ZELARI_VERDICT_FEED: '0' })).toBeNull();
  });

  it('recorded PASS with counts ⇒ green "PASS 3/3 · checks"', () => {
    const chip = verdictChipFromFeed(feed({ ready: true, verdict: 'PASS', seq: 7, passed: 3, total: 3 }));
    expect(chip).toEqual({ label: 'PASS 3/3 · checks', tone: 'green' });
  });

  it('BLOCKED ⇒ red, REPAIR_REQUIRED ⇒ yellow', () => {
    expect(verdictChipFromFeed(feed({ ready: false, verdict: 'BLOCKED', seq: 7 }))?.tone).toBe('red');
    expect(
      verdictChipFromFeed(feed({ ready: false, verdict: 'REPAIR_REQUIRED', seq: 7, passed: 1, total: 4 }))?.tone,
    ).toBe('yellow');
  });

  it('in-flight evidence with no record yet ⇒ yellow observation counter', () => {
    expect(verdictChipFromFeed(feed({ observations: 2 }))).toEqual({
      label: 'verify… 2 obs',
      tone: 'yellow',
    });
  });
});

describe('cachedVerdictStatusChip — paint-side cache (t124)', () => {
  it('returns the SAME identity on repeated calls (StatusBar memo stays quiet)', () => {
    resetVerdictChipCacheForTests();
    const a = cachedVerdictStatusChip({});
    const b = cachedVerdictStatusChip({});
    expect(b).toBe(a);
  });

  it('kill switch off ⇒ no chip at all', () => {
    resetVerdictChipCacheForTests();
    expect(cachedVerdictStatusChip({ ZELARI_VERDICT_FEED: '0' })).toBeNull();
  });
});
