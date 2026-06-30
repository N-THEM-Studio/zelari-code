import { describe, it, expect } from 'vitest';
import { AgentHarness } from '../../src/main/core/AgentHarness.js';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';
import type { ProviderStreamFn, ProviderDelta } from '../../src/main/core/AgentHarness.js';
import type { BrainEvent, BrainErrorEvent, BrainAgentEndEvent } from '../../src/shared/events.js';

/** Drain an async iterable into an array. */
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('AgentHarness.cancel() (Task C.3.1)', () => {
  function slowStream(delays: number[]): ProviderStreamFn {
    return async function* () {
      for (const d of delays) {
        await new Promise((r) => setTimeout(r, d));
        yield { kind: 'text', delta: `chunk-${d}ms` };
      }
      yield { kind: 'finish', reason: 'stop' };
    };
  }

  it('cancel() mid-stream emits error event with severity=cancelled + code=cancelled', async () => {
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      providerStream: slowStream([5, 5, 5, 5, 5]),
    });
    const events: BrainEvent[] = [];
    const runPromise = (async () => {
      for await (const e of harness.run()) events.push(e);
    })();
    // Let the first chunk emit, then cancel.
    await new Promise((r) => setTimeout(r, 12));
    harness.cancel();
    await runPromise;
    const cancelEvent = events.find(
      (e): e is BrainErrorEvent => e.type === 'error' && e.severity === 'cancelled',
    );
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent?.code).toBe('cancelled');
  });

  it('cancel() mid-stream results in agent_end reason=cancelled', async () => {
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      providerStream: slowStream([5, 5, 5, 5]),
    });
    const events: BrainEvent[] = [];
    const runPromise = (async () => {
      for await (const e of harness.run()) events.push(e);
    })();
    await new Promise((r) => setTimeout(r, 12));
    harness.cancel();
    await runPromise;
    const agentEnd = events.find(
      (e): e is BrainAgentEndEvent => e.type === 'agent_end',
    );
    expect(agentEnd).toBeDefined();
    expect(agentEnd?.reason).toBe('cancelled');
  });

  it('cancel() is idempotent — multiple calls do not throw or double-emit', async () => {
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      providerStream: slowStream([5, 5]),
    });
    const events: BrainEvent[] = [];
    const runPromise = (async () => {
      for await (const e of harness.run()) events.push(e);
    })();
    await new Promise((r) => setTimeout(r, 8));
    expect(() => {
      harness.cancel();
      harness.cancel();
      harness.cancel();
    }).not.toThrow();
    await runPromise;
    const cancelEvents = events.filter(
      (e): e is BrainErrorEvent => e.type === 'error' && e.severity === 'cancelled',
    );
    // Exactly one cancellation event even with 3 cancel() calls.
    expect(cancelEvents.length).toBe(1);
  });

  it('cancel() aborts the AbortSignal passed to the provider', async () => {
    let capturedSignal: AbortSignal | undefined;
    const stream: ProviderStreamFn = async function* (params) {
      capturedSignal = params.signal;
      // Honor the signal — break the loop when aborted.
      while (!capturedSignal?.aborted) {
        await new Promise((r) => setTimeout(r, 2));
        yield { kind: 'text', delta: 'x' };
      }
      yield { kind: 'finish', reason: 'stop' };
    };
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      providerStream: stream,
    });
    const runPromise = (async () => {
      for await (const _e of harness.run()) {/* drain */}
    })();
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedSignal?.aborted).toBe(false);
    harness.cancel();
    await runPromise;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('cancel() before any run is a no-op (does not throw)', () => {
    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      providerStream: async function* () { yield { kind: 'finish', reason: 'stop' }; },
    });
    expect(() => harness.cancel()).not.toThrow();
  });
});

describe('slash command /steer --interrupt (Task C.3.2)', () => {
  it('/steer <text> (no flag) → kind=steer (legacy queue-only behavior)', () => {
    const result = handleSlashCommand('/steer please continue', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('steer');
    expect(result.steerText).toBe('please continue');
  });

  it('/steer --interrupt <text> → kind=steer_interrupt + steerText', () => {
    const result = handleSlashCommand('/steer --interrupt pivot to refactor', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('steer_interrupt');
    expect(result.steerText).toBe('pivot to refactor');
  });

  it('/steer -i <text> (short form) → kind=steer_interrupt + steerText', () => {
    const result = handleSlashCommand('/steer -i actually use the other file', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('steer_interrupt');
    expect(result.steerText).toBe('actually use the other file');
  });

  it('/steer --interrupt (no text) → kind=steer_interrupt + usage message', () => {
    const result = handleSlashCommand('/steer --interrupt', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('steer_interrupt');
    expect(result.steerText).toBeUndefined();
    expect(result.message).toMatch(/Usage/i);
    expect(result.message).toMatch(/--interrupt/);
  });

  it('/steer --interrupt with flag in middle of text is filtered correctly', () => {
    const result = handleSlashCommand('/steer --interrupt switch to plan B now', []);
    expect(result.kind).toBe('steer_interrupt');
    expect(result.steerText).toBe('switch to plan B now');
  });
});