import { describe, it, expect } from 'vitest';
import {
  cleanAgentContent,
  parseThinking,
} from '../../packages/core/src/agents/councilApi.ts';

describe('cleanAgentContent / parseThinking (v1.8.1 think leak)', () => {
  it('strips complete <think> blocks', () => {
    const raw =
      '<think>\nI am reasoning privately.\n</think>\n\nHere is the real answer.';
    expect(cleanAgentContent(raw)).toBe('Here is the real answer.');
  });

  it('strips unclosed trailing <think> (streamed mid-turn leak)', () => {
    const raw =
      'Short intro.\n<think>\nStill thinking about the plan…\nno close yet';
    expect(cleanAgentContent(raw)).toBe('Short intro.');
  });

  it('strips <thinking> alias tags', () => {
    const raw = '<thinking>secret</thinking>\nVisible.';
    expect(cleanAgentContent(raw)).toBe('Visible.');
  });

  it('strips ---QUESTION--- blocks', () => {
    const raw =
      'Ask:\n---QUESTION---\n{"question":"q?","choices":["a","b"]}\n---END---\nDone.';
    expect(cleanAgentContent(raw)).toBe('Ask:\n\nDone.');
  });

  it('preserves <think> when stripThink:false (MiniMax-M3 provider history)', () => {
    const raw =
      '<think>\nplan the tool call\n</think>\n\nI will list providers.';
    expect(
      cleanAgentContent(raw, { stripThink: false, stripQuestion: false }),
    ).toBe(raw.trim());
  });

  it('still strips minimax tool wrappers when preserving think', () => {
    const raw =
      '<think>x</think>\n<minimax:tool_call><invoke name="list_files"></invoke></minimax:tool_call>\nDone.';
    const out = cleanAgentContent(raw, { stripThink: false });
    expect(out).toContain('<think>x</think>');
    expect(out).toContain('Done.');
    expect(out).not.toContain('minimax:tool_call');
  });

  it('parseThinking extracts body from complete block', () => {
    expect(parseThinking('<think>\nalpha\n</think>\nbeta')).toBe('alpha');
  });

  it('parseThinking extracts unclosed trailing block', () => {
    expect(parseThinking('visible\n<think>\nbeta')).toBe('beta');
  });
});
