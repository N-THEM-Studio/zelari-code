import { describe, it, expect } from 'vitest';
import {
  createGraph,
  validateGraph,
  getReadyNodes,
  topoLevels,
  isSettled,
  isConverged,
  failedNodeIds,
  countByStatus,
  DEFAULT_MAX_NODES,
  type TaskNode,
  type TaskNodeKind,
  type TaskNodeStatus,
} from './graph.js';

/** Compact node factory for tests. */
function node(
  id: string,
  deps: string[] = [],
  over: Partial<TaskNode> = {},
): TaskNode {
  return {
    id,
    kind: (over.kind as TaskNodeKind) ?? 'general',
    label: over.label ?? id,
    prompt: over.prompt ?? `do ${id}`,
    deps,
    status: (over.status as TaskNodeStatus) ?? 'pending',
    retryCount: over.retryCount ?? 0,
    maxRetries: over.maxRetries ?? 2,
    ...over,
  };
}

describe('createGraph', () => {
  it('indexes nodes by id', () => {
    const g = createGraph('g', [node('a'), node('b', ['a'])]);
    expect(g.nodes.size).toBe(2);
    expect(g.nodes.get('b')?.deps).toEqual(['a']);
  });
});

describe('validateGraph', () => {
  it('accepts a valid DAG', () => {
    const g = createGraph('g', [node('a'), node('b', ['a']), node('c', ['a', 'b'])]);
    expect(validateGraph(g)).toEqual({ ok: true });
  });

  it('rejects an empty graph', () => {
    const res = validateGraph(createGraph('g', []));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/empty/);
  });

  it('rejects unknown deps', () => {
    const g = createGraph('g', [node('a', ['ghost'])]);
    const res = validateGraph(g);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/unknown node "ghost"/);
  });

  it('rejects self-dependency', () => {
    const g = createGraph('g', [node('a', ['a'])]);
    const res = validateGraph(g);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/depends on itself/);
  });

  it('detects a 2-node cycle', () => {
    const g = createGraph('g', [node('a', ['b']), node('b', ['a'])]);
    const res = validateGraph(g);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/cycle/);
  });

  it('detects a 3-node cycle', () => {
    const g = createGraph('g', [
      node('a', ['c']),
      node('b', ['a']),
      node('c', ['b']),
    ]);
    const res = validateGraph(g);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/cycle/);
  });

  it('enforces maxNodes bound', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node(`n${i}`));
    const g = createGraph('g', nodes);
    const res = validateGraph(g, { maxNodes: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/exceeding maxNodes=3/);
  });

  it('uses DEFAULT_MAX_NODES=24 by default', () => {
    expect(DEFAULT_MAX_NODES).toBe(24);
    const nodes = Array.from({ length: 25 }, (_, i) => node(`n${i}`));
    const res = validateGraph(createGraph('g', nodes));
    expect(res.ok).toBe(false);
  });
});

describe('getReadyNodes', () => {
  it('returns only nodes whose deps are all done (diamond DAG)', () => {
    // a -> b, a -> c, b+c -> d
    const g = createGraph('g', [
      node('a', [], { status: 'done' }),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
    ]);
    expect(getReadyNodes(g).map((n) => n.id).sort()).toEqual(['b', 'c']);
  });

  it('does not unblock a node when a dep is errored', () => {
    const g = createGraph('g', [
      node('a', [], { status: 'error' }),
      node('b', ['a']),
    ]);
    expect(getReadyNodes(g)).toEqual([]);
  });

  it('unblocks a chain as deps complete', () => {
    const g = createGraph('g', [
      node('a', [], { status: 'done' }),
      node('b', ['a'], { status: 'done' }),
      node('c', ['b']),
    ]);
    expect(getReadyNodes(g).map((n) => n.id)).toEqual(['c']);
  });
});

describe('topoLevels', () => {
  it('groups a diamond into levels', () => {
    const g = createGraph('g', [
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
    ]);
    expect(topoLevels(g)).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('puts independent nodes in level 0', () => {
    const g = createGraph('g', [node('x'), node('y'), node('z', ['x'])]);
    expect(topoLevels(g)).toEqual([['x', 'y'], ['z']]);
  });
});

describe('settlement / convergence helpers', () => {
  it('isSettled is false while something is pending/running', () => {
    const g = createGraph('g', [
      node('a', [], { status: 'done' }),
      node('b', ['a'], { status: 'running' }),
    ]);
    expect(isSettled(g)).toBe(false);
  });

  it('isSettled is true when all terminal (even with errors)', () => {
    const g = createGraph('g', [
      node('a', [], { status: 'done' }),
      node('b', ['a'], { status: 'error' }),
    ]);
    expect(isSettled(g)).toBe(true);
    expect(isConverged(g)).toBe(false); // error blocks convergence
  });

  it('isConverged requires all done/skipped', () => {
    const g = createGraph('g', [
      node('a', [], { status: 'done' }),
      node('b', ['a'], { status: 'skipped' }),
    ]);
    expect(isConverged(g)).toBe(true);
  });

  it('isConverged is false for an empty graph', () => {
    expect(isConverged(createGraph('g', []))).toBe(false);
  });

  it('failedNodeIds lists errored nodes', () => {
    const g = createGraph('g', [
      node('a', [], { status: 'error' }),
      node('b', [], { status: 'done' }),
    ]);
    expect(failedNodeIds(g)).toEqual(['a']);
  });

  it('countByStatus tallies each state', () => {
    const g = createGraph('g', [
      node('a', [], { status: 'done' }),
      node('b', [], { status: 'running' }),
      node('c', [], { status: 'pending' }),
      node('d', [], { status: 'error' }),
    ]);
    expect(countByStatus(g)).toEqual({
      pending: 1,
      running: 1,
      done: 1,
      error: 1,
      skipped: 0,
    });
  });
});
