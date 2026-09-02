/**
 * t59 acceptance — session-start staleness sweep against a REAL git repo
 * (style: tests/unit/cli-gitOps.test.ts). Commit after completedAt →
 * 'stale' flag + radio; untouched files / young tasks / non-repos → skip;
 * re-runs are idempotent.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { gitLogSince } from '../gitOps.js';
import { readKrakenRadio } from '../tools/krakenRadio.js';
import { withPlanStore } from './planStore.js';
import type { PlanTask } from './planStore.js';
import { runTaskStalenessCheck, taskStaleHours } from './taskStaleness.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout;
}

const roots: string[] = [];
async function gitRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'tstale-'));
  roots.push(dir);
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test User']);
  await fs.writeFile(join(dir, 'README.md'), '# t\n', 'utf-8');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

afterEach(async () => {
  for (const r of roots.splice(0)) {
    await fs.rm(r, { recursive: true, force: true }).catch(() => undefined);
  }
});

function seedTask(root: string, task: Partial<PlanTask> & { id: string }): void {
  void withPlanStore(root, (store) => {
    store.tasks.push({ title: `task ${task.id}`, status: 'completed', ...task } as PlanTask);
  });
}

async function commitFile(root: string, rel: string, msg: string): Promise<void> {
  const abs = join(root, rel);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, `// ${msg}\n`, 'utf-8');
  await git(root, ['add', rel]);
  await git(root, ['commit', '-q', '-m', msg]);
}

const H = 3_600_000;

describe('gitLogSince (never-throw wrapper)', () => {
  it('returns commit lines for later commits touching the pathspecs, newest first', async () => {
    const root = await gitRoot();
    await commitFile(root, 'src/a.ts', 'touch a');
    const since = new Date(Date.now() - 2 * H).toISOString();
    const lines = await gitLogSince(root, since, ['src/a.ts']);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain('touch a');
    const other = await gitLogSince(root, since, ['src/never.ts']);
    expect(other).toEqual([]);
  });

  it('returns [] outside a git repo (never throws)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nostale-'));
    roots.push(dir);
    expect(await gitLogSince(dir, new Date(0).toISOString(), ['a.ts'])).toEqual([]);
  });

  it('returns [] for empty pathspec lists', async () => {
    const root = await gitRoot();
    expect(await gitLogSince(root, new Date(0).toISOString(), [])).toEqual([]);
    expect(await gitLogSince(root, new Date(0).toISOString(), ['  '])).toEqual([]);
  });
});

describe('runTaskStalenessCheck (real repo integration)', () => {
  it('flags stale: later commit on declared files → radio task_stale + flag/note', async () => {
    const root = await gitRoot();
    seedTask(root, {
      id: 't1',
      files: ['src/a.ts'],
      completedAt: new Date(Date.now() - 48 * H).toISOString(),
    });
    await new Promise((r) => setTimeout(r, 25));
    await commitFile(root, 'src/a.ts', 'post-completion change');

    const reports = await runTaskStalenessCheck({ projectRoot: root, sessionId: 'sess-1' });
    expect(reports.map((r) => r.taskId)).toEqual(['t1']);
    expect(reports[0]!.commits[0]).toContain('post-completion change');

    const events = readKrakenRadio(root, 'sess-1', 10);
    const stale = events.filter((e) => e.kind === 'task_stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.agent).toBe('task-guard');
    expect(stale[0]!.contestedFile).toBe('src/a.ts');

    const stored = await withPlanStore(root, (s) => s.tasks.find((t) => t.id === 't1'));
    expect(stored?.flags).toContain('stale');
    expect(stored?.notes).toContain('stale:');
  });

  it('no flag when no commit touched declared files after completion', async () => {
    const root = await gitRoot();
    seedTask(root, {
      id: 't2',
      files: ['src/declared.ts'],
      completedAt: new Date(Date.now() - 48 * H).toISOString(),
    });
    await commitFile(root, 'docs/other.md', 'unrelated commit');

    const reports = await runTaskStalenessCheck({ projectRoot: root, sessionId: 'sess-2' });
    expect(reports).toEqual([]);
    const stored = await withPlanStore(root, (s) => s.tasks.find((t) => t.id === 't2'));
    expect(stored?.flags ?? []).not.toContain('stale');
    expect(readKrakenRadio(root, 'sess-2', 10).filter((e) => e.kind === 'task_stale')).toEqual([]);
  });

  it('skips tasks younger than the 24h threshold even with later commits', async () => {
    const root = await gitRoot();
    seedTask(root, {
      id: 't3',
      files: ['src/fresh.ts'],
      completedAt: new Date(Date.now() - H).toISOString(),
    });
    await commitFile(root, 'src/fresh.ts', 'fresh change');
    const reports = await runTaskStalenessCheck({ projectRoot: root, sessionId: 'sess-3' });
    expect(reports).toEqual([]);
  });

  it('honors hoursOverride=0 (fresh task checked) and ZELARI_TASK_STALE_HOURS parsing', async () => {
    expect(taskStaleHours()).toBe(24);
    const prev = process.env.ZELARI_TASK_STALE_HOURS;
    try {
      process.env.ZELARI_TASK_STALE_HOURS = '0';
      expect(taskStaleHours()).toBe(0);
      process.env.ZELARI_TASK_STALE_HOURS = 'nope';
      expect(taskStaleHours()).toBe(24);

      const root = await gitRoot();
      seedTask(root, {
        id: 't4',
        files: ['src/zero.ts'],
        completedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await commitFile(root, 'src/zero.ts', 'recent change');
      // hoursOverride bypasses the (currently invalid) env value — that is
      // exactly the seam under test here.
      const reports = await runTaskStalenessCheck({
        projectRoot: root,
        sessionId: 'sess-4',
        hoursOverride: 0,
      });
      expect(reports.map((r) => r.taskId)).toEqual(['t4']);
    } finally {
      if (prev === undefined) delete process.env.ZELARI_TASK_STALE_HOURS;
      else process.env.ZELARI_TASK_STALE_HOURS = prev;
    }
  });

  it('is idempotent: a second sweep emits no duplicate radio event', async () => {
    const root = await gitRoot();
    seedTask(root, {
      id: 't5',
      files: ['src/once.ts'],
      completedAt: new Date(Date.now() - 48 * H).toISOString(),
    });
    await commitFile(root, 'src/once.ts', 'only change');
    await runTaskStalenessCheck({ projectRoot: root, sessionId: 'sess-5' });
    await runTaskStalenessCheck({ projectRoot: root, sessionId: 'sess-5' });
    const stale = readKrakenRadio(root, 'sess-5', 10).filter((e) => e.kind === 'task_stale');
    expect(stale).toHaveLength(1);
  });

  it('skips silently outside a git repo (no throw, no flags)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nostale-plan-'));
    roots.push(dir);
    seedTask(dir, {
      id: 't6',
      files: ['src/a.ts'],
      completedAt: new Date(Date.now() - 48 * H).toISOString(),
    });
    const reports = await runTaskStalenessCheck({ projectRoot: dir, sessionId: 'sess-6' });
    expect(reports).toEqual([]);
  });

  it('no-op without a plan.json (total fail-open)', async () => {
    const root = await gitRoot();
    const reports = await runTaskStalenessCheck({ projectRoot: root, sessionId: 'sess-7' });
    expect(reports).toEqual([]);
  });
});
