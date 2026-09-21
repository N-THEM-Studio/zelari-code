/**
 * subagentMetrics.test — t156 (P2a-1) honesty contract for the usage footer.
 *
 * The line exists ONLY when the provider reported usage; cached appears only
 * when reported >0; tail fields appear only when known. No fabricated zeros.
 */
import { describe, expect, it } from 'vitest';
import { formatSubagentMetricsLine } from './subagentMetrics.js';

describe('t156 — formatSubagentMetricsLine (P2a-1)', () => {
  it('formats provider usage with tool calls and turns', () => {
    const line = formatSubagentMetricsLine({
      usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cachedPromptTokens: 800 },
      toolCalls: 7,
      turns: 4,
    });
    expect(line).toContain('1200 prompt');
    expect(line).toContain('300 completion');
    expect(line).toContain('800 cached');
    expect(line).toContain('1500 total');
    expect(line).toContain('7 tool calls');
    expect(line).toContain('4 turns');
  });

  it('no usage ⇒ empty line, never fabricated zeros', () => {
    expect(formatSubagentMetricsLine({ toolCalls: 3, turns: 2 })).toBe('');
    expect(formatSubagentMetricsLine({})).toBe('');
  });

  it('cached omitted when the provider reported none', () => {
    const line = formatSubagentMetricsLine({
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    expect(line).toContain('tokens');
    expect(line).not.toContain('cached');
    expect(line).not.toContain('undefined');
  });

  it('tail fields omitted when unknown', () => {
    const line = formatSubagentMetricsLine({
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    expect(line).not.toContain('tool calls');
    expect(line).not.toContain('turns');
  });
});
