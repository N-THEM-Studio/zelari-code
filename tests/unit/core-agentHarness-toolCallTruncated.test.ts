/**
 * core-agentHarness-toolCallTruncated.test.ts — provider-truncated tool calls.
 *
 * When the provider ends a turn with finish_reason='tool_calls' but NO
 * complete tool_call arrived, the harness emits the recoverable
 * `tool_call_truncated` error and forces finish='stop' (existing behavior).
 * This suite pins the recovery contract on top: the guidance text must reach
 * the NEXT provider turn's model context exactly once — via the harness push
 * into the rolling history on the fallback path, and via the mirrored spine
 * `user.message` note on the spine path — with no duplicates across the two
 * channels (buildModelContext reads one channel, never both).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AgentHarness,
  TOOL_CALL_TRUNCATED_RECOVERY_MARKER,
  TOOL_CALL_TRUNCATED_RECOVERY_USER,
} from '@zelari/core/harness';
import type { ProviderStreamFn, AgentMessage } from '@zelari/core/harness';
import type { BrainEvent } from '@zelari/core/events';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import {
  deriveMessages,
  type DerivedMessage,
  type SessionEventEnvelope,
  type SessionEventKind,
} from '@zelari/core/session';
import { buildModelContext } from '../../src/cli/budget/modelContextBuilder.js';
import { mapBrainEventToSpine } from '../../src/cli/sessionSpine.js';

async function collect(stream: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

/** Tool registry with a counting echo tool (same shape as the finalAnswer suite). */
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

function countGuidance(messages: readonly AgentMessage[]): number {
  return messages.filter(
    (m) =>
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.includes(TOOL_CALL_TRUNCATED_RECOVERY_MARKER),
  ).length;
}

function envelope(
  seq: number,
  kind: SessionEventKind,
  data: Record<string, unknown>,
): SessionEventEnvelope {
  return {
    schemaVersion: 1,
    sessionId: 's-trunc-spine',
    seq,
    ts: seq,
    kind,
    actor: { type: 'system' },
    data,
  };
}

/** Truncated turn 1, then a normal recovery turn. */
function truncatedThenRecoveryProvider(onSecondTurn?: (messages: AgentMessage[]) => void): ProviderStreamFn {
  let turn = 0;
  return async function* (params) {
    turn++;
    if (turn === 1) {
      // The provider promises tool_calls but the stream dies before any
      // tool_call delta arrives — the truncation signature.
      yield { kind: 'finish', reason: 'tool_calls' };
      return;
    }
    onSecondTurn?.(params.messages);
    yield { kind: 'text', delta: 'recovered' };
    yield { kind: 'finish', reason: 'stop' };
  };
}

describe('AgentHarness — tool_call_truncated recovery', () => {
  it('emits a recoverable tool_call_truncated error and forces finish=stop', async () => {
    const { registry } = newRegistryWithCounter();
    let providerCalls = 0;
    const provider: ProviderStreamFn = async function* () {
      providerCalls++;
      if (providerCalls === 1) {
        yield { kind: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { kind: 'text', delta: 'recovered' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const messages: AgentMessage[] = [{ role: 'user', content: 'go' }];
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-trunc-detect',
      messages,
      tools: [{ name: 'echo', description: 'e', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
    });

    const events = await collect(harness.run());

    const truncErrs = events.filter(
      (e) => e.type === 'error' && (e as { code?: string }).code === 'tool_call_truncated',
    );
    expect(truncErrs).toHaveLength(1);
    expect((truncErrs[0] as { severity: string }).severity).toBe('recoverable');

    // finish was forced to 'stop' so the run ends cleanly (not as an error).
    const msgEnd = events.find((e) => e.type === 'message_end') as { finishReason?: string };
    expect(msgEnd.finishReason).toBe('stop');
    const agentEnd = events.find((e) => e.type === 'agent_end') as { reason?: string };
    expect(agentEnd.reason).toBe('completed');
    // The loop must NOT re-enter the provider for the same doomed call.
    expect(providerCalls).toBe(1);

    // The guidance lands in the rolling history for the next turn.
    expect(countGuidance(messages)).toBe(1);
    const last = messages[messages.length - 1] as { role: string; content: string };
    expect(last.role).toBe('user');
    expect(last.content).toBe(TOOL_CALL_TRUNCATED_RECOVERY_USER);
  });

  it('injects the guidance into the NEXT provider turn exactly once (fallback path)', async () => {
    const { registry } = newRegistryWithCounter();
    let nextTurnMessages: AgentMessage[] = [];
    const provider = truncatedThenRecoveryProvider((messages) => {
      nextTurnMessages = messages;
    });
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-trunc-next',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'echo', description: 'e', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
    });

    await collect(harness.run()); // turn 1: truncated
    await collect(harness.run()); // turn 2: recovery — must see the guidance

    expect(nextTurnMessages.length).toBeGreaterThan(0);
    expect(countGuidance(nextTurnMessages)).toBe(1);
  });

  it('reaches the model context exactly once on fallback AND spine paths', async () => {
    const { registry } = newRegistryWithCounter();
    const provider = truncatedThenRecoveryProvider();
    const history: AgentMessage[] = [{ role: 'user', content: 'go' }];
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-trunc-ctx',
      messages: history,
      tools: [{ name: 'echo', description: 'e', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
    });
    await collect(harness.run());

    // (a) Fallback path: no spine → the harness push is the only source.
    const fallback = await buildModelContext({
      fallbackHistory: history,
      phase: 'build',
      model: 'test-model',
    });
    expect(fallback.source).toBe('fallback');
    expect(countGuidance(fallback.history)).toBe(1);

    // (b) Spine path: the mirrored note derives a model-visible user message;
    // the harness push in fallbackHistory must NOT duplicate it
    // (buildModelContext prefers the derived surface, never fuses).
    const errorEvent = {
      type: 'error',
      id: 'e1',
      ts: 1,
      sessionId: 's-trunc-ctx',
      severity: 'recoverable',
      code: 'tool_call_truncated',
      message: 'Tool call was truncated',
    } as never;
    const mapped = mapBrainEventToSpine(errorEvent);
    expect(mapped).not.toBeNull();
    expect(mapped!.kind).toBe('user.message');
    expect((mapped!.data as { text?: string }).text).toBe(TOOL_CALL_TRUNCATED_RECOVERY_USER);

    const derived = deriveMessages([
      envelope(1, 'user.message', { text: 'go' }),
      envelope(2, 'assistant.message', { text: 'on it' }),
      {
        schemaVersion: 1,
        sessionId: 's-trunc-spine',
        seq: 3,
        ts: 3,
        kind: mapped!.kind as SessionEventKind,
        actor: mapped!.actor,
        data: mapped!.data,
      },
    ]) as DerivedMessage[];

    const spineResult = await buildModelContext({
      // Deliberately ALSO contains the harness push — the spine surface wins.
      fallbackHistory: history,
      session: {
        status: 'active',
        derivedPriorTurns: async () => derived,
      },
      phase: 'build',
      model: 'test-model',
    });
    expect(spineResult.source).toBe('session');
    expect(countGuidance(spineResult.history)).toBe(1);
  });

  it('never injects the guidance on a normal tool-call turn (regression)', async () => {
    const { registry, getCalls } = newRegistryWithCounter();
    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn++;
      if (turn === 1) {
        yield { kind: 'tool_call', toolCallId: 'c1', toolName: 'echo', args: {} };
        yield { kind: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { kind: 'text', delta: 'done' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const messages: AgentMessage[] = [{ role: 'user', content: 'go' }];
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-trunc-regression',
      messages,
      tools: [{ name: 'echo', description: 'e', parameters: {} }],
      toolRegistry: registry,
      providerStream: provider,
    });

    const events = await collect(harness.run());

    expect(events.some((e) => e.type === 'error' && (e as { code?: string }).code === 'tool_call_truncated')).toBe(false);
    expect(countGuidance(messages)).toBe(0);
    expect(getCalls()).toBe(1);
  });
});
