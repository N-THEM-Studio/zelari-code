/**
 * core-agentHarness-finalAnswer.test.ts — v0.7.1 (A2) harness fixes.
 *
 * Covers two interacting behaviors that caused the "turn ends with no final
 * answer + identical tool calls repeated" failure observed in the live test:
 *
 *  1. Duplicate-call short-circuit: when the model re-issues an identical
 *     tool call within a run, the registry is NOT re-invoked — the cached
 *     result is replayed with a "duplicate call" prefix.
 *  2. Final-answer guarantee: when the tool-call loop hits its iteration cap
 *     still requesting tools, ONE more provider call with tools omitted +
 *     a nudge is made so the run ends with assistant text.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentHarness } from '@zelari/core/harness';
import type { ProviderStreamFn, ProviderDelta } from '@zelari/core/harness';
import type { BrainEvent } from '@zelari/core/events';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';

function asyncGen(deltas: ProviderDelta[]): ProviderStreamFn {
  return async function* () {
    for (const d of deltas) yield d;
  };
}

async function collect(stream: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

/** Build a tool registry with a counting echo tool so we can assert how many
 *  times execute actually ran. Mirrors the ToolRegistry signature used in
 *  cli-maxToolCallsPerTurn.test.ts (inputSchema + permissions + TypedResult). */
function newRegistryWithCounter() {
  const registry = new ToolRegistry();
  let calls = 0;
  registry.register({
    name: 'echo',
    description: 'echo back the input',
    inputSchema: z.object({}).passthrough(),
    permissions: [],
    execute: async () => {
      calls++;
      return { ok: true as const, value: `call #${calls}` };
    },
  });
  return { registry, getCalls: () => calls };
}

describe('AgentHarness — duplicate-call short-circuit (v0.7.1 A2)', () => {
  it('replays the cached result when the same tool+args is called twice in a turn', async () => {
    const { registry, getCalls } = newRegistryWithCounter();
    // Stateful provider: turn 1 emits two IDENTICAL tool calls then tool_calls
    // finish; turn 2 emits text + stop. This avoids the static-asyncGen pitfall
    // where every provider re-entry re-emits the same deltas and loops forever.
    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn++;
      if (turn === 1) {
        yield { kind: 'tool_call', toolCallId: 'c1', toolName: 'echo', args: { x: 1 } };
        yield { kind: 'tool_call', toolCallId: 'c2', toolName: 'echo', args: { x: 1 } };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        yield { kind: 'text', delta: 'done' };
        yield { kind: 'finish', reason: 'stop' };
      }
    };

    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-dup',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'echo', description: 'e', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
    });

    const events = await collect(harness.run());
    // The registry executed exactly ONCE — the second identical call was
    // short-circuited and replayed from cache.
    expect(getCalls()).toBe(1);

    const toolEnds = events.filter((e) => e.type === 'tool_execution_end');
    expect(toolEnds).toHaveLength(2);
    // First: the real result.
    expect((toolEnds[0] as { result: string }).result).toBe('call #1');
    // Second: the cached result, prefixed with the duplicate-call warning.
    expect((toolEnds[1] as { result: string }).result).toMatch(/duplicate call/);
    expect((toolEnds[1] as { result: string }).result).toContain('call #1');
  });

  it('treats args with the same keys in different order as identical', async () => {
    const { registry, getCalls } = newRegistryWithCounter();
    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn++;
      if (turn === 1) {
        yield { kind: 'tool_call', toolCallId: 'c1', toolName: 'echo', args: { a: 1, b: 2 } };
        yield { kind: 'tool_call', toolCallId: 'c2', toolName: 'echo', args: { b: 2, a: 1 } };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        yield { kind: 'text', delta: 'ok' };
        yield { kind: 'finish', reason: 'stop' };
      }
    };
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-dup-order',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'echo', description: 'e', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
    });
    await collect(harness.run());
    // Canonicalized args collide → still one execution.
    expect(getCalls()).toBe(1);
  });
});

describe('AgentHarness — final-answer guarantee (v0.7.1 A2)', () => {
  it('makes a no-tools closing call when the tool loop hits the iteration cap', async () => {
    // A provider that ALWAYS finishes with tool_calls for the looped turns
    // — simulating a model stuck requesting tools forever. The loop runs
    // MAX_TOOL_LOOP_ITERATIONS (12) times, each time still tool_calls, so
    // the final-answer guarantee must fire: one more provider call with
    // tools omitted. We detect that by having the provider emit text ONLY
    // when tools is empty (which is exactly how the guarantee calls it).
    let providerCalls = 0;
    const provider: ProviderStreamFn = async function* (params) {
      providerCalls++;
      // When called WITHOUT tools (the final-answer turn), emit the answer.
      if (params.tools.length === 0) {
        yield { kind: 'text', delta: 'here is my final answer' };
        yield { kind: 'finish', reason: 'stop' };
        return;
      }
      // Otherwise: always request a tool → forces the loop to the cap.
      yield { kind: 'tool_call', toolCallId: `t${providerCalls}`, toolName: 'echo', args: {} };
      yield { kind: 'finish', reason: 'tool_calls' };
    };

    const { registry } = newRegistryWithCounter();
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-final',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'echo', description: 'e', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
    });

    const events = await collect(harness.run());
    // The run ends with assistant text — the final-answer turn fired.
    const textDeltas = events.filter(
      (e) => e.type === 'message_delta' && (e as { delta: string }).delta.length > 0,
    );
    expect(textDeltas.length).toBeGreaterThan(0);
    const allText = textDeltas.map((e) => (e as { delta: string }).delta).join('');
    expect(allText).toContain('here is my final answer');
    // The run completed (not errored).
    const agentEnd = events.find((e) => e.type === 'agent_end');
    expect(agentEnd && (agentEnd as { reason: string }).reason).toBe('completed');
    // Sanity: more than MAX_TOOL_LOOP_ITERATIONS provider calls happened
    // (the loop turns + the final-answer turn).
    expect(providerCalls).toBeGreaterThan(12);
  });

  it('extends soft tool budget before hard-cap final answer (v1.8.3)', async () => {
    // Soft=2, hard=5 → should extend at least once and emit tool_budget_extended.
    let providerCalls = 0;
    const provider: ProviderStreamFn = async function* (params) {
      providerCalls++;
      if (params.tools.length === 0) {
        yield { kind: 'text', delta: 'wrapped up' };
        yield { kind: 'finish', reason: 'stop' };
        return;
      }
      yield { kind: 'tool_call', toolCallId: `t${providerCalls}`, toolName: 'echo', args: { n: providerCalls } };
      yield { kind: 'finish', reason: 'tool_calls' };
    };
    const { registry } = newRegistryWithCounter();
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-extend',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'echo', description: 'e', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
      maxToolLoopIterations: 2,
      maxToolLoopHardCap: 5,
    });
    const events = await collect(harness.run());
    const extended = events.filter(
      (e) => e.type === 'error' && (e as { code?: string }).code === 'tool_budget_extended',
    );
    expect(extended.length).toBeGreaterThan(0);
    const allText = events
      .filter((e) => e.type === 'message_delta')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(allText).toContain('wrapped up');
    // Soft 2 + extensions up to hard 5 + final-answer call > soft alone
    expect(providerCalls).toBeGreaterThan(3);
  });

  it('does NOT trigger a final-answer turn when the loop ended on a non-tool finish', async () => {
    // Normal turn: text then stop. No tool loop → no final-answer call.
    let calls = 0;
    const provider: ProviderStreamFn = async function* () {
      calls++;
      yield { kind: 'text', delta: 'plain answer' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-no-final',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      providerStream: provider,
    });
    const events = await collect(harness.run());
    // Exactly one provider call (the normal turn); no extra final-answer call.
    expect(calls).toBe(1);
    const messageEnds = events.filter((e) => e.type === 'message_end');
    expect(messageEnds).toHaveLength(1);
  });
});
