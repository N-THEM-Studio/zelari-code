/**
 * Council multi-turn history for Desktop headless ("procedi" amnesia fix).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentMessage } from '@zelari/core/harness';
import {
  buildAgentUserWithHistory,
  buildCouncilTaskWithHistory,
  expectsDiskImplementation,
  formatHistoryMessages,
  isShortContinueReply,
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

describe('buildAgentUserWithHistory (Desktop plan→build)', () => {
  const prior: AgentMessage[] = [
    {
      role: 'user',
      content: 'Arricchisci la pagina Storia',
    },
    {
      role: 'assistant',
      content:
        'Sintesi: 4 sezioni nuove, timeline 10 milestone, CTA finale. Se confermi, passo alla scrittura su disco.',
    },
  ];

  it('re-anchors short confirmations so agent cannot claim empty session', () => {
    const msg = buildAgentUserWithHistory('procedi', prior);
    expect(msg).toMatch(/CONTINUATION|Prior assistant|plan to implement/i);
    expect(msg).toMatch(/timeline 10 milestone|Sintesi/i);
    expect(msg).toMatch(/write_file|ON DISK|IMPLEMENT/i);
    expect(msg).not.toBe('procedi');
  });

  it('expectsDiskImplementation for build continues and plan confirmations', () => {
    expect(expectsDiskImplementation('procedi', 'build', prior)).toBe(true);
    expect(expectsDiskImplementation('procedi', 'plan', prior)).toBe(false);
    expect(
      expectsDiskImplementation('what is typescript?', 'build', prior),
    ).toBe(false);
    expect(
      expectsDiskImplementation('implement the founder section', 'build', []),
    ).toBe(true);
  });

  it('re-anchors Italian confirm phrases', () => {
    const msg = buildAgentUserWithHistory('sì conferma e scrivi', prior);
    expect(msg).toMatch(/Prior assistant|Sintesi/i);
  });

  it('leaves long free-form tasks unchanged', () => {
    const long =
      'Implement only the founder biography section with the gold border photo layout.';
    expect(buildAgentUserWithHistory(long, prior)).toBe(long);
  });

  it('isShortContinueReply detects continue cues', () => {
    expect(isShortContinueReply('procedi')).toBe(true);
    expect(isShortContinueReply('ok')).toBe(true);
    expect(isShortContinueReply('sì, procedi pure')).toBe(true);
    expect(isShortContinueReply('rewrite the whole page with different copy')).toBe(
      false,
    );
  });
});
