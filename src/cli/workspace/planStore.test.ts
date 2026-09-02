/**
 * planStore + planTaskTools tests — ADR-0018 slice 3a acceptance.
 *
 * Covers: v1 envelope persistence, coexistence with council plan tasks
 * (normalization done→completed, name→title alias, no id collisions, root
 * pass-through), caps, corrupt-file safety, .bak backup, and the council
 * writePlan round-trip preserving the v1 root fields.
 *
 * @since v1.43.0
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanTaskTools, type PlanTaskEvent } from '../tools/planTaskTools.js';
import { createWorkspaceContext, createWorkspaceStubs } from './stubs.js';
import { normalizePlanTaskFiles, type PlanTask } from './planStore.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zelari-plan-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function planPath(): string {
  return join(dir, '.zelari', 'plan.json');
}

function readPlanJson(): Record<string, any> {
  return JSON.parse(readFileSync(planPath(), 'utf8'));
}

function seedPlanJson(content: unknown): void {
  mkdirSync(join(dir, '.zelari'), { recursive: true });
  writeFileSync(planPath(), JSON.stringify(content), 'utf8');
}

function toolCtx() {
  return {
    signal: new AbortController().signal,
    cwd: dir,
    audit: () => {},
    sessionId: 'plan-store-test',
  };
}

/**
 * Structural view of a tool with a widened execute signature — avoids the
 * input/output intersections TS builds when destructuring the heterogeneous
 * array returned by createPlanTaskTools.
 */
type AnyTool<T> = {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (
    input: any,
    ctx: any,
  ) => Promise<{ ok: true; value: T } | { ok: false; error: string }>;
};

function makeTools(onTaskEvent?: (event: PlanTaskEvent) => void) {
  const tools = createPlanTaskTools({ projectRoot: dir, onTaskEvent });
  return {
    create: tools[0] as unknown as AnyTool<{ id: string; task: PlanTask }>,
    update: tools[1] as unknown as AnyTool<{ task: PlanTask }>,
    list: tools[2] as unknown as AnyTool<{
      tasks: PlanTask[];
      total: number;
      done: number;
      formatted: string;
    }>,
  };
}

describe('planStore / task_* tools (ADR-0018 3a)', () => {
  it('task_create persists the v1 envelope and the per-task artifact', async () => {
    const { create } = makeTools();
    const res = await create.execute({ title: 'Extract RunCoordinator' }, toolCtx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.id).toBe('t1');
    expect(res.value.task.status).toBe('pending');

    const file = readPlanJson();
    expect(file.schemaVersion).toBe(1);
    expect(file.counter).toBe(1);
    expect(file.tasks[0].id).toBe('t1');
    expect(file.tasks[0].title).toBe('Extract RunCoordinator');
    expect(file.tasks[0].name).toBe('Extract RunCoordinator'); // council alias
    expect(existsSync(join(dir, '.zelari', 'plan-tasks', 't1.md'))).toBe(true);
  });

  it('coexists with council tasks: normalization, no id collision, root pass-through', async () => {
    seedPlanJson({
      phases: [{ kind: 'phase', id: 'p1', name: 'P1', order: 1 }],
      tasks: [
        {
          kind: 'task',
          id: 'p1-foo-1',
          name: 'Council task',
          phaseId: 'p1',
          status: 'done',
          priority: 'high',
          description: 'council extra field',
        },
      ],
      milestones: [],
      xCouncilMeta: 'keep-me',
    });
    const { create, list } = makeTools();

    const l1 = await list.execute({}, toolCtx());
    expect(l1.ok).toBe(true);
    if (!l1.ok) return;
    expect(l1.value.tasks).toHaveLength(1);
    expect(l1.value.tasks[0].title).toBe('Council task'); // name → title
    expect(l1.value.tasks[0].status).toBe('completed'); // done → completed
    expect(l1.value.done).toBe(1);
    expect(l1.value.total).toBe(1);

    const res = await create.execute({ title: 'Agent task', phaseId: 'p1' }, toolCtx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.id).toBe('t1'); // counter starts fresh, no collision with p1-foo-1

    const file = readPlanJson();
    expect(file.xCouncilMeta).toBe('keep-me'); // unknown root field preserved
    expect(file.phases).toHaveLength(1);
    const council = file.tasks.find((t: any) => t.id === 'p1-foo-1');
    expect(council.name).toBe('Council task');
    expect(council.description).toBe('council extra field'); // task pass-through
    expect(council.status).toBe('completed'); // normalized on rewrite
  });

  it('task_update applies fields, appendNote, and errors PLAN_TASK_NOT_FOUND', async () => {
    const { create, update } = makeTools();
    const created = await create.execute({ title: 'Fix auth refresh' }, toolCtx());
    expect(created.ok).toBe(true);

    const up = await update.execute(
      { id: 't1', status: 'in_progress', priority: 'high' },
      toolCtx(),
    );
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(up.value.task.status).toBe('in_progress');
    expect(up.value.task.priority).toBe('high');

    const up2 = await update.execute(
      { id: 't1', appendNote: 'wip on refresh token' },
      toolCtx(),
    );
    expect(up2.ok).toBe(true);
    const up3 = await update.execute({ id: 't1', appendNote: 'second note' }, toolCtx());
    expect(up3.ok).toBe(true);
    if (!up3.ok) return;
    expect(String(up3.value.task.notes)).toContain('wip on refresh token');
    expect(String(up3.value.task.notes)).toContain('second note');

    const nf = await update.execute({ id: 't9', status: 'pending' }, toolCtx());
    expect(nf.ok).toBe(false);
    if (nf.ok) return;
    expect(nf.error).toContain('PLAN_TASK_NOT_FOUND');
  });

  it('task_list filters by status and phaseId', async () => {
    const { create, update, list } = makeTools();
    await create.execute({ title: 'A', phaseId: 'p1' }, toolCtx());
    await create.execute({ title: 'B', phaseId: 'p2' }, toolCtx());
    await update.execute({ id: 't1', status: 'completed' }, toolCtx());

    const byStatus = await list.execute({ status: 'completed' }, toolCtx());
    expect(byStatus.ok && byStatus.value.tasks.map((t) => t.id)).toEqual(['t1']);

    const byPhase = await list.execute({ phaseId: 'p2' }, toolCtx());
    expect(byPhase.ok && byPhase.value.tasks.map((t) => t.id)).toEqual(['t2']);

    const all = await list.execute({}, toolCtx());
    expect(all.ok && all.value.total).toBe(2);
    expect(all.ok && all.value.done).toBe(1);
  });

  it('defensive caps: oversized title is truncated, 101st task rejected', async () => {
    const { create } = makeTools();
    // Bypassing zod (registry validates; execute is called directly here) —
    // the store must still enforce the cap defensively.
    const res = await create.execute({ title: 'x'.repeat(250) }, toolCtx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.task.title.length).toBe(200);

    const tasks = Array.from({ length: 100 }, (_, i) => ({
      kind: 'task',
      id: `t${i + 1}`,
      name: `bulk ${i + 1}`,
      phaseId: 'p0',
      status: 'pending',
    }));
    seedPlanJson({
      schemaVersion: 1,
      counter: 100,
      tasks,
      phases: [],
      milestones: [],
    });
    const over = await create.execute({ title: 'one too many' }, toolCtx());
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.error).toContain('PLAN_TOO_MANY_TASKS');
  });

  it('corrupt plan.json → PLAN_CORRUPT error and the file is left untouched', async () => {
    mkdirSync(join(dir, '.zelari'), { recursive: true });
    writeFileSync(planPath(), '{ broken json', 'utf8');
    const { create, list } = makeTools();

    const res = await create.execute({ title: 'X' }, toolCtx());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('PLAN_CORRUPT');

    const ls = await list.execute({}, toolCtx());
    expect(ls.ok).toBe(false);
    expect(readFileSync(planPath(), 'utf8')).toBe('{ broken json'); // not overwritten
  });

  it('a second write keeps a .bak of the previous state', async () => {
    const { create } = makeTools();
    await create.execute({ title: 'first' }, toolCtx());
    await create.execute({ title: 'second' }, toolCtx());
    const bak = JSON.parse(readFileSync(`${planPath()}.bak`, 'utf8'));
    expect(bak.tasks[0].title).toBe('first');
    const cur = readPlanJson();
    expect(cur.tasks).toHaveLength(2);
    expect(cur.counter).toBe(2);
  });

  it('council writePlan round-trip preserves schemaVersion/counter (stub interop)', async () => {
    seedPlanJson({
      schemaVersion: 1,
      counter: 3,
      phases: [{ kind: 'phase', id: 'p1', name: 'P1', order: 1 }],
      tasks: [
        {
          kind: 'task',
          id: 't1',
          name: 'Agent task',
          title: 'Agent task',
          phaseId: 'p1',
          status: 'pending',
        },
      ],
      milestones: [],
    });
    const wsCtx = createWorkspaceContext(dir);
    const updateTask = createWorkspaceStubs(wsCtx).find((s) => s.name === 'updateTask')!;
    expect(updateTask).toBeTruthy();

    const out = await updateTask.execute(
      { taskId: 't1', status: 'done' },
      wsCtx as never,
    );
    expect(String(out)).toContain('t1');

    const file = readPlanJson();
    expect(file.schemaVersion).toBe(1); // ADR-0018 pass-through root fields
    expect(file.counter).toBe(3);
    expect(file.tasks[0].status).toBe('done'); // council writer vocabulary
    expect(file.phases).toHaveLength(1);
  });
});

describe('task_* first-class events (ADR-0018 3b)', () => {
  it('task_create emits task_update with the created payload', async () => {
    const events: PlanTaskEvent[] = [];
    const { create } = makeTools((e) => events.push(e));

    const res = await create.execute(
      { title: 'Event slice', priority: 'high', phaseId: 'p9' },
      toolCtx(),
    );
    expect(res.ok).toBe(true);
    expect(events).toEqual([
      {
        type: 'task_update',
        source: 'workspace_plan',
        task: {
          id: 't1',
          title: 'Event slice',
          status: 'pending',
          phaseId: 'p9',
          priority: 'high',
        },
      },
    ]);
  });

  it('task_update emits task_update with the mutated status', async () => {
    const events: PlanTaskEvent[] = [];
    const { create, update } = makeTools((e) => events.push(e));

    await create.execute({ title: 'A' }, toolCtx());
    const res = await update.execute(
      { id: 't1', status: 'in_progress' },
      toolCtx(),
    );
    expect(res.ok).toBe(true);
    const last = events[events.length - 1];
    expect(last.type).toBe('task_update');
    if (last.type !== 'task_update') return;
    expect(last.task.id).toBe('t1');
    expect(last.task.status).toBe('in_progress');
  });

  it('task_list emits a FULL snapshot regardless of filters', async () => {
    const events: PlanTaskEvent[] = [];
    const { create, update, list } = makeTools((e) => events.push(e));

    await create.execute({ title: 'One' }, toolCtx());
    await create.execute({ title: 'Two' }, toolCtx());
    await update.execute({ id: 't1', status: 'completed' }, toolCtx());

    const res = await list.execute({ status: 'pending' }, toolCtx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.tasks).toHaveLength(1); // filtered view for the agent

    const snap = events.find((e) => e.type === 'task_snapshot');
    expect(snap).toBeDefined();
    if (!snap || snap.type !== 'task_snapshot') return;
    expect(snap.tasks).toHaveLength(2); // full view for frontends
    expect(snap.tasks.map((t) => `${t.id}:${t.status}`).sort()).toEqual([
      't1:completed',
      't2:pending',
    ]);
  });

  it('no events on tool errors; a throwing sink never breaks the tool', async () => {
    const events: PlanTaskEvent[] = [];
    const ok = makeTools((e) => events.push(e));
    const bad = makeTools(() => {
      throw new Error('sink exploded');
    });

    const missing = await ok.update.execute({ id: 'nope', status: 'pending' }, toolCtx());
    expect(missing.ok).toBe(false);
    expect(events).toHaveLength(0);

    const res = await bad.create.execute({ title: 'Still works' }, toolCtx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.id).toBe('t1');
  });
});

describe('t56 declared-vs-observed: files / completedAt / flags', () => {
  it('normalizePlanTaskFiles trims, drops empties, dedupes and caps', () => {
    expect(normalizePlanTaskFiles(undefined)).toBeUndefined();
    expect(normalizePlanTaskFiles([' src/a.ts ', '', 'src/a.ts'])).toEqual(['src/a.ts']);
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    expect(normalizePlanTaskFiles(many)).toHaveLength(32);
  });

  it('task_create persists files (and the fileRefs alias) through the store round-trip', async () => {
    const { create } = makeTools(() => {});
    const a = await create.execute(
      { title: 'With files', files: ['src/a.ts', ' src/a.ts ', ''] },
      toolCtx(),
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value.task.files).toEqual(['src/a.ts']);

    const b = await create.execute(
      { title: 'With fileRefs', fileRefs: ['docs/x.md'] },
      toolCtx(),
    );
    expect(b.ok).toBe(true);

    const raw = readPlanJson();
    expect(raw.tasks[0].files).toEqual(['src/a.ts']);
    expect(raw.tasks[1].files).toEqual(['docs/x.md']);
  });

  it('completedAt is set on first completion and never rewritten (reopen-safe)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const { create, update } = makeTools(() => {});
      await create.execute({ title: 'T', files: ['src/t.ts'] }, toolCtx());

      const first = await update.execute({ id: 't1', status: 'completed' }, toolCtx());
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const stamp = first.value.task.completedAt;
      expect(stamp).toBe('2026-01-01T00:00:00.000Z');

      vi.setSystemTime(new Date('2026-03-03T00:00:00.000Z'));
      const reopened = await update.execute(
        { id: 't1', status: 'in_progress' },
        toolCtx(),
      );
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) return;
      expect(reopened.value.task.completedAt).toBe(stamp); // survives the reopen

      const again = await update.execute({ id: 't1', status: 'completed' }, toolCtx());
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value.task.completedAt).toBe(stamp); // first completion wins
      expect(readPlanJson().tasks[0].completedAt).toBe(stamp);
    } finally {
      vi.useRealTimers();
    }
  });

  it('task_update replaces files when provided and leaves them untouched otherwise', async () => {
    const { create, update } = makeTools(() => {});
    await create.execute({ title: 'T', files: ['src/old.ts'] }, toolCtx());

    const res = await update.execute({ id: 't1', fileRefs: ['src/new.ts'] }, toolCtx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.task.files).toEqual(['src/new.ts']);

    const untouched = await update.execute({ id: 't1', notes: 'x' }, toolCtx());
    expect(untouched.ok).toBe(true);
    if (!untouched.ok) return;
    expect(untouched.value.task.files).toEqual(['src/new.ts']);
  });

  it('council createTask fileRefs land on the plan.json record as files', async () => {
    seedPlanJson({
      schemaVersion: 1,
      counter: 0,
      phases: [{ id: 'p1', name: 'P1', description: '', order: 0, color: '#000' }],
      milestones: [],
      tasks: [],
    });
    const wsCtx = createWorkspaceContext(dir);
    const createTask = createWorkspaceStubs(wsCtx).find(
      (s) => s.name === 'createTask',
    )!;
    expect(createTask).toBeTruthy();
    await createTask.execute(
      { phaseId: 'p1', title: 'Council task', fileRefs: ['src/cli/x.ts', 'docs/y.md'] },
      wsCtx as never,
    );
    const raw = readPlanJson();
    const council = raw.tasks.find((t: { name?: string }) => t.name === 'Council task');
    expect(council?.files).toEqual(['src/cli/x.ts', 'docs/y.md']);
  });

  it('flags pass through the store round-trip untouched', async () => {
    const { create, list } = makeTools(() => {});
    await create.execute({ title: 'Flagged' }, toolCtx());
    // flags are machine-set (t58–t60), not model input — simulate via the file
    const raw = readPlanJson();
    raw.tasks[0].flags = ['reopened'];
    seedPlanJson(raw);

    const out = await list.execute({}, toolCtx());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.tasks[0].flags).toEqual(['reopened']);
  });
});
