import { describe, it, expect } from 'vitest';
import { providerFailover, collectDeltas } from '../../src/cli/providerFailover.js';
import type { ProviderDelta } from '../../src/main/core/AgentHarness.js';

const PARAMS = { messages: [] } as unknown as Parameters<import('../../src/main/core/AgentHarness.js').ProviderStreamFn>[0];

function okProvider(events: ProviderDelta[]) {
  return (async function* () {
    for (const e of events) yield e;
  }) as import('../../src/main/core/AgentHarness.js').ProviderStreamFn;
}

describe('providerFailover (Task B.4.3)', () => {
  it('passes through primary events when no failure', async () => {
    const primary = okProvider([
      { kind: 'text', delta: 'hello' },
      { kind: 'text', delta: ' world' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const fallback = okProvider([{ kind: 'finish', reason: 'stop' }]);
    const wrapped = providerFailover({ primary, fallback });
    const out = await collectDeltas(wrapped, PARAMS);
    expect(out).toEqual([
      { kind: 'text', delta: 'hello' },
      { kind: 'text', delta: ' world' },
      { kind: 'finish', reason: 'stop' },
    ]);
  });

  it('switches to fallback on primary error event', async () => {
    const primary = okProvider([
      { kind: 'text', delta: 'partial ' },
      { kind: 'error', message: 'upstream timeout' },
    ]);
    const fallback = okProvider([
      { kind: 'text', delta: 'from fallback' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const wrapped = providerFailover({ primary, fallback });
    const out = await collectDeltas(wrapped, PARAMS);
    // After the error, primary iterator ends. Then we emit a synthetic
    // "[failover] primary failed" error, then start the fallback.
    expect(out).toEqual([
      { kind: 'text', delta: 'partial ' },
      { kind: 'error', message: 'upstream timeout' },
      { kind: 'error', message: '[failover] primary failed, switching to fallback' },
      { kind: 'text', delta: 'from fallback' },
      { kind: 'finish', reason: 'stop' },
    ]);
  });

  it('switches to fallback on thrown fetch error', async () => {
    const primary: import('../../src/main/core/AgentHarness.js').ProviderStreamFn =
      (async function* () {
        yield { kind: 'text', delta: 'before ' };
        throw new Error('ECONNRESET');
      }) as never;
    const fallback = okProvider([
      { kind: 'text', delta: 'fallback' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const wrapped = providerFailover({ primary, fallback });
    const out = await collectDeltas(wrapped, PARAMS);
    expect(out).toEqual([
      { kind: 'text', delta: 'before ' },
      { kind: 'error', message: '[failover] primary threw: ECONNRESET' },
      { kind: 'text', delta: 'fallback' },
      { kind: 'finish', reason: 'stop' },
    ]);
  });

  it('does NOT failover on normal finish', async () => {
    const primary = okProvider([
      { kind: 'text', delta: 'all good' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const fallback = okProvider([
      { kind: 'text', delta: 'SHOULD NOT APPEAR' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const wrapped = providerFailover({ primary, fallback });
    const out = await collectDeltas(wrapped, PARAMS);
    expect(out).toEqual([
      { kind: 'text', delta: 'all good' },
      { kind: 'finish', reason: 'stop' },
    ]);
    // Confirm fallback was never called by checking it produced no deltas.
    expect(out.find((d) => d.kind === 'text' && d.delta === 'SHOULD NOT APPEAR')).toBeUndefined();
  });

  it('uses custom isTransientFailure predicate', async () => {
    const primary = okProvider([
      { kind: 'text', delta: 'first ' },
      { kind: 'finish', reason: 'length' }, // custom transient: length-finish
    ]);
    const fallback = okProvider([
      { kind: 'text', delta: 'fallback' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const wrapped = providerFailover({
      primary,
      fallback,
      isTransientFailure: (d) => d.kind === 'finish' && d.reason === 'length',
    });
    const out = await collectDeltas(wrapped, PARAMS);
    expect(out).toContainEqual({ kind: 'text', delta: 'fallback' });
  });

  it('emits error when fallback itself throws', async () => {
    const primary: import('../../src/main/core/AgentHarness.js').ProviderStreamFn =
      (async function* () {
        throw new Error('primary down');
      }) as never;
    const fallback: import('../../src/main/core/AgentHarness.js').ProviderStreamFn =
      (async function* () {
        yield { kind: 'text', delta: 'before throw' };
        throw new Error('fallback down');
      }) as never;
    const wrapped = providerFailover({ primary, fallback });
    const out = await collectDeltas(wrapped, PARAMS);
    // Expect: primary-throw error, then fallback-throw error.
    const errorMessages = out
      .filter((d): d is { kind: 'error'; message: string } => d.kind === 'error')
      .map((d) => d.message);
    expect(errorMessages).toContain('[failover] primary threw: primary down');
    expect(errorMessages).toContain('[failover] fallback also failed: fallback down');
  });
});