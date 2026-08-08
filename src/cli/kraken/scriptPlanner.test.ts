/**
 * Kraken script planner — tests.
 *
 * Covers:
 *   - `extractCodeBlock` — markdown fence stripping
 *   - `planScript` — happy path, retry on compile failure, empty response
 *
 * Tests pass a `llmClient` override so the planner never hits the network.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractCodeBlock,
  planScript,
  KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT,
  type PlanScriptOptions,
} from './scriptPlanner.js';
import type { PlannerLlmClient } from './planner.js';

function fakeClient(responses: string[]): { client: PlannerLlmClient; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const client: PlannerLlmClient = {
    async complete({ system, user }) {
      calls.push(user);
      const out = responses[i] ?? responses[responses.length - 1] ?? '';
      i += 1;
      // Sanity: the system prompt should mention the SDK.
      if (!system.includes('tentacle')) {
        throw new Error('system prompt missing tentacle mention');
      }
      return out;
    },
  };
  return { client, calls };
}

describe('extractCodeBlock', () => {
  it('strips a ```ts fence', () => {
    expect(extractCodeBlock('```ts\nconst x = 1;\n```', 'ts')).toBe('const x = 1;');
  });
  it('strips a ```typescript fence', () => {
    expect(extractCodeBlock('```typescript\nconst x = 1;\n```', 'ts')).toBe('const x = 1;');
  });
  it('strips a ``` fence with no language', () => {
    expect(extractCodeBlock('```\nconst x = 1;\n```', 'ts')).toBe('const x = 1;');
  });
  it('returns the original text if no fence is present', () => {
    const src = 'const x = 1;';
    expect(extractCodeBlock(src, 'ts')).toBe(src);
  });
  it('trims surrounding whitespace', () => {
    expect(extractCodeBlock('  \n  const x = 1;\n  ', 'ts')).toBe('const x = 1;');
  });
});

describe('KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT', () => {
  it('mentions the SDK capabilities', () => {
    expect(KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT).toContain('tentacle');
    expect(KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT).toContain('merge');
    expect(KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT).toContain('while_');
    expect(KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT).toContain('until');
    expect(KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT).toContain('checkpoint');
  });
  it('warns against process / require / Buffer', () => {
    expect(KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT).toContain('process');
    expect(KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT).toContain('require');
    expect(KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT).toContain('Buffer');
  });
  it('says return ONLY code (no fence)', () => {
    expect(KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT).toMatch(/no markdown fence/i);
  });
});

describe('planScript', () => {
  it('writes a compilable plan to .zelari/kraken/runs/<graphId>/plan.ts', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-scriptplan-'));
    const goodSource = `
      import { tentacle, merge } from '@zelari/kraken-runtime';
      const a = await tentacle({ kind: 'explore', label: 'map', prompt: 'x' });
      await merge([a]);
    `;
    const { client, calls } = fakeClient([goodSource]);

    const result = await planScript({
      prompt: 'map the auth system',
      graphId: 'g-happy',
      cwd: tmp,
      llmClient: client,
    });

    expect(result.compiled).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.source).toContain("import { tentacle");
    expect(calls).toHaveLength(1);
    // The file is on disk.
    const written = await fs.readFile(result.planPath, 'utf8');
    expect(written).toBe(goodSource.trim());
    // Path is the expected one.
    expect(result.planPath).toBe(path.join(tmp, '.zelari', 'kraken', 'runs', 'g-happy', 'plan.ts'));
  });

  it('retries on compile failure and succeeds on the second attempt', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-scriptplan-'));
    // A real SYNTAX error: unbalanced brace. esbuild fails on parse.
    const broken = `function oops( { return 1;`;
    const good = `import { log } from '@zelari/kraken-runtime';\nlog('hello');`;
    const { client, calls } = fakeClient([broken, good]);

    const result = await planScript({
      prompt: 'do a thing',
      graphId: 'g-retry',
      cwd: tmp,
      llmClient: client,
    });

    expect(result.attempts).toBe(2);
    expect(result.compiled).toBe(true);
    expect(calls).toHaveLength(2);
    // The corrective user message should mention the previous error.
    expect(calls[1]).toMatch(/failed to compile/i);
  });

  it('throws after MAX_PLAN_ATTEMPTS on persistent compile failure', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-scriptplan-'));
    const broken = `function oops( { return 1;`;
    const { client } = fakeClient([broken, broken]);

    await expect(
      planScript({
        prompt: 'still broken',
        graphId: 'g-fail',
        cwd: tmp,
        llmClient: client,
      }),
    ).rejects.toThrowError(/failed to produce a compilable plan/);
  });

  it('retries on empty response and succeeds on the second attempt', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-scriptplan-'));
    const good = `import { log } from '@zelari/kraken-runtime';\nlog('ok');`;
    const { client } = fakeClient(['', good]);

    const result = await planScript({
      prompt: 'empty first',
      graphId: 'g-empty',
      cwd: tmp,
      llmClient: client,
    });

    expect(result.attempts).toBe(2);
    expect(result.compiled).toBe(true);
  });

  it('strips a ```ts fence from the LLM reply', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-scriptplan-'));
    const fenced = '```ts\nimport { log } from \'@zelari/kraken-runtime\';\nlog(\'ok\');\n```';
    const { client } = fakeClient([fenced]);

    const result = await planScript({
      prompt: 'fenced',
      graphId: 'g-fence',
      cwd: tmp,
      llmClient: client,
    });

    expect(result.compiled).toBe(true);
    expect(result.source.startsWith('import')).toBe(true);
    expect(result.source).not.toContain('```');
  });

  it('rejects an empty prompt (Zod schema)', async () => {
    await expect(
      planScript({ prompt: '', llmClient: fakeClient(['']).client } as PlanScriptOptions),
    ).rejects.toThrowError(/prompt|Too small/i);
  });
});
