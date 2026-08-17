/**
 * Fase M tests — context-growth accounting (unit) + harness integration.
 *
 * The integration test drives a REAL AgentHarness with a scripted provider
 * stream (one tool round-trip, then a final text turn) and asserts the
 * log-only `context_metrics` event reflects ground truth: the bytes counted
 * are exactly the bytes of the `tool_execution_end` results, the request
 * count matches provider invocations, and cache-hit tokens fold correctly.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  emptyContextGrowthStats,
  jsonBytes,
  recordRequest,
  recordToolResult,
  recordUsage,
  utf8Bytes,
} from './contextGrowth.js';
import { AgentHarness } from './AgentHarness.js';
import type { ProviderDelta } from './AgentHarness.js';
import { ToolRegistry } from './tools/registry.js';
import { isBrainContextMetricsEvent } from '../shared/events.js';

describe('contextGrowth helpers', () => {
  it('starts empty', () => {
    expect(emptyContextGrowthStats()).toEqual({
      toolRoundTrips: 0,
      intermediateToolBytes: 0,
      requests: 0,
      historyBytesLast: 0,
      historyBytesPeak: 0,
      cacheHitTokens: 0,
    });
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // 'caffè' = 5 chars, 6 UTF-8 bytes (è is 2 bytes).
    expect('caffè'.length).toBe(5);
    expect(utf8Bytes('caffè')).toBe(6);
  });

  it('jsonBytes serializes and measures; returns 0 on circular input', () => {
    expect(jsonBytes({ a: 1 })).toBe(utf8Bytes(JSON.stringify({ a: 1 })));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(jsonBytes(circular)).toBe(0);
  });

  it('recordToolResult accumulates round-trips + bytes', () => {
    const s = emptyContextGrowthStats();
    recordToolResult(s, 'abc');
    recordToolResult(s, 'caffè');
    expect(s.toolRoundTrips).toBe(2);
    expect(s.intermediateToolBytes).toBe(3 + 6);
  });

  it('recordRequest tracks last + peak history size', () => {
    const s = emptyContextGrowthStats();
    recordRequest(s, [{ role: 'user', content: 'x'.repeat(100) }]);
    recordRequest(s, [{ role: 'user', content: 'x'.repeat(10) }]);
    recordRequest(s, [{ role: 'user', content: 'x'.repeat(500) }]);
    expect(s.requests).toBe(3);
    expect(s.historyBytesLast).toBe(jsonBytes([{ role: 'user', content: 'x'.repeat(500) }]));
    expect(s.historyBytesPeak).toBe(s.historyBytesLast);
  });

  it('recordUsage folds cachedPromptTokens only, null-safe', () => {
    const s = emptyContextGrowthStats();
    recordUsage(s, null);
    recordUsage(s, undefined);
    recordUsage(s, { promptTokens: 100, completionTokens: 5, totalTokens: 105 });
    recordUsage(s, {
      promptTokens: 100,
      completionTokens: 5,
      totalTokens: 105,
      cachedPromptTokens: 60,
    });
    expect(s.cacheHitTokens).toBe(60);
  });
});

describe('AgentHarness context_metrics event (integration)', () => {
  it('emits log-only counters that match ground truth before agent_end', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo_observation',
      description: 'Test-only observe tool: returns its input verbatim.',
      permissions: ['read'],
      inputSchema: z.object({ text: z.string() }),
      execute: async (input) => ({ ok: true as const, value: input.text }),
    });

    let calls = 0;
    const providerStream = async function* (): AsyncIterable<ProviderDelta> {
      calls += 1;
      if (calls === 1) {
        yield {
          kind: 'tool_call',
          toolCallId: 'call_1',
          toolName: 'echo_observation',
          args: { text: 'hello observation' },
        };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        yield {
          kind: 'usage',
          usage: {
            promptTokens: 1000,
            completionTokens: 10,
            totalTokens: 1010,
            cachedPromptTokens: 700,
          },
        };
        yield { kind: 'text', delta: 'done' };
        yield { kind: 'finish', reason: 'stop' };
      }
    };

    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'openai-compatible',
      messages: [{ role: 'user', content: 'run the echo tool' }],
      tools: [
        {
          name: 'echo_observation',
          description: 'Test-only observe tool.',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ],
      toolRegistry: registry,
      providerStream,
      cwd: process.cwd(),
    });

    const events = [];
    for await (const ev of harness.run()) events.push(ev);

    const metricsEvents = events.filter(isBrainContextMetricsEvent);
    expect(metricsEvents.length).toBe(1);
    const m = metricsEvents[0]!;

    // Ground-truth cross-check: bytes counted === bytes of tool_execution_end results.
    const toolEnds = events.filter(e => e.type === 'tool_execution_end');
    expect(toolEnds.length).toBe(1);
    expect(m.toolRoundTrips).toBe(1);
    expect(m.intermediateToolBytes).toBe(utf8Bytes(toolEnds[0]!.result));

    // Requests: initial call + tool-loop re-entry.
    expect(m.requests).toBe(2);
    expect(calls).toBe(2);

    // History surface: monotonically grows with the tool result appended.
    expect(m.historyBytesPeak).toBeGreaterThanOrEqual(m.historyBytesLast);
    expect(m.historyBytesLast).toBeGreaterThan(0);

    // Cache accounting folds provider usage.
    expect(m.cacheHitTokens).toBe(700);

    // Ordering: context_metrics arrives immediately before agent_end.
    const idxMetrics = events.findIndex(e => e.type === 'context_metrics');
    const idxAgentEnd = events.findIndex(e => e.type === 'agent_end');
    expect(idxMetrics).toBeGreaterThan(-1);
    expect(idxAgentEnd).toBe(idxMetrics + 1);

    // Log-only guarantee: nothing metrics-shaped leaks into model-facing messages.
    const serialized = JSON.stringify((harness as unknown as { config: { messages: unknown[] } }).config.messages);
    expect(serialized).not.toContain('context_metrics');
    expect(serialized).not.toContain('toolRoundTrips');
  });
});
