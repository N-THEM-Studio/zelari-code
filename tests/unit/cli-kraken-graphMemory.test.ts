/**
 * Kraken graph cross-run memory.
 *
 * Regression: after a graph stopped with 3 failed / 4 never-run nodes, a
 * follow-up "continua" was planned from scratch — the planner is a one-shot
 * completion and had no idea what already existed. The model's best move was
 * to re-explore, producing a single read-only node that converged having
 * changed nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph, type TaskNode, type TaskNodeKind, type TaskNodeStatus } from '@zelari/core';
import {
  toGraphSnapshot,
  saveGraphSnapshot,
  loadGraphSnapshot,
  formatSnapshotForPlanner,
  type GraphSnapshot,
} from '../../src/cli/kraken/graphMemory.js';

function node(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    kind: (over.kind as TaskNodeKind) ?? 'general',
    label: over.label ?? id,
    prompt: over.prompt ?? `do ${id}`,
    deps: over.deps ?? [],
    status: (over.status as TaskNodeStatus) ?? 'pending',
    retryCount: 0,
    maxRetries: 0,
    ...over,
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-mem-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('graph snapshot round-trip', () => {
  it('persists and reloads the terminal state of every node', async () => {
    const graph = createGraph('g-1', [
      node('a', { status: 'done', label: 'ocean' }),
      node('b', { status: 'error', label: 'ships', error: 'timed out', scope: ['src/ships/'] }),
      node('c', { status: 'skipped', label: 'wiring' }),
    ]);

    await saveGraphSnapshot(tmp, toGraphSnapshot(graph, { goal: 'build it', converged: false }));
    const loaded = await loadGraphSnapshot(tmp);

    expect(loaded?.goal).toBe('build it');
    expect(loaded?.converged).toBe(false);
    expect(loaded?.nodes).toHaveLength(3);
    expect(loaded?.nodes.find((n) => n.id === 'b')).toMatchObject({
      status: 'error',
      error: 'timed out',
      scope: ['src/ships/'],
    });
  });

  it('writes under .zelari/kraken/', async () => {
    const graph = createGraph('g-2', [node('a', { status: 'done' })]);
    await saveGraphSnapshot(tmp, toGraphSnapshot(graph, { goal: 'x', converged: true }));

    await expect(fs.access(path.join(tmp, '.zelari', 'kraken', 'last-graph.json'))).resolves.toBeUndefined();
  });

  it('returns null when there is no snapshot, without throwing', async () => {
    expect(await loadGraphSnapshot(tmp)).toBeNull();
  });

  it('never throws when the target directory does not exist', async () => {
    const graph = createGraph('g-3', [node('a')]);
    await expect(
      saveGraphSnapshot(path.join(tmp, 'nope', 'nope'), toGraphSnapshot(graph, { goal: 'x', converged: true })),
    ).resolves.toBeUndefined();
  });
});

describe('formatSnapshotForPlanner', () => {
  const snapshot = (nodes: GraphSnapshot['nodes']): GraphSnapshot => ({
    graphId: 'g',
    goal: 'build it',
    finishedAt: new Date().toISOString(),
    converged: false,
    nodes,
  });

  it('is empty when there is nothing to resume', () => {
    expect(formatSnapshotForPlanner(null)).toBe('');
    expect(
      formatSnapshotForPlanner(
        snapshot([{ id: 'a', kind: 'general', label: 'a', status: 'done' }]),
      ),
    ).toBe('');
  });

  // The snapshot is per-project, not per-goal: the last unfinished graph may
  // belong to unrelated work, so the briefing must name the goal it came from
  // instead of asserting it belongs to whatever is being planned now.
  it('names the goal the previous attempt was working on', () => {
    const out = formatSnapshotForPlanner({
      graphId: 'g',
      goal: 'build the ocean shader',
      finishedAt: new Date().toISOString(),
      converged: false,
      nodes: [{ id: 'a', kind: 'general', label: 'ocean', status: 'error' }],
    });

    expect(out).toMatch(/Goal it was working on: "build the ocean shader"/);
    expect(out).toMatch(/unrelated to the one above, ignore this section/);
  });

  it('separates completed, failed and never-run work', () => {
    const out = formatSnapshotForPlanner(
      snapshot([
        { id: 'a', kind: 'general', label: 'ocean', status: 'done' },
        {
          id: 'b',
          kind: 'general',
          label: 'ships',
          status: 'error',
          error: 'timed out',
          scope: ['src/ships/'],
        },
        { id: 'c', kind: 'general', label: 'wiring', status: 'skipped' },
      ]),
    );

    expect(out).toMatch(/1 done, 1 failed, 1 never ran/);
    expect(out).toMatch(/do NOT redo this work:\n- ocean/);
    expect(out).toMatch(/- ships \[src\/ships\/\] — timed out/);
    expect(out).toMatch(/Never ran[\s\S]*- wiring/);
  });

  it('briefs the planner on a converged run whose work was rejected', () => {
    // Every node reached `done`, so the old early-return said nothing at all —
    // and the next run treated rejected work as finished business.
    const out = formatSnapshotForPlanner({
      ...snapshot([{ id: 'g1', kind: 'general', label: 'ocean', status: 'done' }]),
      converged: true,
      unresolvedFindings: [
        {
          nodeId: 'g1',
          label: 'ocean',
          reason: 'fail',
          findings: 'waves never animate\nmore detail',
        },
      ],
    });

    expect(out).toMatch(/1 rejected by review/);
    expect(out).toMatch(/REJECTED by review[\s\S]*- ocean — waves never animate/);
    // A rejected node must NOT also appear under "do NOT redo this work".
    expect(out).not.toMatch(/do NOT redo this work:\n- ocean/);
  });

  it('still says nothing when a converged run had no findings', () => {
    expect(
      formatSnapshotForPlanner({
        ...snapshot([{ id: 'a', kind: 'general', label: 'a', status: 'done' }]),
        converged: true,
      }),
    ).toBe('');
  });
});
