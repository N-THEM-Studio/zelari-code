import { describe, it, expect } from 'vitest';
import { runCouncilPure } from '@zelari/core/council';
import type { ProviderStreamFn } from '@zelari/core/harness';
import type { BrainEvent } from '@zelari/core/events';

function hangUntilAbort(): ProviderStreamFn {
  return async function* (params) {
    yield { kind: 'text', delta: 'partial' };
    const signal = params.signal;
    if (!signal) return;
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
}

function fastStream(): ProviderStreamFn {
  return async function* () {
    yield { kind: 'text', delta: 'ok' };
    yield { kind: 'finish', reason: 'stop' };
  };
}

function memberNames(events: BrainEvent[]): string[] {
  const names: string[] = [];
  for (const event of events) {
    if (event.type !== 'agent_start') continue;
    const name = (event as BrainEvent & { memberName?: string }).memberName;
    if (name) names.push(name);
  }
  return names;
}

function outerEndReason(events: BrainEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'agent_end') continue;
    const memberName = (event as BrainEvent & { memberName?: string }).memberName;
    if (!memberName) return (event as { reason?: string }).reason;
  }
  return undefined;
}

describe('runCouncilPure cooperative cancel', () => {
  it('already-aborted signal skips every member and ends cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const events: BrainEvent[] = [];
    for await (const event of runCouncilPure('hello', {
      apiKey: 'k',
      model: 'm',
      provider: 'p',
      councilSize: 6,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: hangUntilAbort(),
      signal: ac.signal,
    })) {
      events.push(event);
    }
    expect(memberNames(events)).toEqual([]);
    expect(outerEndReason(events)).toBe('cancelled');
  });

  it('abort during the first member skips the rest of the roster', async () => {
    const ac = new AbortController();
    const events: BrainEvent[] = [];
    for await (const event of runCouncilPure('hello', {
      apiKey: 'k',
      model: 'm',
      provider: 'p',
      councilSize: 6,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: hangUntilAbort(),
      signal: ac.signal,
    })) {
      events.push(event);
      if (event.type === 'message_delta') ac.abort();
    }
    expect(memberNames(events)).toEqual(['Caronte']);
    expect(memberNames(events)).not.toContain('Lucifero');
    expect(outerEndReason(events)).toBe('cancelled');
  });

  it('without a signal the council still completes', async () => {
    const events: BrainEvent[] = [];
    for await (const event of runCouncilPure('hello', {
      apiKey: 'k',
      model: 'm',
      provider: 'p',
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: fastStream(),
    })) {
      events.push(event);
    }
    expect(outerEndReason(events)).toBe('completed');
    expect(memberNames(events)).toContain('Caronte');
  });
});
