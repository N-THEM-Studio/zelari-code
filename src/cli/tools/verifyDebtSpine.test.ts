/**
 * K1.5 / F5 — verify-debt must survive a new TUI turn via the session spine.
 *
 * Fail-before (the hole): debt opened at turn N lives only in
 * `globalThis.__zelariGeneralVerifyDebt`. `useChatTurn` resets that map at
 * the start of turn N+1, so `hasOpenTaskVerifyDebt()` is false and the
 * strict-done gate reports a false green.
 *
 * After the fix: add/clear append `verify.debt_open` / `verify.debt_cleared`
 * on the envelope; replay of un-cleared opens hydrates the cache.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEventInput } from '@zelari/core/session';
import {
  addTaskVerifyObligation,
  clearTaskVerifyObligation,
  hasOpenTaskVerifyDebt,
  hydrateTaskVerifyDebtFromEvents,
  resetTaskVerifyObligation,
  taskVerifyObligation,
} from './taskTool.js';
import {
  bindVerifyDebtSpineEmit,
  emitVerifyDebtCleared,
  emitVerifyDebtOpen,
  flushVerifyDebtSpine,
  formatHeadlessVerifyDebtNotice,
  formatOpenVerifyDebtMessage,
  formatTuiVerifyDebtNotice,
  replayOpenVerifyDebts,
  resetVerifyDebtSpineState,
  VERIFY_DEBT_CLEARED,
  VERIFY_DEBT_OPEN,
} from './verifyDebtSpine.js';

function collector(): {
  events: SessionEventInput[];
  emit: (input: SessionEventInput) => Promise<{ seq: number }>;
} {
  const events: SessionEventInput[] = [];
  return {
    events,
    emit: async (input) => {
      events.push(input);
      return { seq: events.length };
    },
  };
}

beforeEach(() => {
  resetTaskVerifyObligation();
  resetVerifyDebtSpineState();
});

afterEach(() => {
  resetTaskVerifyObligation();
  resetVerifyDebtSpineState();
});

describe('K1.5 — debt evaporates across a TUI reset without spine replay (F5 hole)', () => {
  it('open debt at turn N is invisible at turn N+1 after store reset (the hole)', () => {
    addTaskVerifyObligation('task-1', {
      description: 'fix foo',
      detail: 'VERDICT: FAIL after rework',
    });
    expect(hasOpenTaskVerifyDebt()).toBe(true);

    // useChatTurn.dispatchPrompt does this at the start of every parent turn.
    resetTaskVerifyObligation();
    expect(hasOpenTaskVerifyDebt()).toBe(false);
  });

  it('open debt at turn N is visible at turn N+1 after spine replay', async () => {
    const { events, emit } = collector();
    bindVerifyDebtSpineEmit(emit);

    addTaskVerifyObligation('task-1', {
      description: 'fix foo',
      detail: 'VERDICT: FAIL after rework',
    });
    await flushVerifyDebtSpine();
    expect(hasOpenTaskVerifyDebt()).toBe(true);
    expect(events.some((e) => e.kind === VERIFY_DEBT_OPEN)).toBe(true);

    // Turn N+1: empty cache (new TUI turn / new process).
    resetTaskVerifyObligation();
    expect(hasOpenTaskVerifyDebt()).toBe(false);

    hydrateTaskVerifyDebtFromEvents(events);
    expect(hasOpenTaskVerifyDebt()).toBe(true);
    expect(taskVerifyObligation()?.description).toBe('fix foo');
    expect(taskVerifyObligation()?.detail).toBe('VERDICT: FAIL after rework');
  });
});

describe('K1.5 — envelope events verify.debt_open / verify.debt_cleared', () => {
  it('emitVerifyDebtOpen appends taskId, description, detail, timestamp', async () => {
    const { events, emit } = collector();
    const rec = await emitVerifyDebtOpen(emit, {
      taskId: 'task-1',
      description: 'fix foo',
      detail: 'VERDICT: FAIL',
      timestamp: 1_700_000_000_000,
    });
    expect(rec.recorded).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe(VERIFY_DEBT_OPEN);
    expect(events[0]!.actor).toMatchObject({ type: 'system' });
    expect(events[0]!.data).toMatchObject({
      taskId: 'task-1',
      description: 'fix foo',
      detail: 'VERDICT: FAIL',
      timestamp: 1_700_000_000_000,
    });
  });

  it('addTaskVerifyObligation emits verify.debt_open on the bound spine', async () => {
    const { events, emit } = collector();
    bindVerifyDebtSpineEmit(emit);
    addTaskVerifyObligation('g-1', { description: 'land K1.5', detail: 'unverified work' });
    await flushVerifyDebtSpine();
    const open = events.find((e) => e.kind === VERIFY_DEBT_OPEN);
    expect(open).toBeDefined();
    expect(open!.data).toMatchObject({
      taskId: 'g-1',
      description: 'land K1.5',
      detail: 'unverified work',
    });
    expect(typeof open!.data?.timestamp).toBe('number');
  });

  it('clearTaskVerifyObligation emits verify.debt_cleared exactly once', async () => {
    const { events, emit } = collector();
    bindVerifyDebtSpineEmit(emit);
    addTaskVerifyObligation('g-1', { description: 'land K1.5' });
    await flushVerifyDebtSpine();

    clearTaskVerifyObligation('g-1');
    await flushVerifyDebtSpine();
    clearTaskVerifyObligation('g-1');
    await flushVerifyDebtSpine();

    const cleared = events.filter((e) => e.kind === VERIFY_DEBT_CLEARED);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.data).toMatchObject({ taskId: 'g-1' });
  });

  it('emitVerifyDebtCleared is a no-op the second time for the same taskId', async () => {
    const { events, emit } = collector();
    const first = await emitVerifyDebtCleared(emit, { taskId: 'g-1' });
    const second = await emitVerifyDebtCleared(emit, { taskId: 'g-1' });
    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(events.filter((e) => e.kind === VERIFY_DEBT_CLEARED)).toHaveLength(1);
  });
});

describe('K1.5 — replay of un-cleared opens', () => {
  it('replayOpenVerifyDebts keeps opens that have no later clear', () => {
    const open = replayOpenVerifyDebts([
      {
        kind: VERIFY_DEBT_OPEN,
        data: { taskId: 'a', description: 'A', detail: 'fail-a' },
      },
      {
        kind: VERIFY_DEBT_OPEN,
        data: { taskId: 'b', description: 'B' },
      },
      { kind: VERIFY_DEBT_CLEARED, data: { taskId: 'a' } },
    ]);
    expect([...open.keys()]).toEqual(['b']);
    expect(open.get('b')?.description).toBe('B');
  });

  it('a later open after clear is open again', () => {
    const open = replayOpenVerifyDebts([
      { kind: VERIFY_DEBT_OPEN, data: { taskId: 'a', description: 'A1' } },
      { kind: VERIFY_DEBT_CLEARED, data: { taskId: 'a' } },
      { kind: VERIFY_DEBT_OPEN, data: { taskId: 'a', description: 'A2' } },
    ]);
    expect(open.get('a')?.description).toBe('A2');
  });

  it('hydrate after clear-on-envelope leaves the cache empty', () => {
    hydrateTaskVerifyDebtFromEvents([
      { kind: VERIFY_DEBT_OPEN, data: { taskId: 'a', description: 'A' } },
      { kind: VERIFY_DEBT_CLEARED, data: { taskId: 'a' } },
    ]);
    expect(hasOpenTaskVerifyDebt()).toBe(false);
  });
});

/**
 * K3.3 / F16 — replay of one session's log must land in THAT session's bucket.
 * Fail-before: hydrate filled the single process-wide map, so a concurrent
 * session replayed its debt into every other session's view.
 */
describe('K3.3 — hydrate/read are scoped to the session that owns the log (F16)', () => {
  it('replays into the owning session, stays invisible to a sibling, feeds the id-less gate', () => {
    hydrateTaskVerifyDebtFromEvents(
      [{ kind: VERIFY_DEBT_OPEN, data: { taskId: 'h-1', description: 'hydrated' } }],
      'sess-h',
    );

    // Owned by the session whose log it is…
    expect(hasOpenTaskVerifyDebt('sess-h')).toBe(true);
    expect(taskVerifyObligation('sess-h')?.description).toBe('hydrated');
    // …invisible to a concurrent session…
    expect(hasOpenTaskVerifyDebt('sess-other')).toBe(false);
    // …and still seen (fail-closed) by the id-less strict-done gate.
    expect(hasOpenTaskVerifyDebt()).toBe(true);
    expect(taskVerifyObligation()?.description).toBe('hydrated');

    // A session-scoped reset drops only that session's replayed debt.
    resetTaskVerifyObligation('sess-h');
    expect(hasOpenTaskVerifyDebt('sess-h')).toBe(false);
    expect(hasOpenTaskVerifyDebt()).toBe(false);
  });
});

describe('K1.5 — TUI and headless share the debt notice', () => {
  it('formatOpenVerifyDebtMessage is the shared core', () => {
    const debt = { description: 'fix foo', detail: 'VERDICT: FAIL after rework' };
    const core = formatOpenVerifyDebtMessage(debt);
    expect(core).toBe(
      'task general "fix foo" finished without a passing verify (VERDICT: FAIL after rework)',
    );
    expect(formatTuiVerifyDebtNotice(debt)).toContain(core);
    expect(formatHeadlessVerifyDebtNotice(debt, 4)).toContain(core);
    expect(formatTuiVerifyDebtNotice(debt)).toContain('turn is NOT verified-complete');
    expect(formatHeadlessVerifyDebtNotice(debt, 4)).toContain('strict done blocked (exit 4)');
  });
});
