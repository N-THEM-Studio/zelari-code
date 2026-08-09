/**
 * Executor → workbench wiring — tests.
 *
 * The WorkbenchWriter used to be a "prepared but unwired" feature: nothing in
 * the production flow ever constructed it, so `.zelari/radio/workbench-<id>.md`
 * never appeared and the desktop graph/tail tabs stayed empty no matter how
 * much the graph ran. These tests pin the wiring: run a tiny mock graph
 * through KrakenGraphExecutor and assert the workbench file is written with
 * the node rows and their statuses.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGraphFromPlan } from './planner.js';
import { KrakenGraphExecutor } from './executor.js';
import type { TentacleResult } from '../tools/taskTool.js';

const WORKBENCH_ENV = 'ZELARI_KRAKEN_WORKBENCH';

async function listRadioDir(cwd: string): Promise<string[]> {
  const dir = path.join(cwd, '.zelari', 'radio');
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

function okResult(description: string): TentacleResult {
  return {
    ok: true,
    agent: 'explore',
    thoroughness: 'medium',
    model: 'mock-model',
    result: `done: ${description}`,
    footer: '',
    worktreePath: null,
    worktreeHandle: null,
  };
}

describe('executor → workbench wiring', () => {
  it('writes a workbench file with nodes, deps and terminal statuses after a run', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-wb-exec-'));
    const prev = process.env[WORKBENCH_ENV];
    process.env[WORKBENCH_ENV] = '1';
    try {
      const graph = buildGraphFromPlan('kraken-exec-test', [
        { id: 'e1', kind: 'explore', label: 'map auth', prompt: 'map auth', deps: [] },
        {
          id: 'g1',
          kind: 'general',
          label: 'auth fix',
          prompt: 'fix auth',
          scope: ['src/auth'],
          deps: ['e1'],
        },
        {
          id: 'g2',
          kind: 'general',
          label: 'tests',
          prompt: 'add tests',
          scope: ['tests/auth'],
          deps: ['e1'],
        },
      ]);

      const executor = new KrakenGraphExecutor({
        taskToolDeps: {
          createSubAgentContext: async () => null,
        },
        parentCwd: cwd,
        sessionId: 'sess-exec-test',
        goal: 'fix auth',
        runTentacleFn: async (opts) => okResult(opts.args.description),
        mergeFn: async () => ({
          ok: true,
          merged: false,
          committed: false,
          conflict: false,
          message: 'no-op',
        }),
      });

      const summary = await executor.execute(graph);
      expect(summary.converged).toBe(true);

      const files = await listRadioDir(cwd);
      const wb = files.find((f) => f.startsWith('workbench-') && f.endsWith('.md'));
      expect(wb, `expected a workbench-*.md file, got: ${files.join(', ')}`).toBeTruthy();

      const body = await fs.readFile(path.join(cwd, '.zelari', 'radio', wb!), 'utf8');
      expect(body).toContain('**Goal:** fix auth');
      // Original planned nodes are in the Wave table...
      expect(body).toContain('| e1 | map auth | explore');
      expect(body).toContain('| g1 | auth fix | general |');
      // ...auto-injected verify + merge nodes too...
      expect(body).toContain('verify-');
      expect(body).toContain('| merge | merge parallel work |');
      // ...with terminal statuses and no lingering pending/running rows.
      expect(body).not.toContain('| ↑');
      expect(body).not.toContain('| ○');
      // ...and the run outcome is recorded in the event tail.
      expect(body).toContain('graph_converged');
    } finally {
      if (prev === undefined) delete process.env[WORKBENCH_ENV];
      else process.env[WORKBENCH_ENV] = prev;
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('respects ZELARI_KRAKEN_WORKBENCH=0 (no workbench file written)', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-wb-off-'));
    const prev = process.env[WORKBENCH_ENV];
    process.env[WORKBENCH_ENV] = '0';
    try {
      const graph = buildGraphFromPlan('kraken-exec-off', [
        { id: 'e1', kind: 'explore', label: 'a', prompt: 'a', deps: [] },
      ]);
      const executor = new KrakenGraphExecutor({
        taskToolDeps: { createSubAgentContext: async () => null },
        parentCwd: cwd,
        sessionId: 'sess-exec-off',
        runTentacleFn: async (opts) => okResult(opts.args.description),
      });
      await executor.execute(graph);
      const files = await listRadioDir(cwd);
      expect(files.filter((f) => f.startsWith('workbench-'))).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env[WORKBENCH_ENV];
      else process.env[WORKBENCH_ENV] = prev;
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
