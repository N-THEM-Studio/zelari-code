/**
 * taskTool.parentContext.test — §51 consumption of ContextPolicy by tentacles.
 *
 * runTentacle accepts an optional parentTranscript; when the role's policy
 * allows parent summaries (explore/general/verify), a compact projected
 * block is PREPENDED to the user prompt. Without the option the prompt is
 * byte-identical to the pre-§51 behavior.
 */
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentMessage } from '@zelari/core/harness';
import { runTentacle, type TaskToolDeps, type SubAgentContext } from './taskTool.js';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-parent-ctx-'));
}

function capturingDeps(): { deps: TaskToolDeps; userPrompts: () => string[] } {
  const prompts: string[] = [];
  const deps: TaskToolDeps = {
    createSubAgentContext: async ({ agent }) => {
      const ctx: SubAgentContext = {
        providerStream: (() => {
          throw new Error('not invoked by the scripted harness');
        }) as unknown as SubAgentContext['providerStream'],
        model: 'test-model',
        provider: 'test-provider',
        registry: new ToolRegistry(),
        tools: [],
        agent,
      };
      return ctx;
    },
    harnessFactory: (config) => {
      prompts.push(String(config.messages[1]?.content ?? ''));
      return {
        run: async function* () {
          yield { type: 'message_start' } as never;
          yield { type: 'message_delta', delta: 'probe done' } as never;
          yield { type: 'message_end' } as never;
        },
      };
    },
    allowWorktree: false,
  };
  return { deps, userPrompts: () => prompts };
}

const PARENT: AgentMessage[] = [
  { role: 'system', content: 'LEAD SYSTEM PROMPT — must not leak' },
  { role: 'user', content: 'Fix the refresh loop in src/auth/session.ts' },
  { role: 'assistant', content: 'Suspect double rotation of the refresh token.' },
];

async function spawn(agent: 'explore' | 'general' | 'verify', parentTranscript?: AgentMessage[]): Promise<string> {
  const { deps, userPrompts } = capturingDeps();
  const res = await runTentacle({
    deps,
    args: { description: 'probe auth', prompt: 'Investigate the auth module.' },
    agent,
    thoroughness: 'quick',
    parentCwd: tmpRoot(),
    sessionId: 'parent-ctx-test',
    ...(parentTranscript ? { parentTranscript } : {}),
  });
  expect(res.ok).toBe(true);
  return userPrompts()[0] ?? '';
}

describe('runTentacle parentTranscript (§51)', () => {
  it('explore receives the projected parent block before its task prompt', async () => {
    const prompt = await spawn('explore', PARENT);
    expect(prompt).toContain('[Parent agent context — projected summary');
    expect(prompt.indexOf('[Parent agent context')).toBeLessThan(prompt.indexOf('Investigate the auth module.'));
  });

  it('parent system prompt never leaks into the tentacle prompt', async () => {
    const prompt = await spawn('general', PARENT);
    expect(prompt).not.toContain('LEAD SYSTEM PROMPT');
  });

  it('without parentTranscript the prompt has no parent block (inert default)', async () => {
    const prompt = await spawn('verify');
    expect(prompt).not.toContain('[Parent agent context');
    expect(prompt).toContain('Investigate the auth module.');
  });

  it('empty parentTranscript is also inert', async () => {
    const prompt = await spawn('explore', []);
    expect(prompt).not.toContain('[Parent agent context');
  });
});
