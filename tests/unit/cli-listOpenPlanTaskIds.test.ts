/**
 * cli-listOpenPlanTaskIds.test.ts — read-only open-task ids from plan.json.
 *
 * Missing/empty/corrupt plan → []; pending + in_progress kept in store order;
 * completed/cancelled/blocked excluded; never creates plan.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listOpenPlanTaskIds,
  planJsonPathFor,
} from '../../src/cli/workspace/planStore.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zelari-open-plan-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedPlan(tasks: Array<{ id: string; title: string; status: string }>): void {
  mkdirSync(join(dir, '.zelari'), { recursive: true });
  writeFileSync(
    join(dir, '.zelari', 'plan.json'),
    JSON.stringify({ schemaVersion: 1, counter: tasks.length, tasks }),
    'utf8',
  );
}

describe('listOpenPlanTaskIds', () => {
  it('returns [] when plan.json is missing and does not create it', async () => {
    const ids = await listOpenPlanTaskIds(dir);
    expect(ids).toEqual([]);
    expect(existsSync(planJsonPathFor(dir))).toBe(false);
  });

  it('returns [] when tasks is empty', async () => {
    seedPlan([]);
    expect(await listOpenPlanTaskIds(dir)).toEqual([]);
  });

  it('returns pending and in_progress ids in store order, excluding the rest', async () => {
    seedPlan([
      { id: 't1', title: 'one', status: 'pending' },
      { id: 't2', title: 'two', status: 'completed' },
      { id: 't3', title: 'three', status: 'in_progress' },
      { id: 't4', title: 'four', status: 'cancelled' },
      { id: 't5', title: 'five', status: 'blocked' },
      { id: 't6', title: 'six', status: 'pending' },
    ]);
    expect(await listOpenPlanTaskIds(dir)).toEqual(['t1', 't3', 't6']);
  });

  it('returns [] on corrupt plan.json without throwing', async () => {
    mkdirSync(join(dir, '.zelari'), { recursive: true });
    writeFileSync(join(dir, '.zelari', 'plan.json'), '{not json', 'utf8');
    expect(await listOpenPlanTaskIds(dir)).toEqual([]);
  });
});
