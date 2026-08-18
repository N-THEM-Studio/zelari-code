/**
 * turnRuntime.test — KrakenTurnRuntime phase projection (Fase 2, ADR-0020).
 *
 * Covers the deterministic derivation:
 *   understanding → exploring → implementing|planning → verifying → completed
 * and the sparse emission contract (only on phase change).
 */
import { describe, expect, it } from 'vitest';
import { createBrainEvent, type BrainEvent, type BrainKrakenProgressEvent } from '@zelari/core/events';
import { KrakenTurnRuntime, type KrakenTurnRuntimeOptions } from './turnRuntime.js';

function harness(mode: 'plan' | 'build', extra: Partial<KrakenTurnRuntimeOptions> = {}) {
  const events: BrainKrakenProgressEvent[] = [];
  let t = 1_000;
  const rt = new KrakenTurnRuntime({
    mode,
    sessionId: 'test-session',
    onProgress: (ev) => events.push(ev),
    now: () => t++,
    ...extra,
  });
  return {
    rt,
    events,
    phases: () => events.map((e) => e.progress.phase),
    toolStart: (toolName: string, toolCallId: string, args: Record<string, unknown> = {}) =>
      rt.observe(
        createBrainEvent('tool_execution_start', 'test-session', {
          toolCallId,
          toolName,
          args,
        }),
      ),
    toolEnd: (toolCallId: string, isError = false) =>
      rt.observe(
        createBrainEvent('tool_execution_end', 'test-session', {
          toolCallId,
          result: '',
          isError,
          durationMs: 5,
        }),
      ),
  };
}

describe('KrakenTurnRuntime — build mode', () => {
  it('emits understanding at beginTurn and derives exploring on first task', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolStart('task', 't1', { agent: 'explore' });
    expect(h.phases()).toEqual(['understanding', 'exploring']);
    expect(h.events.at(-1)?.progress.exploreTentacles).toBe(1);
    expect(h.events.at(-1)?.progress.tentacles).toBe(1);
  });

  it('write success transitions to implementing (end carries the tool name)', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolStart('write_file', 'w1', { path: 'a.ts' });
    h.toolEnd('w1');
    expect(h.phases()).toEqual(['understanding', 'implementing']);
    expect(h.rt.snapshot().writes).toBe(1);
  });

  it('verify tentacle transitions to verifying, then back to implementing after writes', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolStart('write_file', 'w1', { path: 'a.ts' });
    h.toolEnd('w1');
    h.toolStart('task', 't1', { agent: 'verify' });
    expect(h.phases()).toEqual(['understanding', 'implementing', 'verifying']);
    h.toolEnd('t1');
    // writes > 0 → back to implementing when the last tentacle lands
    expect(h.phases()).toEqual([
      'understanding',
      'implementing',
      'verifying',
      'implementing',
    ]);
    expect(h.rt.snapshot().verifyTentacles).toBe(1);
  });

  it('finish(completed) projects completed; cancelled/error do not', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.rt.finish('cancelled');
    expect(h.phases()).toEqual(['understanding']);
    h.rt.finish('completed');
    expect(h.phases()).toEqual(['understanding', 'completed']);
  });

  it('emits ONLY on phase change (sparse contract)', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolStart('write_file', 'w1', { path: 'a.ts' });
    h.toolEnd('w1');
    h.toolStart('write_file', 'w2', { path: 'b.ts' });
    h.toolEnd('w2');
    h.toolStart('read_file', 'r1', { path: 'c.ts' });
    h.toolEnd('r1');
    // second write and reads do not re-emit: still 2 events
    expect(h.phases()).toEqual(['understanding', 'implementing']);
    // but counters ride the snapshot
    expect(h.rt.snapshot().writes).toBe(2);
  });

  it('a failed write does not count and does not transition', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolStart('write_file', 'w1', { path: 'a.ts' });
    h.toolEnd('w1', true);
    expect(h.phases()).toEqual(['understanding']);
    expect(h.rt.snapshot().writes).toBe(0);
  });
});

describe('KrakenTurnRuntime — plan mode', () => {
  it('after the last explore tentacle lands, planning is projected', () => {
    const h = harness('plan');
    h.rt.beginTurn();
    h.toolStart('task', 't1', { agent: 'explore' });
    h.toolStart('task', 't2', { agent: 'explore' });
    h.toolEnd('t1');
    expect(h.phases()).toEqual(['understanding', 'exploring']);
    h.toolEnd('t2');
    expect(h.phases()).toEqual(['understanding', 'exploring', 'planning']);
  });

  it('a verify tentacle in plan still projects verifying (recovery-research)', () => {
    const h = harness('plan');
    h.rt.beginTurn();
    h.toolStart('task', 't1', { agent: 'verify' });
    expect(h.phases()).toEqual(['understanding', 'verifying']);
    h.toolEnd('t1');
    expect(h.phases()).toEqual(['understanding', 'verifying', 'planning']);
  });

  it('events carry mode: plan and the phaseEnteredAt clock', () => {
    const h = harness('plan');
    h.rt.beginTurn();
    expect(h.events[0].progress.mode).toBe('plan');
    expect(h.events[0].progress.phaseEnteredAt).toBeGreaterThanOrEqual(1_000);
  });
});

describe('KrakenTurnRuntime — robustness', () => {
  it('unknown events are ignored without emission', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.rt.observe(
      createBrainEvent('message_delta', 'test-session', { messageId: 'm1', delta: 'x' }),
    );
    h.rt.observe(createBrainEvent('queue_update', 'test-session', { queuedCount: 1 }));
    expect(h.phases()).toEqual(['understanding']);
  });

  it('a throwing sink never breaks observe', () => {
    const rt = new KrakenTurnRuntime({
      mode: 'build',
      sessionId: 's',
      onProgress: () => {
        throw new Error('sink down');
      },
    });
    expect(() => {
      rt.beginTurn();
      rt.observe(
        createBrainEvent('tool_execution_start', 's', {
          toolCallId: 't1',
          toolName: 'task',
          args: { agent: 'explore' },
        }),
      );
    }).not.toThrow();
    expect(rt.snapshot().phase).toBe('exploring');
  });

  it('beginPass resets the phase for a recovery pass but keeps counters', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolStart('task', 't1', { agent: 'explore' });
    h.toolEnd('t1');
    h.rt.beginPass();
    expect(h.phases()).toEqual(['understanding', 'exploring', 'understanding']);
    expect(h.rt.snapshot().tentacles).toBe(1);
  });

  it('task end events without a matching start are tolerated', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolEnd('ghost');
    expect(h.phases()).toEqual(['understanding']);
    expect(h.rt.snapshot().tentacles).toBe(0);
  });
});

describe('selecting phase (ADR-0020 Fase 4)', () => {
  it('kraken_select start → selecting; later task(verify) still wins → verifying', () => {
    const events: BrainKrakenProgressEvent[] = [];
    const rt = new KrakenTurnRuntime({
      mode: 'build',
      sessionId: 's-select',
      onProgress: (e) => events.push(e),
      now: () => 1000,
    });
    rt.beginTurn();
    rt.observe({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'kraken_select',
      args: {},
    } as unknown as BrainEvent);
    expect(rt.snapshot().phase).toBe('selecting');
    rt.observe({
      type: 'tool_execution_start',
      toolCallId: 'c2',
      toolName: 'task',
      args: { agent: 'verify' },
    } as unknown as BrainEvent);
    expect(rt.snapshot().phase).toBe('verifying');
    expect(events.map((e) => e.progress.phase)).toEqual([
      'understanding',
      'selecting',
      'verifying',
    ]);
  });
});

describe('checkTotal refresh (ADR-0020 Fase 6)', () => {
  it('kraken_select end refreshes the payload without a phase change', () => {
    const h = harness('build', { loadCheckTotal: () => 3 });
    h.rt.beginTurn();
    h.toolStart('kraken_select', 'sel1');
    h.toolEnd('sel1');
    expect(h.phases()).toEqual(['understanding', 'selecting', 'selecting']);
    const last = h.events[h.events.length - 1];
    expect(last.progress.checkTotal).toBe(3);
  });

  it('checkTotal rides later phase payloads', () => {
    const h = harness('build', { loadCheckTotal: () => 2 });
    h.rt.beginTurn();
    h.toolStart('kraken_select', 'sel1');
    h.toolEnd('sel1');
    h.toolStart('task', 't1', { agent: 'verify' });
    const last = h.events[h.events.length - 1];
    expect(last.progress.phase).toBe('verifying');
    expect(last.progress.checkTotal).toBe(2);
  });

  it('no loader → no checkTotal, no extra event', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolStart('kraken_select', 'sel1');
    const before = h.events.length;
    h.toolEnd('sel1');
    expect(h.events.length).toBe(before);
    expect(h.rt.snapshot().checkTotal).toBeUndefined();
  });

  it('loader returning 0 does not set the counter', () => {
    const h = harness('build', { loadCheckTotal: () => 0 });
    h.rt.beginTurn();
    h.toolStart('kraken_select', 'sel1');
    const before = h.events.length;
    h.toolEnd('sel1');
    expect(h.events.length).toBe(before);
    expect(h.rt.snapshot().checkTotal).toBeUndefined();
  });

  it('same count on a second kraken_select does not re-emit', () => {
    const h = harness('build', { loadCheckTotal: () => 3 });
    h.rt.beginTurn();
    h.toolStart('kraken_select', 'sel1');
    h.toolEnd('sel1');
    const after = h.events.length;
    h.toolStart('kraken_select', 'sel2'); // same phase → no emit
    h.toolEnd('sel2'); // same count → no refresh
    expect(h.events.length).toBe(after);
  });
});

describe('Fase 7 — checksPassed refresh on verify tentacle end', () => {
  it('verify end (no writes) refreshes checksPassed in-phase', () => {
    let passed = 2;
    const h = harness('build', { loadChecksPassed: () => passed });
    h.rt.beginTurn();
    h.toolStart('task', 'v1', { agent: 'verify' });
    expect(h.phases()).toEqual(['understanding', 'verifying']);
    h.toolEnd('v1');
    expect(h.phases()).toEqual(['understanding', 'verifying', 'verifying']);
    const last = h.events.at(-1)?.progress;
    expect(last?.checksPassed).toBe(2);
    expect(last?.verifyTentacles).toBe(1);
  });

  it('verify end after writes carries checksPassed in the single transition event', () => {
    const h = harness('build', { loadChecksPassed: () => 1 });
    h.rt.beginTurn();
    h.toolStart('write_file', 'w1', { path: 'a.ts' });
    h.toolEnd('w1');
    h.toolStart('task', 'v1', { agent: 'verify' });
    const before = h.events.length;
    h.toolEnd('v1');
    expect(h.events.length).toBe(before + 1); // sparse: one event, not two
    expect(h.phases().at(-1)).toBe('implementing');
    expect(h.events.at(-1)?.progress.checksPassed).toBe(1);
  });

  it('unchanged counter does not re-emit (sparse stream)', () => {
    const h = harness('build', { loadChecksPassed: () => 1 });
    h.rt.beginTurn();
    h.toolStart('task', 'v1', { agent: 'verify' });
    h.toolEnd('v1');
    const count = h.events.length;
    h.toolStart('task', 'v2', { agent: 'verify' });
    h.toolEnd('v2');
    // same value the second time → no extra emit for v2 (sparse stream)
    expect(h.events.length).toBe(count);
  });

  it('a second verify with a better count updates the counter', () => {
    let passed = 1;
    const h = harness('build', { loadChecksPassed: () => passed });
    h.rt.beginTurn();
    h.toolStart('task', 'v1', { agent: 'verify' });
    h.toolEnd('v1');
    passed = 3; // repair pass: re-verification now green
    h.toolStart('task', 'v2', { agent: 'verify' });
    h.toolEnd('v2');
    const last = h.events.at(-1)?.progress;
    expect(last?.checksPassed).toBe(3);
  });

  it('loader returning undefined emits nothing and omits the field', () => {
    const h = harness('build', { loadChecksPassed: () => undefined });
    h.rt.beginTurn();
    h.toolStart('task', 'v1', { agent: 'verify' });
    h.toolEnd('v1');
    const last = h.events.at(-1)?.progress;
    expect(last?.checksPassed).toBeUndefined();
    expect('checksPassed' in (last ?? {})).toBe(false);
  });

  it('explore tentacle end never triggers the check refresh', () => {
    const h = harness('build', {
      loadChecksPassed: () => {
        throw new Error('must not be called for explore tentacles');
      },
    });
    h.rt.beginTurn();
    h.toolStart('task', 'e1', { agent: 'explore' });
    h.toolEnd('e1');
    expect(h.phases()).toEqual(['understanding', 'exploring']);
    expect(h.events.at(-1)?.progress.checksPassed).toBeUndefined();
  });

  it('no loader → verify end behaves exactly as before (phase only)', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolStart('task', 'v1', { agent: 'verify' });
    h.toolEnd('v1');
    expect(h.phases()).toEqual(['understanding', 'verifying']);
    expect('checksPassed' in (h.events.at(-1)?.progress ?? {})).toBe(false);
  });
});

describe('KrakenTurnRuntime — repair pass (Fase 8)', () => {
  it('beginPass(true) projects repairing and keeps turn counters', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolStart('task', 'e1', { agent: 'explore' });
    h.toolEnd('e1');
    h.rt.finish('completed');
    h.rt.beginPass(true);
    expect(h.phases()).toEqual([
      'understanding',
      'exploring',
      'completed',
      'repairing',
    ]);
    const last = h.events.at(-1)?.progress;
    expect(last?.tentacles).toBe(1); // counters describe the WHOLE turn
    expect(last?.exploreTentacles).toBe(1);
  });

  it('during repair, verify tentacles still transition to verifying', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.rt.beginPass(true);
    h.toolStart('task', 'v1', { agent: 'verify' });
    expect(h.phases()).toEqual(['understanding', 'repairing', 'verifying']);
  });

  it('beginPass() without args still restarts at understanding (write-retry path)', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.toolStart('task', 'v1', { agent: 'verify' });
    h.rt.beginPass();
    expect(h.phases()).toEqual(['understanding', 'verifying', 'understanding']);
  });

  it('repair pass can finish completed after re-verification', () => {
    const h = harness('build');
    h.rt.beginTurn();
    h.rt.beginPass(true);
    h.toolStart('task', 'v1', { agent: 'verify' });
    h.toolEnd('v1');
    h.rt.finish('completed');
    expect(h.phases()).toEqual([
      'understanding',
      'repairing',
      'verifying',
      'completed',
    ]);
  });
});
