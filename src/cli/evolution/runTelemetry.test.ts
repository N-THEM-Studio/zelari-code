import { describe, expect, it } from 'vitest';
import { RunTelemetryAccumulator } from './runTelemetry.js';

describe('RunTelemetryAccumulator', () => {
  it('sums provider usage across message_end events and counts tool calls', () => {
    const rt = new RunTelemetryAccumulator({ model: 'gpt-test', provider: 'openai-compatible' });
    rt.observe({ type: 'message_start' });
    rt.observe({ type: 'message_end', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } });
    rt.observe({ type: 'tool_execution_end', toolCallId: 't1' });
    rt.observe({ type: 'tool_execution_end', toolCallId: 't2' });
    rt.observe({
      type: 'message_end',
      usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55, cachedPromptTokens: 30 },
    });
    expect(rt.usage()).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      cacheHitTokens: 30,
      toolCalls: 2,
      usageReports: 2,
    });
  });

  it('omits token fields when no provider usage report was seen (honest absence)', () => {
    const rt = new RunTelemetryAccumulator();
    rt.observe({ type: 'message_end' }); // no usage field
    rt.observe({ type: 'tool_execution_end' });
    expect(rt.ledgerFields()).toEqual({ toolCalls: 1 });
    const ev = rt.usageEvent();
    expect(ev.inputTokens).toBe(0);
    expect(ev.usageReports).toBe(0);
  });

  it('ignores non-events and unknown shapes without throwing', () => {
    const rt = new RunTelemetryAccumulator();
    expect(() => {
      rt.observe(null);
      rt.observe('string');
      rt.observe({ noType: true });
      rt.observe({ type: 'message_delta', delta: 'x' });
    }).not.toThrow();
    expect(rt.usage().toolCalls).toBe(0);
  });

  it('usageEvent carries model/provider attribution (HarnessDev steal #2)', () => {
    const rt = new RunTelemetryAccumulator({ model: 'm1', provider: 'p1' });
    rt.observe({ type: 'message_end', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });
    expect(rt.usageEvent()).toMatchObject({ type: 'usage', model: 'm1', provider: 'p1' });
    expect(rt.usageEvent().inputTokens).toBe(1);
  });

  it('partial usage numbers only add what the provider actually reported', () => {
    const rt = new RunTelemetryAccumulator();
    rt.observe({ type: 'message_end', usage: { promptTokens: 7 } });
    expect(rt.usage()).toMatchObject({ inputTokens: 7, outputTokens: 0, usageReports: 1 });
  });
});
