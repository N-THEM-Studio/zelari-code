/**
 * statusChips.inbox.test.ts — WS2: the `inbox` status-line chip.
 *
 * Same contract as the t124 verdict chip: a PURE feed→chip projection, honest
 * tones, the shared t125 kill switch, the opt-in gate, and the memo-safe cache
 * that keeps a ~30×/s repaint from re-reading the spine.
 */
import { describe, expect, it } from 'vitest';
import {
  cachedInboxStatusChip,
  inboxChipFromFeed,
  resetInboxChipCacheForTests,
  statusLineItemEnabled,
} from './statusChips.js';
import { emptyInboxFeed, deriveInboxFeed, type InboxFeed } from '../statusline/inboxFeed.js';

function feed(partial: Partial<InboxFeed>): InboxFeed {
  return { ...emptyInboxFeed(), ...partial };
}

describe('inboxChipFromFeed — label + honest tone (WS2)', () => {
  it('nothing waiting ⇒ no chip (a zero is not a measurement)', () => {
    expect(inboxChipFromFeed(emptyInboxFeed())).toBeNull();
    expect(inboxChipFromFeed(null)).toBeNull();
  });

  it('kill switch ZELARI_INBOX=0 ⇒ null even with rows waiting', () => {
    const f = feed({ questions: 2, total: 2 });
    expect(inboxChipFromFeed(f, { ZELARI_INBOX: '0' })).toBeNull();
    expect(inboxChipFromFeed(f, {})?.label).toBe('inbox 2');
  });

  it('questions alone ⇒ yellow "inbox N"', () => {
    expect(inboxChipFromFeed(feed({ questions: 1, total: 1 }))).toEqual({ label: 'inbox 1', tone: 'yellow' });
  });

  it('an open need ⇒ red, with the need count spelled out', () => {
    expect(inboxChipFromFeed(feed({ questions: 1, needs: 2, total: 3 }))).toEqual({
      label: 'inbox 3 (2 need)',
      tone: 'red',
    });
    expect(inboxChipFromFeed(feed({ finished: 2, total: 2 }))).toEqual({
      label: 'inbox 2',
      tone: 'yellow',
    });
  });
});

describe('deriveInboxFeed — the three sources, from one spine', () => {
  it('counts questions, needs and finished tentacles', () => {
    const rows = deriveInboxFeed([
      { kind: 'tool.call', seq: 1, ts: 1, data: { tool: 'ask_user', callId: 'c', args: { question: 'q?' } } },
      { kind: 'verify.debt_open', seq: 2, ts: 2, data: { taskId: 't1', description: 'x' } },
      { kind: 'permission.denied', seq: 3, ts: 3, data: { tool: 'bash', matchedRuleId: 'r1' } },
      { kind: 'graph.node_ended', seq: 4, ts: 4, data: { nodeId: 'n1', agent: 'general', ok: true } },
    ]);
    expect(rows).toEqual({ questions: 1, needs: 2, finished: 1, total: 4 });
  });

  it('an empty spine is an empty feed (never an invented zero-row claim)', () => {
    expect(deriveInboxFeed([])).toEqual(emptyInboxFeed());
  });
});

describe('cachedInboxStatusChip — opt-in + paint-side cache', () => {
  it('is OPT-IN: the default status-line order does not paint it, so the chip is null', () => {
    resetInboxChipCacheForTests();
    expect(statusLineItemEnabled('inbox')).toBe(false);
    expect(cachedInboxStatusChip({})).toBeNull();
  });

  it('returns the SAME identity on repeated calls (StatusBar memo stays quiet)', () => {
    resetInboxChipCacheForTests();
    const a = cachedInboxStatusChip({});
    const b = cachedInboxStatusChip({});
    expect(b).toBe(a);
  });
});
