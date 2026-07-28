import { describe, it, expect } from 'vitest';
import { parseVerifyVerdict } from '@zelari/core';
import {
  planTaskGraph,
  extractJsonObject,
  stripReasoningBlocks,
  buildGraphFromPlan,
  buildPlannerUserPrompt,
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

  // Regression: "Bad control character in string literal in JSON at position N".
  // The planner asks each node for a self-contained multi-line `prompt`, so
  // models emit real newlines inside the string instead of `\n` escapes —
  // illegal JSON that the repair pass used to copy through verbatim.
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);

  it('repairs a raw newline inside a double-quoted string', () => {
    expect(extractJsonObject(`{"prompt": "Do this:${NL}- one${NL}- two"}`)).toEqual({
      prompt: `Do this:${NL}- one${NL}- two`,
    });
  });

  it('repairs a raw tab and carriage return inside a double-quoted string', () => {
    expect(extractJsonObject(`{"prompt": "a${TAB}b\r\nc"}`)).toEqual({
      prompt: `a${TAB}b\r\nc`,
    });
  });

  it('repairs a raw newline inside a single-quoted string', () => {
    expect(extractJsonObject(`{'prompt': 'line one${NL}line two'}`)).toEqual({
      prompt: `line one${NL}line two`,
    });
  });

  it('repairs raw newlines in a full multi-node graph, preserving escapes', () => {
    const raw =
      `{"nodes": [{"id": "g1", "kind": "general", "label": "x",` +
      ` "prompt": "Build it.${NL}Rules:${NL}- keep the \\"quoted\\" name${NL}- use a\\ttab",` +
      ` "deps": []}]}`;
    const parsed = extractJsonObject(raw) as { nodes: Array<{ prompt: string }> };
    expect(parsed.nodes[0].prompt).toBe(
      `Build it.${NL}Rules:${NL}- keep the "quoted" name${NL}- use a${TAB}tab`,
    );
  });

  // Regression from a live run against MiniMax-M3: the model streams its
  // chain-of-thought inside message.content wrapped in <think> tags, and
  // sketches draft JSON while reasoning. The extractor picked up that
  // fragment and the plan failed schema validation with
  // 'nodes: expected array, received undefined'.
  describe('reasoning blocks in content', () => {
    const ANSWER = '{"nodes": [{"id": "g1", "kind": "general", "label": "x", "prompt": "y", "deps": []}]}';

    it('ignores a draft object sketched inside a <think> block', () => {
      const reply =
        `<think>${NL}Let me sketch a node: {"id": "g-add", "kind": "general"}${NL}` +
        `That looks right, now the full plan.${NL}</think>${NL}${NL}${ANSWER}`;

      expect(extractJsonObject(reply, { requireKey: 'nodes' })).toEqual({
        nodes: [{ id: 'g1', kind: 'general', label: 'x', prompt: 'y', deps: [] }],
      });
    });

    it('skips a leading fragment even without think tags, when a key is required', () => {
      const reply = `{"id": "g-add", "kind": "general"}${NL}${ANSWER}`;

      expect(extractJsonObject(reply, { requireKey: 'nodes' })).toHaveProperty('nodes');
    });

    it('still returns the first object when no key is required', () => {
      expect(extractJsonObject('{"a":1} {"b":2}')).toEqual({ a: 1 });
    });

    it('falls back to the first parseable object when none has the key', () => {
      expect(extractJsonObject('{"a":1}', { requireKey: 'nodes' })).toEqual({ a: 1 });
    });

    it('unwraps an answer nested one level down', () => {
      expect(extractJsonObject(`{"plan": ${ANSWER}}`, { requireKey: 'nodes' })).toEqual(
        JSON.parse(ANSWER),
      );
      expect(extractJsonObject(`{"graph": ${ANSWER}}`, { requireKey: 'nodes' })).toEqual(
        JSON.parse(ANSWER),
      );
    });

    it('handles <thinking> and <reasoning> tags too', () => {
      expect(
        extractJsonObject(`<thinking>draft {"id":"x"}</thinking>${ANSWER}`, { requireKey: 'nodes' }),
      ).toHaveProperty('nodes');
      expect(
        extractJsonObject(`<reasoning>draft {"id":"x"}</reasoning>${ANSWER}`, { requireKey: 'nodes' }),
      ).toHaveProperty('nodes');
    });

    it('drops everything after an unterminated <think> tag', () => {
      expect(stripReasoningBlocks(`${ANSWER}${NL}<think>still rambling {"id":"x"}`).trim()).toBe(
        ANSWER,
      );
    });
  });

  it('leaves already-escaped sequences alone', () => {
    expect(extractJsonObject('{"a": "line\\nbreak", "b": 1,}')).toEqual({
      a: 'line\nbreak',
      b: 1,
    });
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

  it('gives the auto-injected verify node the task, its scope and its acceptance', () => {
    const graph = buildGraphFromPlan('g', [
      {
        id: 'g1',
        kind: 'general',
        label: 'add jwt auth',
        prompt: 'Add JWT auth to the express server in src/auth.',
        deps: [],
        scope: ['src/auth'],
        acceptance: ['tokens expire in 15m', 'refresh endpoint exists'],
      },
    ]);

    const verify = graph.nodes.get('verify-g1');
    expect(verify?.prompt).toContain('add jwt auth');
    // the verify tentacle sees only this prompt, so it must restate the task
    expect(verify?.prompt).toContain('Add JWT auth to the express server in src/auth.');
    expect(verify?.prompt).toContain('## Paths the work was scoped to');
    expect(verify?.prompt).toContain('- src/auth');
    expect(verify?.prompt).toContain('## Acceptance criteria to check explicitly');
    expect(verify?.prompt).toContain('- tokens expire in 15m');
    expect(verify?.prompt).toContain('- refresh endpoint exists');
  });

  it('omits the optional verify sections when the general node has none', () => {
    const graph = buildGraphFromPlan('g', [
      { id: 'g1', kind: 'general', label: 'do thing', prompt: 'do thing', deps: [] },
    ]);
    const verify = graph.nodes.get('verify-g1');
    expect(verify?.prompt).toContain('## The task that was carried out');
    expect(verify?.prompt).not.toContain('## Paths the work was scoped to');
    expect(verify?.prompt).not.toContain('## Acceptance criteria to check explicitly');
  });

  it('asks the verify node for a parseable VERDICT trailer', () => {
    // Without the trailer the executor cannot tell "checked, it is wrong" from
    // "checked, it is right" — the verdict text was never read at all.
    const graph = buildGraphFromPlan('g', [
      { id: 'g1', kind: 'general', label: 'do thing', prompt: 'do thing', deps: [] },
    ]);
    const prompt = graph.nodes.get('verify-g1')?.prompt ?? '';
    expect(prompt).toContain('VERDICT: PASS');
    expect(prompt).toContain('VERDICT: FAIL');
    expect(prompt).toContain('as the LAST line');
    // The trailer is only useful if FAIL carries actionable detail back.
    expect(prompt).toContain('state each gap concretely');

    // And it must survive the round trip through the parser.
    expect(parseVerifyVerdict('checked it\n\nVERDICT: FAIL').verdict).toBe('fail');
  });

  it('truncates a very long task prompt quoted into the verify node', () => {
    const long = 'z'.repeat(5000);
    const graph = buildGraphFromPlan('g', [
      { id: 'g1', kind: 'general', label: 'big', prompt: long, deps: [] },
    ]);
    const verify = graph.nodes.get('verify-g1');
    expect(verify?.prompt).toContain('… [truncated]');
    expect(verify!.prompt.length).toBeLessThan(long.length);
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
        nodes: [
          { id: 'e1', kind: 'explore', label: 'ok', prompt: 'ok', deps: [] },
          { id: 'g1', kind: 'general', label: 'work', prompt: 'work', deps: ['e1'] },
        ],
      }),
    ]);

    const graph = await planTaskGraph({ prompt: 'goal', llmClient: c });
    expect(graph.nodes.has('e1')).toBe(true);
    expect(c.calls).toHaveLength(2);
  });

  // A plan of only read-only `explore` nodes would run, converge and report
  // success without touching a file — observed for real on a "continua".
  it('rejects an explore-only plan', async () => {
    const c = client([
      JSON.stringify({
        nodes: [{ id: 'e1', kind: 'explore', label: 'look around', prompt: 'look', deps: [] }],
      }),
      JSON.stringify({
        nodes: [{ id: 'g1', kind: 'general', label: 'work', prompt: 'work', deps: [] }],
      }),
    ]);

    const graph = await planTaskGraph({ prompt: 'continua', llmClient: c });

    expect(graph.nodes.has('g1')).toBe(true);
    expect(c.calls).toHaveLength(2);
    expect(c.calls[1]!.user).toMatch(/no "general" node/);
  });
});

describe('planner sees the project', () => {
  const PLAN = '{"nodes": [{"id": "g1", "kind": "general", "label": "x", "prompt": "y", "deps": []}]}';

  it('puts the project listing in the user prompt', () => {
    const user = buildPlannerUserPrompt('add auth', {
      workspace: '# Project: demo\n## Top-level files & directories\n- src/\n- tests/',
    });
    expect(user).toContain('Goal:\nadd auth');
    expect(user).toContain('## The project this goal is about (real files on disk)');
    expect(user).toContain('- src/');
    expect(user).toContain('Return ONLY the JSON object');
  });

  it('orders goal, project, previous attempt, instruction', () => {
    const user = buildPlannerUserPrompt('goal text', {
      workspace: 'WORKSPACE_BLOCK',
      previousAttempt: 'PREVIOUS_BLOCK',
    });
    expect(user.indexOf('goal text')).toBeLessThan(user.indexOf('WORKSPACE_BLOCK'));
    expect(user.indexOf('WORKSPACE_BLOCK')).toBeLessThan(user.indexOf('PREVIOUS_BLOCK'));
    expect(user.indexOf('PREVIOUS_BLOCK')).toBeLessThan(user.indexOf('Return ONLY'));
  });

  it('omits the section entirely when there is no project listing', () => {
    const user = buildPlannerUserPrompt('add auth');
    expect(user).not.toContain('The project this goal is about');
    expect(user).toContain('Goal:\nadd auth');
  });

  it('forwards an explicit workspace listing through planTaskGraph', async () => {
    const c = client([PLAN]);
    await planTaskGraph({
      prompt: 'add auth',
      llmClient: c,
      workspace: '# Project: demo\n- src/auth/',
    });
    expect(c.calls[0].user).toContain('- src/auth/');
  });

  it('plans blind when neither cwd nor workspace is given', async () => {
    const c = client([PLAN]);
    await planTaskGraph({ prompt: 'add auth', llmClient: c });
    expect(c.calls[0].user).not.toContain('The project this goal is about');
  });

  it('tells the model to build scopes from real paths', async () => {
    const c = client([PLAN]);
    await planTaskGraph({ prompt: 'add auth', llmClient: c, workspace: '- src/' });
    expect(c.calls[0].system).toContain('listing of the real project on disk');
  });
});
