import { describe, it, expect, afterEach } from 'vitest';
import type { AgentMessage } from '@zelari/core/harness';
import {
  extractiveHistorySummary,
  formatDroppedForLlm,
} from '../../src/cli/budget/historySummary.js';
import {
  compactHistoryDetailed,
  compactHistory,
} from '../../src/cli/hooks/historyCompaction.js';

function plainTurns(n: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: i % 2 === 0 ? `please do task ${i}` : `I completed task ${i}`,
    });
  }
  return out;
}

describe('historySummary extractive', () => {
  it('captures user goals and assistant notes', () => {
    const dropped: AgentMessage[] = [
      { role: 'user', content: 'Add export to markdown' },
      {
        role: 'assistant',
        content: 'I will implement export in App.tsx',
        toolCalls: [
          { id: 'c1', name: 'read_file', args: { path: 'apps/desktop/src/App.tsx' } },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: 'file body' },
    ];
    const s = extractiveHistorySummary(dropped);
    expect(s).toMatch(/history-summary/);
    expect(s).toMatch(/Add export to markdown/);
    expect(s).toMatch(/read_file/);
    expect(s).toMatch(/App\.tsx/);
  });

  it('formatDroppedForLlm is bounded and non-empty', () => {
    const dropped = plainTurns(20);
    const t = formatDroppedForLlm(dropped);
    expect(t).toMatch(/USER:/);
    expect(t.length).toBeGreaterThan(20);
  });
});

describe('compactHistoryDetailed continuity summary', () => {
  const orig = process.env.ZELARI_HISTORY_TURNS;

  afterEach(() => {
    if (orig === undefined) delete process.env.ZELARI_HISTORY_TURNS;
    else process.env.ZELARI_HISTORY_TURNS = orig;
  });

  it('embeds extractive summary when dropping messages', () => {
    delete process.env.ZELARI_HISTORY_TURNS;
    // force small window: 2 turns → 8 msgs; trigger at 16
    const msgs = plainTurns(40);
    const result = compactHistoryDetailed(msgs, { maxMessages: 8 });
    expect(result.compacted).toBe(true);
    expect(result.messagesRemoved).toBeGreaterThan(0);
    expect(result.summary).toMatch(/history-summary|compacted/i);
    expect(result.messages[0]?.role).toBe('system');
    expect(result.messages[0]?.content).toMatch(/User goals|history-summary|compacted/i);
    // same API as compactHistory
    const same = compactHistory(msgs, { maxMessages: 8 });
    expect(same[0]?.role).toBe('system');
  });
});
