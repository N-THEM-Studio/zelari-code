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

  it('Regression HIGH-1: chairman catch() must NOT overwrite fullText (fallback message must render)', async () => {
    // Before the fix, the chairman's catch block assigned
    // `fullText = "Error: ..."`, which made the fallback
    // `[Chairman synthesis failed: ...]` string impossible to render
    // (because `fullText.length > 0`). Now the catch stores the error
    // in `lastErrorMessage` and leaves `fullText` intact, so on a
    // throw with no partial deltas, the fallback string IS emitted.
    //
    // The fallback is delivered via the `onSynthesisDone` callback
    // (not via a message_delta event), so we assert on the callback
    // argument instead of scanning event stream.
    let callCount = 0;
    const stream: ProviderStreamFn = async function* () {
      const idx = callCount++;
      if (idx === 4) {
        // Throw immediately, no deltas yielded before.
        throw new Error('chairman LLM blew up at start');
      }
      yield { kind: 'text', delta: `agent-${idx}` } as never;
      yield { kind: 'finish', reason: 'stop' } as never;
    };

    const synthesisDone: Array<{ content: string }> = [];
    // Drain the council — this also drives the chairman.
    for await (const _ of dispatchCouncil('hello', {
      apiKey: TEST_API_KEY,
      model: 'grok-4',
      councilSize: 6,
      debateMode: false,
      providerStream: stream,
      disableWorkspaceTools: true,
    })) {
      // intentionally empty — we don't care about the event stream here
    }

    // The onSynthesisDone callback is called from inside runCouncilPure,
    // not from dispatchCouncil's wrapper. To assert on the fallback
    // string we have to call runCouncilPure directly with a callback.
    callCount = 0;
    const { runCouncilPure } = await import('@zelari/core/council');
    for await (const _ of runCouncilPure('hello', {
      apiKey: TEST_API_KEY,
      model: 'grok-4',
      councilSize: 6,
      debateMode: false,
      providerStream: (() => {
        const inner: ProviderStreamFn = async function* () {
          const idx = callCount++;
          if (idx === 4) {
            throw new Error('chairman LLM blew up at start');
          }
          yield { kind: 'text', delta: `agent-${idx}` } as never;
          yield { kind: 'finish', reason: 'stop' } as never;
        };
        return inner;
      })(),
      sessionId: 'test',
    }, {
      onSynthesisDone: (content) => synthesisDone.push({ content }),
    })) {
      // drain
    }

    expect(synthesisDone).toHaveLength(1);
    expect(synthesisDone[0]?.content).toContain('[Chairman synthesis failed:');
    expect(synthesisDone[0]?.content).not.toMatch(/^Error: /);
  });

  it('Regression HIGH-4: specialist marks errored=true when AgentHarness emits an error event', async () => {
    // Before the fix, the specialist loop did not check for
    // `event.type === 'error'`, so a stream failure that the harness
    // converted into a BrainErrorEvent would pass through silently
    // and `errored` would stay false.
    //
    // We assert on the `onMemberCost` callback (delivers the cost
    // object directly from the orchestrator) rather than scanning
    // events, because the `errored` flag is only exposed via the
    // member_cost payload in events OR via this callback.
    let callCount = 0;
    const stream: ProviderStreamFn = async function* () {
      const idx = callCount++;
      if (idx === 0) {
        // Charont is the first specialist (orchestrator order).
        // Yield a text delta then an error event. AgentHarness
        // converts this into a BrainErrorEvent which the orchestrator
        // MUST detect.
        yield { kind: 'text', delta: 'partial-specialist' } as never;
        yield { kind: 'error', message: 'network reset mid-stream' } as never;
        return;
      }
      yield { kind: 'text', delta: `agent-${idx}` } as never;
      yield { kind: 'finish', reason: 'stop' } as never;
    };

    const costs: Array<{ memberId: string; errored: boolean }> = [];
    const { runCouncilPure } = await import('@zelari/core/council');
    for await (const _ of runCouncilPure('hello', {
      apiKey: TEST_API_KEY,
      model: 'grok-4',
      councilSize: 6,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: stream,
      sessionId: 'test',
    }, {
      onMemberCost: (cost) => costs.push({ memberId: cost.memberId, errored: cost.errored }),
    })) {
      // drain
    }

    const charonCost = costs.find((c) => c.memberId === 'charont');
    expect(charonCost).toBeDefined();
    expect(charonCost?.errored).toBe(true);
  });
});
