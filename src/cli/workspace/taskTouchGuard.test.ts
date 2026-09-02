/**
 * t58 acceptance — TaskTouchGuard matcher + cross-session mini-integration.
 * Match vocabulary, exclusions, throttle (1 radio event / task / session),
 * plan.json flag+note persistence, same-session suppression.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readKrakenRadio } from '../tools/krakenRadio.js';
import { withPlanStore } from './planStore.js';
import type { PlanTask } from './planStore.js';
import {
  createTaskTouchGuard,
  extractWriteTarget,
  isMutatingToolName,
  matchTaskFiles,
  toPosixRel,
} from './taskTouchGuard.js';

const roots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ttg-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      // best-effort cleanup; mkdtemp dirs are OS-swept anyway
      void r;
    } catch {
      /* ignore */
    }
  }
});

function seedTask(root: string, task: Partial<PlanTask> & { id: string }): void {
  void withPlanStore(root, (store) => {
    store.tasks.push({ title: `task ${task.id}`, status: 'completed', ...task } as PlanTask);
  });
}

const NOW = Date.parse('2026-08-31T12:00:00Z');
const EARLIER = Date.parse('2026-08-30T12:00:00Z');

describe('matchTaskFiles (vocabulary + exclusions)', () => {
  it('matches exact path, dir/** subtree and *.ext suffix at any depth', () => {
    expect(matchTaskFiles(['src/cli/foo.ts'], 'src/cli/foo.ts')).toBe(true);
    expect(matchTaskFiles(['src/cli/foo.ts'], 'src/cli/other.ts')).toBe(false);
    expect(matchTaskFiles(['src/**'], 'src/deep/nested/x.ts')).toBe(true);
    expect(matchTaskFiles(['src/**'], 'tests/x.ts')).toBe(false);
    expect(matchTaskFiles(['*.md'], 'docs/README.md')).toBe(true);
    expect(matchTaskFiles(['**/*.py'], 'tools/eval/run.py')).toBe(true);
    expect(matchTaskFiles(['*.md'], 'src/cli/foo.ts')).toBe(false);
  });

  it('never matches excluded dirs (.zelari, node_modules, dist, build)', () => {
    expect(matchTaskFiles(['**/*'], '.zelari/plan.json')).toBe(false);
    expect(matchTaskFiles(['node_modules/**'], 'node_modules/pkg/index.js')).toBe(false);
    expect(matchTaskFiles(['**/*.js'], 'dist/bundle.js')).toBe(false);
    expect(matchTaskFiles(['**/*.js'], 'build/out.js')).toBe(false);
  });

  it('treats windows-style patterns and leading ./ as equivalent', () => {
    expect(matchTaskFiles(['src\\cli\\foo.ts'], 'src/cli/foo.ts')).toBe(true);
    expect(matchTaskFiles(['./src/**'], 'src/a.ts')).toBe(true);
  });
});

describe('tool classification + path extraction', () => {
  it('classifies native and mcp_filesystem mutating tools only', () => {
    expect(isMutatingToolName('write_file')).toBe(true);
    expect(isMutatingToolName('edit')).toBe(true);
    expect(isMutatingToolName('mcp_filesystem_edit_file')).toBe(true);
    expect(isMutatingToolName('mcp_filesystem_move_file')).toBe(true);
    expect(isMutatingToolName('read_file')).toBe(false);
    expect(isMutatingToolName('bash')).toBe(false);
    expect(isMutatingToolName('mcp_filesystem_read_file')).toBe(false);
  });

  it('extracts path / file_path / source+destination and rejects non-mutating tools', () => {
    expect(extractWriteTarget('write_file', { path: 'src/a.ts', content: 'x' })).toBe('src/a.ts');
    expect(extractWriteTarget('mcp_filesystem_edit_file', { file_path: 'src/a.ts' })).toBe(
      'src/a.ts',
    );
    expect(extractWriteTarget('mcp_filesystem_move_file', { source: 'a.ts', destination: 'b.ts' }),
    ).toBe('a.ts');
    expect(extractWriteTarget('read_file', { path: 'src/a.ts' })).toBeNull();
  });

  it('normalizes absolute paths inside root and rejects paths outside root', () => {
    const root = tmpRoot();
    expect(toPosixRel(root, join(root, 'src/a.ts'.replace(/\//g, '\\')))).toBe('src/a.ts');
    expect(toPosixRel(root, join(root, '..', 'outside.ts'))).toBeNull();
    expect(toPosixRel(root, 'src/plain/rel.ts')).toBe('src/plain/rel.ts');
  });
});

describe('createTaskTouchGuard (cross-session integration)', () => {
  it('flags a later-session write: 1 radio event + flag/note on plan.json, throttled', async () => {
    const root = tmpRoot();
    seedTask(root, { id: 't1', files: ['src/a.ts'], completedAt: new Date(EARLIER).toISOString() });
    const guard = createTaskTouchGuard({ projectRoot: root, sessionId: 'sess-a', now: () => NOW });
    await guard.drain(); // seedTask settled

    guard({ toolName: 'write_file', toolInput: { path: 'src/a.ts' }, ok: true });
    guard({ toolName: 'write_file', toolInput: { path: join(root, 'src', 'a.ts') }, ok: true });
    await guard.drain();

    const events = readKrakenRadio(root, 'sess-a', 10);
    const reopened = events.filter((e) => e.kind === 'task_reopened');
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.agent).toBe('task-guard');
    expect(reopened[0]!.contestedFile).toBe('src/a.ts');

    const stored = await withPlanStore(root, (s) => s.tasks.find((t) => t.id === 't1'));
    expect(stored?.flags).toContain('reopened');
    expect(stored?.notes).toContain('modified after completion');
  });

  it('does not flag the session that completed the task (same-session rule)', async () => {
    const root = tmpRoot();
    seedTask(root, { id: 't2', files: ['src/b.ts'], completedAt: new Date(NOW).toISOString() });
    const guard = createTaskTouchGuard({
      projectRoot: root,
      sessionId: 'sess-b',
      now: () => EARLIER, // session started BEFORE completion
    });
    await guard.drain();
    guard({ toolName: 'edit', toolInput: { path: 'src/b.ts' }, ok: true });
    await guard.drain();
    expect(readKrakenRadio(root, 'sess-b', 10)).toHaveLength(0);
    const stored = await withPlanStore(root, (s) => s.tasks.find((t) => t.id === 't2'));
    expect(stored?.flags ?? []).not.toContain('reopened');
  });

  it('ignores failed writes, tasks without declared files, and excluded paths', async () => {
    const root = tmpRoot();
    seedTask(root, { id: 't3', files: undefined, completedAt: new Date(EARLIER).toISOString() });
    seedTask(root, { id: 't4', files: ['src/c.ts'], completedAt: new Date(EARLIER).toISOString() });
    const guard = createTaskTouchGuard({ projectRoot: root, sessionId: 'sess-c', now: () => NOW });
    await guard.drain();
    guard({ toolName: 'write_file', toolInput: { path: 'src/c.ts' }, ok: false }); // failed write
    guard({ toolName: 'write_file', toolInput: { path: '.zelari/plan.json' }, ok: true }); // excluded
    guard({ toolName: 'read_file', toolInput: { path: 'src/c.ts' }, ok: true }); // not mutating
    guard({ toolName: 'write_file', toolInput: { path: 'src/untouched.ts' }, ok: true }); // no glob hit
    await guard.drain();
    expect(readKrakenRadio(root, 'sess-c', 10)).toHaveLength(0);
    const t4 = await withPlanStore(root, (s) => s.tasks.find((t) => t.id === 't4'));
    expect(t4?.flags ?? []).not.toContain('reopened');
  });

  it('is total fail-open: a throwing deps path never rejects drain', async () => {
    const root = tmpRoot();
    const guard = createTaskTouchGuard({ projectRoot: root, sessionId: 'sess-d', now: () => NOW });
    guard({ toolName: 'write_file', toolInput: { path: 'x.ts' }, ok: true }); // no plan.json at all
    await expect(guard.drain()).resolves.toBeUndefined();
  });
});
