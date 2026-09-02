/**
 * taskOverlap.test.ts — t60 acceptance: overlap guard on task_create /
 * task_update(status -> in_progress) is advisory-only — one radio event
 * + note + flag, never blocks the call.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlanTaskTools } from '../tools/planTaskTools.js';
import { findOverlappingTasks, globsIntersect } from './taskOverlap.js';
import type { PlanTask } from './planStore.js';

let dir: string;
let radioFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zelari-t60-'));
  radioFile = join(dir, '.zelari', 'radio', 't60-test.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type AnyTool<T> = {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (
    input: any,
    ctx: any,
  ) => Promise<{ ok: true; value: T } | { ok: false; error: string }>;
};

function makeTools() {
  const tools = createPlanTaskTools({ projectRoot: dir, sessionId: 't60-test' });
  return {
    create: tools[0] as unknown as AnyTool<{
      id: string;
      task: PlanTask;
      overlapWarning?: string[];
    }>,
    update: tools[1] as unknown as AnyTool<{
      task: PlanTask;
      overlapWarning?: string[];
    }>,
  };
}

function readRadio(): { kind: string; description: string; contestedFile?: string }[] {
  if (!existsSync(radioFile)) return [];
  return readFileSync(radioFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { kind: string; description: string; contestedFile?: string });
}

function radioOverlap() {
  return readRadio().filter((e) => e.kind === 'task_overlap');
}

describe('globsIntersect (pure)', () => {
  it('matches exact, subtree and suffix overlaps in both directions', () => {
    expect(globsIntersect(['src/api/routes.ts'], ['src/api/routes.ts'])).toBe(
      'src/api/routes.ts',
    );
    // subtree declared by the OTHER task
    expect(globsIntersect(['src/api/routes.ts'], ['src/api/**'])).toBe('src/api/routes.ts');
    // subtree declared by the CANDIDATE
    expect(globsIntersect(['src/api/**'], ['src/api/routes.ts'])).toBe('src/api/**');
    // extension suffix (any depth)
    expect(globsIntersect(['*.ts'], ['packages/core/foo.ts'])).toBe('*.ts');
    expect(globsIntersect(['packages/core/foo.ts'], ['*.ts'])).toBe('packages/core/foo.ts');
  });

  it('returns null on disjoint globs and normalizes separators', () => {
    expect(globsIntersect(['*.ts'], ['*.md'])).toBeNull();
    expect(globsIntersect(['src/a/one.ts'], ['src/b/one.ts'])).toBeNull();
    expect(globsIntersect(['src\\api\\routes.ts'], ['src/api/**'])).toBe(
      'src\\api\\routes.ts',
    );
  });

  it('never overlaps on excluded subtrees', () => {
    expect(globsIntersect(['.zelari/plan.json'], ['.zelari/xx'])).toBeNull();
    expect(globsIntersect(['node_modules/pkg/a.js'], ['node_modules/xx'])).toBeNull();
  });
});

describe('findOverlappingTasks (pure)', () => {
  const task = (id: string, status: PlanTask['status'], files?: string[]): PlanTask => ({
    id,
    title: `task ${id}`,
    status,
    files,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  });

  it('counts only in_progress tasks with files, excludes self', () => {
    const tasks = [
      task('t1', 'in_progress', ['src/api/**']),
      task('t2', 'completed', ['src/api/other.ts']),
      task('t3', 'cancelled', ['src/api/other.ts']),
      task('t4', 'in_progress'),
      task('t5', 'pending', ['src/api/other.ts']),
    ];
    const hits = findOverlappingTasks(['src/api/routes.ts'], tasks, 't0');
    expect(hits.map((h) => h.task.id)).toEqual(['t1']);
    expect(hits[0].contested).toBe('src/api/routes.ts');
    // self-exclusion
    expect(findOverlappingTasks(['src/api/routes.ts'], tasks, 't1')).toEqual([]);
    // no candidate files -> no hits
    expect(findOverlappingTasks(undefined, tasks)).toEqual([]);
  });
});

describe('overlap guard via task tools (advisory-only)', () => {
  it('task_create with intersecting glob: 1 radio event + note + flag, call NOT blocked', async () => {
    const { create, update } = makeTools();
    const a = await create.execute({ title: 'A', files: ['src/api/**'] }, {});
    await update.execute({ id: a.value.id, status: 'in_progress' }, {});
    expect(radioOverlap()).toEqual([]);

    const b = await create.execute({ title: 'B', files: ['src/api/routes.ts'] }, {});
    expect(b.ok).toBe(true); // advisory never blocks
    expect(b.value.task.flags).toEqual(['overlap']);
    expect(b.value.task.notes).toContain('Overlap advisory (t60)');
    expect(b.value.overlapWarning).toEqual([`${a.value.id}: src/api/routes.ts`]);

    const events = radioOverlap();
    expect(events).toHaveLength(1);
    expect(events[0].description).toContain(a.value.id);
    expect(events[0].description).toContain(b.value.id);
    expect(events[0].contestedFile).toBe('src/api/routes.ts');
  });

  it('task_update(status -> in_progress) fires when a later task reaches in_progress', async () => {
    const { create, update } = makeTools();
    // Both created while nothing is in_progress: no advisory yet.
    const a = await create.execute({ title: 'A', files: ['src/shared/one.ts'] }, {});
    const b = await create.execute({ title: 'B', files: ['src/shared/**'] }, {});
    expect(radioOverlap()).toEqual([]);
    await update.execute({ id: a.value.id, status: 'in_progress' }, {});
    expect(radioOverlap()).toEqual([]); // B still pending

    const res = await update.execute({ id: b.value.id, status: 'in_progress' }, {});
    expect(res.ok).toBe(true);
    expect(res.value.task.flags).toEqual(['overlap']);
    expect(radioOverlap()).toHaveLength(1);
    expect(radioOverlap()[0].contestedFile).toBe('src/shared/**');
  });

  it('completed/cancelled tasks never count; updates that keep status quiet', async () => {
    const { create, update } = makeTools();
    const done = await create.execute({ title: 'D', files: ['src/x/one.ts'] }, {});
    await update.execute({ id: done.value.id, status: 'completed' }, {});
    const b = await create.execute({ title: 'B', files: ['src/x/two.ts'] }, {});
    await update.execute({ id: b.value.id, status: 'in_progress' }, {});
    // intersecting glob with a COMPLETED task only -> nothing
    expect(radioOverlap()).toEqual([]);
    // priority-only update on an in_progress task -> no re-advisory
    await update.execute({ id: b.value.id, priority: 'high' }, {});
    expect(radioOverlap()).toEqual([]);
  });

  it('no declared files -> no advisory; idempotent flag on repeat fires', async () => {
    const { create, update } = makeTools();
    const a = await create.execute({ title: 'A', files: ['*.py'] }, {});
    await update.execute({ id: a.value.id, status: 'in_progress' }, {});
    const b = await create.execute({ title: 'B' }, {}); // no files
    expect(b.ok).toBe(true);
    expect(b.value.task.flags).toBeUndefined();
    await update.execute({ id: b.value.id, status: 'in_progress' }, {});
    expect(radioOverlap()).toEqual([]);
  });
});
