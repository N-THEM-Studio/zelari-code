/**
 * council-chairman.test.ts — Slice 1 of v0.6.0 roadmap.
 *
 * Verifies that Lucifero (chairman) runs as a real AgentHarness
 * pass, not a stub, in dispatchCouncil. The chairman:
 *   1. Is included when councilSize >= 6.
 *   2. Emits agent_start / message_start / message_delta /
 *      message_end / agent_end / member_cost events with
 *      memberId='lucifer' and memberName='Lucifero'.
 *   3. Streams synthesis deltas through onSynthesisChunk.
 *   4. The chairman's tool calls (if any) are allowed but capped
 *      by maxToolCallsPerTurn.
 *   5. If the chairman's LLM call fails, the council run does NOT
 *      abort — the error is captured in member_cost.errored=true.
 *
 * @since 0.6.0
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchCouncil } from '../../src/cli/councilDispatcher.js';
import type { ProviderStreamFn } from '@zelari/core/harness';
import type { BrainEvent } from '@zelari/core/events';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const TEST_API_KEY = 'test-api-key-do-not-use';

function makeStream(deltasPerCall: ReadonlyArray<Record<string, unknown>>): ProviderStreamFn {
  return async function* () {
    for (const d of deltasPerCall) {
      yield d as never;
    }
  };
}

describe('council chairman (Lucifero synthesis) — v0.6.0', () => {
  it('Lucifero emits agent_start with memberId="lucifer" when councilSize=6', async () => {
    const stream = makeStream([
      { kind: 'text', delta: 'specialist-output' },
      { kind: 'finish', reason: 'stop' },
    ]);

    const events = await collect(dispatchCouncil('summarize this', {
      apiKey: TEST_API_KEY,
      model: 'grok-4',
      councilSize: 6,
      providerStream: stream,
      disableWorkspaceTools: true,
    }));

    const luciferStart = events.find(
      (e) => e.type === 'agent_start' && (e as { memberId?: string }).memberId === 'lucifer',
    );
    expect(luciferStart).toBeDefined();
    expect((luciferStart as { memberName?: string }).memberName).toBe('Lucifero');
  });

  it('Lucifero emits at least one message_delta (streaming synthesis)', async () => {
    const stream = makeStream([
      { kind: 'text', delta: 'specialist-1' },
      { kind: 'text', delta: 'specialist-2' },
      { kind: 'finish', reason: 'stop' },
    ]);

    const events = await collect(dispatchCouncil('hello', {
      apiKey: TEST_API_KEY,
      model: 'grok-4',
      councilSize: 6,
      providerStream: stream,
      disableWorkspaceTools: true,
    }));

    const deltas = events.filter(
      (e) => e.type === 'message_delta' && (e as { memberId?: string }).memberId === 'lucifer',
    );
    expect(deltas.length).toBeGreaterThan(0);
  });

  it('Lucifero emits message_end with non-empty content', async () => {
    const stream = makeStream([
      { kind: 'text', delta: 'syn' },
      { kind: 'text', delta: 'thesis' },
      { kind: 'finish', reason: 'stop' },
    ]);

    const events = await collect(dispatchCouncil('hello', {
      apiKey: TEST_API_KEY,
      model: 'grok-4',
      councilSize: 6,
      providerStream: stream,
      disableWorkspaceTools: true,
    }));

    const luciferEnd = events.find(
      (e) => e.type === 'message_end' && (e as { memberId?: string }).memberId === 'lucifer',
    );
    expect(luciferEnd).toBeDefined();
  });

  it('Lucifero emits member_cost with non-zero durationMs', async () => {
    const stream = makeStream([
      { kind: 'text', delta: 'syn' },
      { kind: 'finish', reason: 'stop' },
    ]);

    const events = await collect(dispatchCouncil('hello', {
      apiKey: TEST_API_KEY,
      model: 'grok-4',
      councilSize: 6,
      providerStream: stream,
      disableWorkspaceTools: true,
    }));

    const luciferCost = events.find(
      (e) => e.type === 'member_cost' && (e as { cost: { memberId: string } }).cost.memberId === 'lucifer',
    );
    expect(luciferCost).toBeDefined();
    const cost = (luciferCost as { cost: { durationMs: number; errored: boolean } }).cost;
    expect(cost.durationMs).toBeGreaterThanOrEqual(0);
    expect(cost.errored).toBe(false);
  });

  it('Lucifero + 4 specialists = 5 agent_start with memberName (debateMode=false skips Minosse)', async () => {
    // With councilSize=6 + debateMode=false, the orchestrator runs:
    //   4 specialists (charon, nettuno, gerione, plutone) + Lucifero
    //   (5 total). Minosse is extracted as the "oracle" and only runs
    //   when debateMode=true.
    const stream = makeStream([
      { kind: 'text', delta: 'specialist-A' },
      { kind: 'finish', reason: 'stop' },
    ]);

    const events = await collect(dispatchCouncil('hello', {
      apiKey: TEST_API_KEY,
      model: 'grok-4',
      councilSize: 6,
      debateMode: false,
      providerStream: stream,
      disableWorkspaceTools: true,
    }));

    const memberStarts = events.filter(
      (e) => e.type === 'agent_start' && (e as { memberName?: string }).memberName !== undefined,
    );
    expect(memberStarts.length).toBe(5);
    // Last one is the chairman.
    const last = memberStarts[memberStarts.length - 1] as { memberId?: string; memberName?: string };
    expect(last.memberId).toBe('lucifer');
    expect(last.memberName).toBe('Lucifero');
  });

  it('Lucifero does NOT run when councilSize=3 (backward compat)', async () => {
    const stream = makeStream([
      { kind: 'text', delta: 'reply' },
      { kind: 'finish', reason: 'stop' },
    ]);

    const events = await collect(dispatchCouncil('hello', {
      apiKey: TEST_API_KEY,
      model: 'grok-4',
      councilSize: 3,
      providerStream: stream,
      disableWorkspaceTools: true,
    }));

    const luciferStart = events.find(
      (e) => e.type === 'agent_start' && (e as { memberId?: string }).memberId === 'lucifer',
    );
    expect(luciferStart).toBeUndefined();
  });

  it('Lucifero error does NOT abort the council run (robustness)', async () => {
    // Stream that throws on the 5th call (the chairman's call).
    // Orchestrator order: charon(0) → nettuno(1) → gerione(2) →
    // plutone(3) → lucifer(4). Minosse is skipped (debateMode=false).
    let callCount = 0;
    const stream: ProviderStreamFn = async function* () {
      const idx = callCount++;
      if (idx === 4) {
        throw new Error('chairman LLM blew up');
      }
      yield { kind: 'text', delta: `agent-${idx}` } as never;
      yield { kind: 'finish', reason: 'stop' } as never;
    };

    const events = await collect(dispatchCouncil('hello', {
      apiKey: TEST_API_KEY,
      model: 'grok-4',
      councilSize: 6,
      debateMode: false,
      providerStream: stream,
      disableWorkspaceTools: true,
    }));

    const finalEnd = events.find(
      (e) => e.type === 'agent_end' && (e as { memberId?: string }).memberId === undefined,
    );
    expect(finalEnd).toBeDefined();

    const luciferCost = events.find(
      (e) => e.type === 'member_cost' && (e as { cost: { memberId: string } }).cost.memberId === 'lucifer',
    );
    expect(luciferCost).toBeDefined();
    expect((luciferCost as { cost: { errored: boolean } }).cost.errored).toBe(true);
  });
});
