/**
 * cli-conversationContext.test.ts — shared rolling history + short-answer
 * anchoring (v1.8.0 PR-A).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getHistory,
  setHistory,
  appendMessages,
  clearHistory,
  setLastClarification,
  getLastClarification,
  maybeAnchorShortAnswer,
  formatHistoryForCouncil,
  _resetConversationContextForTests,
} from '../../src/cli/hooks/conversationContext.js';

beforeEach(() => {
  _resetConversationContextForTests();
});

describe('conversationContext', () => {
  it('starts empty and clears completely', () => {
    expect(getHistory()).toEqual([]);
    appendMessages([{ role: 'user', content: 'hi' }]);
    setLastClarification({ question: 'Q?', choices: ['a', 'b'] });
    clearHistory();
    expect(getHistory()).toEqual([]);
    expect(getLastClarification()).toBeNull();
  });

  it('appends and exposes history', () => {
    appendMessages([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
    expect(getHistory()).toHaveLength(2);
    setHistory([{ role: 'user', content: 'only' }]);
    expect(getHistory()).toEqual([{ role: 'user', content: 'only' }]);
  });

  it('anchors short answers that match a choice', () => {
    setLastClarification({
      question: 'Scope?',
      choices: ['Minimal', 'Standard', 'Full'],
    });
    const anchored = maybeAnchorShortAnswer('full');
    expect(anchored).toBeTruthy();
    expect(anchored).toMatch(/Scope\?/);
    expect(anchored).toMatch(/Full/i);
    expect(anchored).toMatch(/do not re-ask/i);
  });

  it('anchors numeric choice picks (1-based)', () => {
    setLastClarification({
      question: 'Pick one',
      choices: ['Alpha', 'Beta', 'Gamma'],
    });
    const anchored = maybeAnchorShortAnswer('2');
    expect(anchored).toMatch(/Beta/);
  });

  it('does not wrap long free-form answers', () => {
    setLastClarification({
      question: 'Scope?',
      choices: ['Minimal', 'Full'],
    });
    const long =
      'I want a full implementation with auth, billing, and a marketing site.';
    expect(maybeAnchorShortAnswer(long)).toBeNull();
  });

  it('returns null when no prior clarification', () => {
    expect(maybeAnchorShortAnswer('full')).toBeNull();
  });

  it('formats recent turns for council context', () => {
    appendMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply2' },
    ]);
    const block = formatHistoryForCouncil(2);
    expect(block).toMatch(/Prior conversation/);
    expect(block).toMatch(/second/);
    expect(block).toMatch(/reply2/);
  });
});
