/**
 * Runtime control plane — queue + steering observer unit tests (PHASE 2).
 */
import { describe, expect, it } from 'vitest';
import { RuntimeControlQueue } from './RuntimeControlQueue.js';
import { SteeringObserver, renderSteers } from './SteeringObserver.js';
import type { SteerControlEvent, FollowUpControlEvent } from './types.js';
import {
  buildRuntimeObserverBus,
  runtimeObserversEnabled,
} from '../observers/ObserverBus.js';

function steer(id: string, text: string): SteerControlEvent {
  return { type: 'steer', id, text, ts: 1_000 };
}

function followUp(id: string, text: string): FollowUpControlEvent {
  return { type: 'follow_up', id, text, ts: 1_001 };
}

describe('RuntimeControlQueue', () => {
  it('is FIFO for peek and preserves arrival order across types', () => {
    const queue = new RuntimeControlQueue();
    queue.enqueue(steer('s1', 'first'));
    queue.enqueue(followUp('f1', 'second'));
    queue.enqueue({ type: 'cancel', id: 'c1', ts: 1_002 });

    expect(queue.size).toBe(3);
    expect(queue.peek()?.id).toBe('s1');
    expect(queue.size).toBe(3); // peek does not consume
  });

  it('drainSteers removes only steers, in order', () => {
    const queue = new RuntimeControlQueue();
    queue.enqueue(steer('s1', 'do not touch the database'));
    queue.enqueue(followUp('f1', 'later'));
    queue.enqueue(steer('s2', 'migrations are fine'));

    const steers = queue.drainSteers();
    expect(steers.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(queue.size).toBe(1);
    expect(queue.peek()?.id).toBe('f1');
    expect(queue.drainSteers()).toEqual([]);
  });

  it('drainFollowUps and drainCancels are independent', () => {
    const queue = new RuntimeControlQueue();
    queue.enqueue(followUp('f1', 'a'));
    queue.enqueue(followUp('f2', 'b'));
    queue.enqueue({ type: 'cancel', id: 'c1', reason: 'user', ts: 2 });

    expect(queue.drainFollowUps().map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(queue.drainCancels().map((c) => c.id)).toEqual(['c1']);
    expect(queue.size).toBe(0);
  });

  it('remove() deletes a pending control by id and reports misses', () => {
    const queue = new RuntimeControlQueue();
    queue.enqueue(steer('s1', 'x'));
    expect(queue.remove('s1')).toBe(true);
    expect(queue.size).toBe(0);
    expect(queue.remove('s1')).toBe(false);
  });
});

describe('renderSteers (spec §27)', () => {
  it('numbers steers verbatim without compacting, with the supersede note', () => {
    const out = renderSteers([
      steer('s1', 'Non toccare il database'),
      steer('s2', 'Anzi: puoi aggiungere una migration, ma non cancellare colonne'),
    ]);
    expect(out).toContain('Runtime user steering received during execution:');
    expect(out).toContain('[1]\nNon toccare il database');
    expect(out).toContain('[2]\nAnzi: puoi aggiungere una migration');
    expect(out).toContain('Later instructions may supersede earlier ones.');
  });
});

describe('SteeringObserver', () => {
  it('continues when the queue is empty and does not consume turn events', async () => {
    const queue = new RuntimeControlQueue();
    const observer = new SteeringObserver(queue);
    const result = await observer.onTurnEnd({
      id: 'e1',
      ts: 1,
      identity: {
        runId: 'r',
        agentId: 'a',
        role: 'lead',
        mode: 'kraken',
      },
      turn: 1,
    });
    expect(result).toEqual({ action: 'continue' });
  });

  it('injects drained steers as a runtime-steer user message', async () => {
    const queue = new RuntimeControlQueue();
    queue.enqueue(steer('s1', 'keep the schema'));
    const observer = new SteeringObserver(queue);
    const result = await observer.onTurnEnd({
      id: 'e2',
      ts: 2,
      identity: { runId: 'r', agentId: 'a', role: 'lead', mode: 'kraken' },
      turn: 2,
    });
    expect(result.action).toBe('inject');
    if (result.action === 'inject') {
      expect(result.message.role).toBe('user');
      expect(result.message.kind).toBe('runtime-steer');
      expect(result.message.content).toContain('keep the schema');
    }
    expect(queue.size).toBe(0); // drained
  });
});

describe('buildRuntimeObserverBus with a steering queue', () => {
  it('builds a steering-only bus even with the env flag off (explicit opt-in)', () => {
    expect(runtimeObserversEnabled()).toBe(false);
    const queue = new RuntimeControlQueue();
    const bus = buildRuntimeObserverBus({ steeringQueue: queue });
    expect(bus).toBeDefined();
    expect(bus!.size).toBe(1);
  });

  it('returns undefined with no queue and the flag off', () => {
    expect(buildRuntimeObserverBus()).toBeUndefined();
  });
});
