import { describe, expect, it } from 'vitest';
import { runWithLimit } from './asyncLimit.js';

/** Fake async unit of work that records start order and peak concurrency. */
function tracker(): { started: number[]; peak: number; inFlight: number } {
  return { started: [], peak: 0, inFlight: 0 };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('runWithLimit (Int 3b bounded fan-out)', () => {
  it('starts the first wave in input order and runs every item', async () => {
    const t = tracker();
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

    await runWithLimit(items, 3, async (item) => {
      t.started.push(item);
      await tick(1);
    });

    expect(t.started).toHaveLength(items.length);
    expect(t.started.slice(0, 3)).toEqual([0, 1, 2]); // input order, first wave
    expect([...t.started].sort((a, b) => a - b)).toEqual(items);
  });

  it('runs items strictly in input order when the limit covers the whole list', async () => {
    const t = tracker();

    await runWithLimit([0, 1, 2, 3], 4, async (item) => {
      t.started.push(item);
      await tick(1);
    });

    expect(t.started).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the concurrency cap', async () => {
    const t = tracker();
    const items = Array.from({ length: 12 }, (_, index) => index);

    await runWithLimit(items, 4, async (item) => {
      t.started.push(item);
      t.inFlight += 1;
      t.peak = Math.max(t.peak, t.inFlight);
      await tick(5);
      t.inFlight -= 1;
    });

    expect(t.started).toHaveLength(items.length);
    expect(t.peak).toBe(4); // all four slots taken: parallelism really happened
  });

  it('clamps limit 0, negative and NaN to 1 (sequential, never deadlocked)', async () => {
    for (const limit of [0, -3, Number.NaN]) {
      const t = tracker();
      await runWithLimit([0, 1, 2], limit, async (item) => {
        t.started.push(item);
        t.inFlight += 1;
        t.peak = Math.max(t.peak, t.inFlight);
        await tick(1);
        t.inFlight -= 1;
      });
      expect(t.started).toEqual([0, 1, 2]);
      expect(t.peak).toBe(1);
    }
  });

  it('runs every item when limit > items.length and resolves with undefined', async () => {
    const t = tracker();

    const result = await runWithLimit([0, 1], 8, async (item) => {
      t.started.push(item);
      t.inFlight += 1;
      t.peak = Math.max(t.peak, t.inFlight);
      await tick(1);
      t.inFlight -= 1;
    });

    expect(result).toBeUndefined();
    expect(t.started).toEqual([0, 1]);
    expect(t.peak).toBe(2);
  });

  it('resolves immediately on an empty list without calling fn', async () => {
    let calls = 0;
    await runWithLimit([], 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it('rejects fast on the first failure, starting no further items, and stays reusable', async () => {
    const t = tracker();

    await expect(
      runWithLimit([0, 1, 2, 3], 1, async (item) => {
        t.started.push(item);
        if (item === 0) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await tick(5); // give any (incorrectly) queued work a chance to run
    expect(t.started).toEqual([0]); // fail-fast: 1..3 never started

    // The runner keeps no shared state: a subsequent call works normally.
    const after: number[] = [];
    await runWithLimit([4, 5], 2, async (item) => {
      after.push(item);
    });
    expect(after.sort((a, b) => a - b)).toEqual([4, 5]);
  });
});
