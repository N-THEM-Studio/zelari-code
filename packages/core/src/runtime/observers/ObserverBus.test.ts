import { describe, expect, it, vi } from 'vitest';
import { ObserverBus } from './ObserverBus.js';
import { composeObservers } from './composeObservers.js';
import { resolveInterventions } from './resolve.js';
import { CONTINUE } from './types.js';
import type {
  AgentObserver,
  ToolCallEvent,
  TurnEndEvent,
} from './types.js';

const identity = {
  runId: 'r1',
  agentId: 'a1',
  role: 'lead' as const,
  mode: 'kraken' as const,
};

const toolEvent: ToolCallEvent = {
  id: 'e1',
  ts: 1,
  identity,
  turn: 1,
  toolCallId: 't1',
  toolName: 'bash',
  args: { command: 'ls' },
};

const turnEvent: TurnEndEvent = { id: 'e2', ts: 2, identity, turn: 1 };

describe('resolveInterventions', () => {
  it('empty → continue', () => {
    expect(resolveInterventions([])).toEqual(CONTINUE);
  });

  it('continue + continue → continue', () => {
    expect(resolveInterventions([CONTINUE, CONTINUE])).toEqual(CONTINUE);
  });

  it('continue + retry → retry', () => {
    expect(
      resolveInterventions([CONTINUE, { action: 'retry', reason: 'again' }]),
    ).toEqual({ action: 'retry', reason: 'again' });
  });

  it('retry + stop → stop', () => {
    expect(
      resolveInterventions([
        { action: 'retry' },
        { action: 'stop', reason: 'x' },
      ]),
    ).toEqual({ action: 'stop', reason: 'x' });
  });

  it('deny_tool wins over stop', () => {
    expect(
      resolveInterventions([
        { action: 'stop', reason: 'x' },
        { action: 'deny_tool', reason: 'y' },
      ]),
    ).toEqual({ action: 'deny_tool', reason: 'y' });
  });
});

describe('ObserverBus', () => {
  it('runs observers in ascending priority order', async () => {
    const calls: string[] = [];
    const mk = (id: string): AgentObserver => ({
      onTurnEnd: async () => {
        calls.push(id);
        return CONTINUE;
      },
    });
    const bus = new ObserverBus([
      { id: 'low', priority: 90, failureMode: 'ignore', observer: mk('low') },
      { id: 'high', priority: 10, failureMode: 'ignore', observer: mk('high') },
      { id: 'mid', priority: 50, failureMode: 'ignore', observer: mk('mid') },
    ]);
    await bus.emit('onTurnEnd', turnEvent);
    expect(calls).toEqual(['high', 'mid', 'low']);
  });

  it('ignore failure → continue', async () => {
    const throwing: AgentObserver = {
      onTurnEnd: async () => {
        throw new Error('boom');
      },
    };
    const bus = new ObserverBus([
      { id: 'x', priority: 1, failureMode: 'ignore', observer: throwing },
    ]);
    expect(await bus.emit('onTurnEnd', turnEvent)).toEqual([CONTINUE]);
  });

  it('warn failure logs and continues', async () => {
    const logger = vi.fn();
    const throwing: AgentObserver = {
      onTurnEnd: async () => {
        throw new Error('boom');
      },
    };
    const bus = new ObserverBus(
      [{ id: 'x', priority: 1, failureMode: 'warn', observer: throwing }],
      { logger },
    );
    expect(await bus.emit('onTurnEnd', turnEvent)).toEqual([CONTINUE]);
    expect(logger).toHaveBeenCalledOnce();
  });

  it('fail-closed failure → stop intervention', async () => {
    const throwing: AgentObserver = {
      onToolCall: async () => {
        throw new Error('boom');
      },
    };
    const bus = new ObserverBus([
      { id: 'auth', priority: 10, failureMode: 'fail-closed', observer: throwing },
    ]);
    const results = await bus.emit('onToolCall', toolEvent);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ action: 'stop', code: 'OBSERVER_FAIL_CLOSED' });
  });

  it('emitResolved collapses to the highest action', async () => {
    const a: AgentObserver = { onToolCall: async () => ({ action: 'retry' }) };
    const b: AgentObserver = {
      onToolCall: async () => ({ action: 'stop', reason: 'x' }),
    };
    const bus = new ObserverBus([
      { id: 'a', priority: 1, failureMode: 'ignore', observer: a },
      { id: 'b', priority: 2, failureMode: 'ignore', observer: b },
    ]);
    const resolved = await bus.emitResolved('onToolCall', toolEvent);
    expect(resolved.action).toBe('stop');
  });
});

describe('composeObservers', () => {
  it('fans out in order', async () => {
    const order: string[] = [];
    const a: AgentObserver = {
      onTurnEnd: async () => {
        order.push('a');
        return CONTINUE;
      },
    };
    const b: AgentObserver = {
      onTurnEnd: async () => {
        order.push('b');
        return CONTINUE;
      },
    };
    await composeObservers([a, b]).onTurnEnd?.(turnEvent);
    expect(order).toEqual(['a', 'b']);
  });

  it('resolves the intervention across observers', async () => {
    const a: AgentObserver = { onToolCall: async () => CONTINUE };
    const b: AgentObserver = {
      onToolCall: async () => ({ action: 'retry', reason: 'again' }),
    };
    const result = await composeObservers([a, b]).onToolCall?.(toolEvent);
    expect(result).toEqual({ action: 'retry', reason: 'again' });
  });
});
