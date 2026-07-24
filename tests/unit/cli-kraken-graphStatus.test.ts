import { describe, it, expect, beforeEach } from 'vitest';
import { createGraph, type TaskNode, type TaskNodeKind, type TaskNodeStatus } from '@zelari/core';
import {
  formatKrakenGraphAscii,
  startKrakenGraphLive,
  updateKrakenGraphLive,
  endKrakenGraphLive,
  resetKrakenGraphLive,
  getKrakenGraphLive,
  formatKrakenGraphSummary,
} from '../../src/cli/kraken/graphStatus.js';

function node(id: string, deps: string[] = [], over: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    kind: (over.kind as TaskNodeKind) ?? 'general',
    label: over.label ?? id,
    prompt: over.prompt ?? `do ${id}`,
    deps,
    status: (over.status as TaskNodeStatus) ?? 'pending',
    retryCount: over.retryCount ?? 0,
    maxRetries: over.maxRetries ?? 0,
    ...over,
  };
}

describe('formatKrakenGraphAscii', () => {
  it('renders topo levels with status icons and scope hints', () => {
    const graph = createGraph('g1', [
      node('e1', [], { kind: 'explore', status: 'done' }),
      node('g1n', ['e1'], { kind: 'general', status: 'running', scope: ['src/a'] }),
      node('g2n', ['e1'], { kind: 'general', status: 'error', scope: ['src/b'] }),
      node('v1', ['g1n'], { kind: 'verify', status: 'pending' }),
      node('v2', ['g2n'], { kind: 'verify', status: 'skipped' }),
    ]);

    const out = formatKrakenGraphAscii(graph);

    expect(out).toContain('Kraken graph "g1"');
    expect(out).toContain('1/5 done');
    expect(out).toContain('1 running');
    expect(out).toContain('1 failed');
    expect(out).toContain('1 skipped');
    expect(out).toContain('[✓] e1');
    expect(out).toContain('[…] g1n(src/a)');
    expect(out).toContain('[✗] g2n(src/b)');
    expect(out).toContain('[·] v1');
    expect(out).toContain('[»] v2');
  });

  it('handles an empty graph without throwing', () => {
    const graph = createGraph('empty', []);
    expect(() => formatKrakenGraphAscii(graph)).not.toThrow();
    expect(formatKrakenGraphAscii(graph)).toContain('0/0 done');
  });
});

describe('live graph tracker', () => {
  beforeEach(() => {
    resetKrakenGraphLive();
  });

  it('is null before any graph starts', () => {
    expect(getKrakenGraphLive()).toBeNull();
    expect(formatKrakenGraphSummary()).toBeNull();
  });

  it('tracks counts across start -> update -> end', () => {
    const graph = createGraph('g1', [
      node('a', [], { status: 'pending' }),
      node('b', [], { status: 'pending' }),
    ]);
    startKrakenGraphLive(graph);
    expect(getKrakenGraphLive()?.pending).toBe(2);
    expect(formatKrakenGraphSummary()).toBe('graph 0/2');

    graph.nodes.get('a')!.status = 'running';
    updateKrakenGraphLive(graph);
    expect(formatKrakenGraphSummary()).toBe('graph 0/2 · 1↑');

    graph.nodes.get('a')!.status = 'done';
    graph.nodes.get('b')!.status = 'error';
    updateKrakenGraphLive(graph);
    expect(formatKrakenGraphSummary()).toBe('graph 1/2 · 1✗');

    endKrakenGraphLive(graph, false);
    const live = getKrakenGraphLive();
    expect(live?.converged).toBe(false);
    expect(live?.endedAt).toBeDefined();
  });

  it('ignores update/end calls for a different graphId than the tracked one', () => {
    const g1 = createGraph('g1', [node('a')]);
    const g2 = createGraph('g2', [node('b')]);
    startKrakenGraphLive(g1);
    updateKrakenGraphLive(g2); // no-op: not the tracked graph
    expect(getKrakenGraphLive()?.graphId).toBe('g1');
  });
});
