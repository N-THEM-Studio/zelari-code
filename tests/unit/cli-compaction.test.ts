import { describe, it, expect } from 'vitest';
import {
  compactTranscript,
  formatCompactionSummary,
  type CompactMessage,
} from '../../src/cli/compaction.js';

const NOW = 1_700_000_000_000;

function makeMessages(n: number, prefix = 'msg'): CompactMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant' as const,
    content: `${prefix}-${i}-content`,
    ts: NOW + i,
  }));
}

describe('compaction (Task B.3.3)', () => {
  describe('compactTranscript', () => {
    it('returns the original array unchanged when below threshold', () => {
      const msgs = makeMessages(10);
      const result = compactTranscript(msgs, { threshold: 50, keepRecent: 20, now: NOW });
      expect(result.messages).toBe(msgs);
      expect(result.droppedCount).toBe(0);
      expect(result.summaryMessage).toBeNull();
      expect(result.originalCount).toBe(10);
    });

    it('returns the original array when exactly at threshold', () => {
      const msgs = makeMessages(50);
      const result = compactTranscript(msgs, { threshold: 50, keepRecent: 20, now: NOW });
      expect(result.messages).toBe(msgs);
      expect(result.droppedCount).toBe(0);
    });

    it('compacts when over threshold', () => {
      const msgs = makeMessages(100);
      const result = compactTranscript(msgs, { threshold: 50, keepRecent: 20, now: NOW });
      expect(result.droppedCount).toBe(80);
      expect(result.originalCount).toBe(100);
      expect(result.messages.length).toBe(21); // 1 summary + 20 kept
      expect(result.summaryMessage).not.toBeNull();
      expect(result.summaryMessage?.role).toBe('system');
      expect(result.summaryMessage?.content).toContain('80');
    });

    it('keeps the most recent N messages (chronologically last)', () => {
      const msgs = makeMessages(60);
      const result = compactTranscript(msgs, { threshold: 50, keepRecent: 10, now: NOW });
      expect(result.messages.length).toBe(11); // 1 summary + 10 kept
      // First non-summary should be msg-50 (the 51st, index 50).
      const kept = result.messages.slice(1);
      expect(kept[0].id).toBe('msg-50');
      expect(kept[9].id).toBe('msg-59');
    });

    it('summary message is prepended (not appended)', () => {
      const msgs = makeMessages(60);
      const result = compactTranscript(msgs, { threshold: 50, keepRecent: 20, now: NOW });
      expect(result.messages[0]).toBe(result.summaryMessage);
    });

    it('does not mutate the original messages array', () => {
      const msgs = makeMessages(60);
      const beforeLength = msgs.length;
      const beforeFirstId = msgs[0].id;
      compactTranscript(msgs, { threshold: 50, keepRecent: 20, now: NOW });
      expect(msgs.length).toBe(beforeLength);
      expect(msgs[0].id).toBe(beforeFirstId);
    });

    it('handles keepRecent larger than message count', () => {
      const msgs = makeMessages(60);
      const result = compactTranscript(msgs, { threshold: 50, keepRecent: 100, now: NOW });
      // 60 - 100 → keeps all 60, no compaction
      expect(result.droppedCount).toBe(0);
      expect(result.messages.length).toBe(60);
    });

    it('respects custom threshold and keepRecent', () => {
      const msgs = makeMessages(15);
      const result = compactTranscript(msgs, { threshold: 10, keepRecent: 5, now: NOW });
      expect(result.droppedCount).toBe(10);
      expect(result.messages.length).toBe(6);
    });

    it('uses injected now() for deterministic summary id', () => {
      const msgs = makeMessages(60);
      const r1 = compactTranscript(msgs, { threshold: 50, keepRecent: 20, now: 111 });
      const r2 = compactTranscript(msgs, { threshold: 50, keepRecent: 20, now: 222 });
      // Summary id includes the timestamp + a random suffix, so they differ.
      expect(r1.summaryMessage?.id).not.toBe(r2.summaryMessage?.id);
      // But both start with "compact-".
      expect(r1.summaryMessage?.id).toMatch(/^compact-111-/);
      expect(r2.summaryMessage?.id).toMatch(/^compact-222-/);
    });
  });

  describe('formatCompactionSummary', () => {
    it('formats "no compaction needed" case', () => {
      const r = compactTranscript(makeMessages(5), { threshold: 50, now: NOW });
      expect(formatCompactionSummary(r)).toBe('[compact] no compaction needed (5 messages, below threshold)');
    });

    it('formats compaction stats', () => {
      const r = compactTranscript(makeMessages(60), { threshold: 50, keepRecent: 20, now: NOW });
      const out = formatCompactionSummary(r);
      expect(out).toContain('60');
      expect(out).toContain('21'); // 1 summary + 20 kept
      expect(out).toContain('40'); // dropped
    });
  });
});