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
  formatKrakenGraphDigest,
  formatDuration,
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

describe('formatDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(840)).toBe('840ms');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(200_000)).toBe('3m20s');
    expect(formatDuration(180_000)).toBe('3m');
  });

  it('does not choke on nonsense input', () => {
    expect(formatDuration(Number.NaN)).toBe('?');
    expect(formatDuration(-1)).toBe('?');
  });
});

describe('formatKrakenGraphDigest', () => {
  it('reports each node with its kind, duration and conclusion, in topological order', () => {
    const graph = createGraph('d', [
      node('e1', [], { kind: 'explore', status: 'done', result: 'auth lives in src/auth' }),
      node('g1', ['e1'], { kind: 'general', status: 'done', result: 'wrote 3 files\nmore detail' }),
      node('v1', ['g1'], { kind: 'verify', status: 'error', error: 'tests failed' }),
    ]);

    const out = formatKrakenGraphDigest(graph, {
      durationsMs: { e1: 800, g1: 42_000, v1: 5_000 },
    });
    const lines = out.split('\n');

    expect(lines[0]).toBe('[✓] e1 (explore, 800ms) — auth lives in src/auth');
    // only the first line of a multi-line conclusion
    expect(lines[1]).toBe('[✓] g1 (general, 42s) — wrote 3 files');
    // a failed node shows why, not its (absent) result
    expect(lines[2]).toBe('[✗] v1 (verify, 5s) — tests failed');
  });

  it('omits the duration when none was recorded', () => {
    const graph = createGraph('d2', [
      node('g1', [], { kind: 'general', status: 'done', result: 'ok' }),
    ]);
    expect(formatKrakenGraphDigest(graph)).toBe('[✓] g1 (general) — ok');
  });

  it('renders a node that produced nothing without a dangling dash', () => {
    const graph = createGraph('d3', [node('g1', [], { kind: 'general', status: 'skipped' })]);
    expect(formatKrakenGraphDigest(graph)).toBe('[»] g1 (general)');
  });

  it('truncates a long conclusion', () => {
    const graph = createGraph('d4', [
      node('g1', [], { kind: 'general', status: 'done', result: 'x'.repeat(500) }),
    ]);
    const out = formatKrakenGraphDigest(graph, { maxResultChars: 10 });
    expect(out).toBe(`[✓] g1 (general) — ${'x'.repeat(10)}…`);
  });

  it('is empty for an empty graph', () => {
    expect(formatKrakenGraphDigest(createGraph('empty', []))).toBe('');
  });

  it('lists unresolved verify findings under the node lines', () => {
    // A converged graph a reviewer rejected still converged — without this
    // section it reads identically to a clean one.
    const graph = createGraph('d5', [
      node('g1', [], { kind: 'general', status: 'done', result: 'built it' }),
    ]);
    const out = formatKrakenGraphDigest(graph, {
      unresolvedFindings: [
        {
          nodeId: 'g1',
          label: 'g1',
          reason: 'fail',
          findings: 'the error path is still unhandled\nsecond line ignored',
        },
        { nodeId: 'g2', label: 'g2', reason: 'unknown', findings: '' },
      ],
    });
    expect(out).toContain('unresolved verify findings:');
    expect(out).toContain('g1 (rejected, rework budget spent) — the error path is still unhandled');
    expect(out).not.toContain('second line ignored');
    expect(out).toContain('g2 (no parseable verdict)');
  });

  it('omits the findings section when there are none', () => {
    const graph = createGraph('d6', [
      node('g1', [], { kind: 'general', status: 'done', result: 'ok' }),
    ]);
    expect(formatKrakenGraphDigest(graph, { unresolvedFindings: [] })).not.toContain(
      'unresolved',
    );
  });
});
