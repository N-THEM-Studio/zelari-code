import { describe, it, expect } from 'vitest';
import {
  planTaskGraph,
  extractJsonObject,
  buildGraphFromPlan,
  type PlannerLlmClient,
} from '../../src/cli/kraken/planner.js';

function client(responses: string[]): PlannerLlmClient & { calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = [];
  let i = 0;
  return {
    calls,
    async complete(opts) {
      calls.push(opts);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    },
  };
}

describe('extractJsonObject', () => {
  it('parses clean JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown code fences', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('ignores trailing prose after the balanced object', () => {
    expect(extractJsonObject('{"a":1} thanks for asking!')).toEqual({ a: 1 });
  });

  it('handles braces inside string values without miscounting depth', () => {
    expect(extractJsonObject('{"a":"contains { and } chars"}')).toEqual({
      a: 'contains { and } chars',
    });
  });

  it('throws on text with no JSON object', () => {
    expect(() => extractJsonObject('no json here')).toThrow();
  });

  it('repairs single-quoted strings (Python/JS-dict style)', () => {
    expect(extractJsonObject(`{'nodes': [{'id': 'e1', 'kind': 'explore'}]}`)).toEqual({
      nodes: [{ id: 'e1', kind: 'explore' }],
    });
  });

  it('repairs unquoted / bareword object keys (JS-object-literal style)', () => {
    expect(extractJsonObject(`{nodes: [{id: "e1", kind: "explore", deps: []}]}`)).toEqual({
      nodes: [{ id: 'e1', kind: 'explore', deps: [] }],
    });
  });

  it('repairs trailing commas before } and ]', () => {
    expect(extractJsonObject(`{"nodes": [{"id": "e1", "deps": [],},],}`)).toEqual({
      nodes: [{ id: 'e1', deps: [] }],
    });
  });

  it('repairs a combination of all three mistakes at once', () => {
    expect(
      extractJsonObject(`{nodes: [{id: 'e1', kind: 'explore', deps: [],},]}`),
    ).toEqual({ nodes: [{ id: 'e1', kind: 'explore', deps: [] }] });
  });

  it('does not mangle a double-quoted string containing an apostrophe', () => {
    expect(extractJsonObject(`{"label": "it's fine"}`)).toEqual({ label: "it's fine" });
  });
});

describe('buildGraphFromPlan', () => {
  it('auto-injects a verify node after a single general node, no merge', () => {
    const graph = buildGraphFromPlan('g', [
      { id: 'g1', kind: 'general', label: 'do thing', prompt: 'do thing', deps: [] },
    ]);
    expect(graph.nodes.has('verify-g1')).toBe(true);
    expect(graph.nodes.get('verify-g1')?.deps).toEqual(['g1']);
    expect([...graph.nodes.values()].some((n) => n.kind === 'merge')).toBe(false);
  });

  it('auto-injects verify per general plus a merge node depending on all verifies when >=2 generals', () => {
    const graph = buildGraphFromPlan('g', [
      { id: 'g1', kind: 'general', label: 'a', prompt: 'a', deps: [], scope: ['src/a'] },
      { id: 'g2', kind: 'general', label: 'b', prompt: 'b', deps: [], scope: ['src/b'] },
    ]);
    expect(graph.nodes.has('verify-g1')).toBe(true);
    expect(graph.nodes.has('verify-g2')).toBe(true);
    const merge = [...graph.nodes.values()].find((n) => n.kind === 'merge');
    expect(merge).toBeDefined();
    expect(merge?.deps.sort()).toEqual(['verify-g1', 'verify-g2']);
    // scope passthrough
    expect(graph.nodes.get('g1')?.scope).toEqual(['src/a']);
    expect(graph.nodes.get('g2')?.scope).toEqual(['src/b']);
  });

  it('avoids id collisions when an injected id already exists', () => {
    const graph = buildGraphFromPlan('g', [
      { id: 'g1', kind: 'general', label: 'a', prompt: 'a', deps: [] },
      { id: 'verify-g1', kind: 'general', label: 'weirdly named', prompt: 'x', deps: [] },
    ]);
    // both 'g1' and 'verify-g1' are general nodes -> each gets an injected
    // verify id; the second must not collide with the literal node id 'verify-g1'.
    const ids = [...graph.nodes.keys()];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('planTaskGraph', () => {
  it('returns a valid graph on the first attempt', async () => {
    const c = client([
      JSON.stringify({
        nodes: [
          { id: 'e1', kind: 'explore', label: 'research', prompt: 'find the auth code', deps: [] },
          {
            id: 'g1',
            kind: 'general',
            label: 'fix auth',
            prompt: 'fix the bug',
            deps: ['e1'],
            acceptance: ['tests pass'],
          },
        ],
      }),
    ]);

    const graph = await planTaskGraph({ prompt: 'fix the auth bug', llmClient: c });

    expect(graph.nodes.has('e1')).toBe(true);
    expect(graph.nodes.has('g1')).toBe(true);
    expect(graph.nodes.has('verify-g1')).toBe(true);
    expect(c.calls).toHaveLength(1);
  });

  it('succeeds on the first attempt even when the model emits loose JS-object-style JSON', async () => {
    const c = client([
      `{nodes: [{id: 'g1', kind: 'general', label: 'fix it', prompt: 'fix it', deps: [],},]}`,
    ]);

    const graph = await planTaskGraph({ prompt: 'fix the thing', llmClient: c });

    expect(graph.nodes.has('g1')).toBe(true);
    expect(c.calls).toHaveLength(1); // repaired in-place, no retry needed
  });

  it('retries once with corrective feedback after malformed JSON, then succeeds', async () => {
    const c = client([
      'sorry, here is some prose with no json',
      JSON.stringify({
        nodes: [{ id: 'g1', kind: 'general', label: 'do it', prompt: 'do it', deps: [] }],
      }),
    ]);

    const graph = await planTaskGraph({ prompt: 'do the thing', llmClient: c });

    expect(graph.nodes.has('g1')).toBe(true);
    expect(c.calls).toHaveLength(2);
    expect(c.calls[1].user).toContain('invalid');
  });

  it('retries once after a graph that fails validateGraph (unknown dep), then succeeds', async () => {
    const c = client([
      JSON.stringify({
        nodes: [
          { id: 'g1', kind: 'general', label: 'a', prompt: 'a', deps: ['nonexistent'] },
        ],
      }),
      JSON.stringify({
        nodes: [{ id: 'g1', kind: 'general', label: 'a', prompt: 'a', deps: [] }],
      }),
    ]);

    const graph = await planTaskGraph({ prompt: 'goal', llmClient: c });

    expect(graph.nodes.has('g1')).toBe(true);
    expect(c.calls).toHaveLength(2);
  });

  it('throws after exhausting attempts on persistent malformed output', async () => {
    const c = client(['not json', 'still not json']);

    await expect(planTaskGraph({ prompt: 'goal', llmClient: c })).rejects.toThrow(
      /failed to produce a valid task graph/,
    );
    expect(c.calls).toHaveLength(2);
  });

  it('rejects a schema violation (e.g. kind="verify" from the model) and retries', async () => {
    const c = client([
      JSON.stringify({
        nodes: [{ id: 'v1', kind: 'verify', label: 'nope', prompt: 'nope', deps: [] }],
      }),
      JSON.stringify({
        nodes: [{ id: 'e1', kind: 'explore', label: 'ok', prompt: 'ok', deps: [] }],
      }),
    ]);

    const graph = await planTaskGraph({ prompt: 'goal', llmClient: c });
    expect(graph.nodes.has('e1')).toBe(true);
    expect(c.calls).toHaveLength(2);
  });
});
