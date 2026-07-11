/**
 * Council multi-turn history for Desktop headless ("procedi" amnesia fix).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentMessage } from '@zelari/core/harness';
import {
  buildCouncilTaskWithHistory,
  formatHistoryMessages,
  _resetConversationContextForTests,
} from '../../src/cli/hooks/conversationContext.js';

beforeEach(() => {
  _resetConversationContextForTests();
});

describe('buildCouncilTaskWithHistory', () => {
  const prior: AgentMessage[] = [
    {
      role: 'user',
      content: 'Design Anathema Studio marketing site architecture',
    },
    {
      role: 'assistant',
      content:
        'Key Risks: P0 NFR budget. Ready for next council: fix typecheck, apply chunkSizeWarningLimit, Track A then Track B.',
    },
  ];

  it('embeds prior assistant context when user says procedi', () => {
    const task = buildCouncilTaskWithHistory('procedi', prior);
    expect(task).toMatch(/procedi/i);
    expect(task).toMatch(/Prior assistant output|Key Risks|Track A/i);
    expect(task).toMatch(/Do NOT restart from zero/i);
  });

  it('returns bare task when no history', () => {
    expect(buildCouncilTaskWithHistory('implement login', [])).toBe(
      'implement login',
    );
  });

  it('includes rolling transcript for longer follow-ups', () => {
    const task = buildCouncilTaskWithHistory(
      'Please implement Track A carefully with tests',
      prior,
    );
    expect(task).toMatch(/Prior conversation|Design Anathema/i);
    expect(task).toMatch(/Current user request|implement Track A/i);
  });
});

describe('formatHistoryMessages', () => {
  it('formats user/assistant pairs newest-first window', () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ];
    const s = formatHistoryMessages(msgs, 2);
    expect(s).toMatch(/u2/);
    expect(s).toMatch(/a2/);
  });
});
