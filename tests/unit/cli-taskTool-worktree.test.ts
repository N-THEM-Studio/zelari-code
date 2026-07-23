import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTaskTool,
  type SubAgentContext,
  type SubAgentHarness,
} from '../../src/cli/tools/taskTool.js';
import type { BrainEvent } from '@zelari/core/shared/events';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

/** Fake harness that replays a fixed event sequence ending in a conclusion. */
function fakeHarness(events: Array<Partial<BrainEvent>>): SubAgentHarness {
  return {
    async *run() {
      for (const e of events) yield e as BrainEvent;
    },
  };
}

const dummyContext: SubAgentContext = {
  providerStream: (async function* () {})() as never,
  model: 'm',
  provider: 'openai-compatible',
  registry: {} as never,
  tools: [],
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

describe('createTaskTool — G2 worktree auto-merge (K7)', () => {
  let root: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kraken-wt-'));
    // Minimal git repo with one commit on the main branch.
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'kraken@zelari.local']);
    git(root, ['config', 'user.name', 'Kraken Test']);
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);

    // Enable worktree isolation + default auto-merge (KEEP off).
    for (const k of [
      'ZELARI_KRAKEN_WORKTREE',
      'ZELARI_KRAKEN_WORKTREE_KEEP',
      'ZELARI_KRAKEN_WORKTREE_AUTO_MERGE',
    ]) {
      envBackup[k] = process.env[k];
    }
    process.env.ZELARI_KRAKEN_WORKTREE = '1';
    delete process.env.ZELARI_KRAKEN_WORKTREE_KEEP;
    delete process.env.ZELARI_KRAKEN_WORKTREE_AUTO_MERGE;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('squash-merges the tentacle branch so edits survive cleanup', async () => {
    const ctx: ToolContext = {
      signal: new AbortController().signal,
      cwd: root,
      audit: () => {},
      sessionId: 'wt-test',
    };

    const tool = createTaskTool({
      createSubAgentContext: async ({ cwd }) => {
        // Simulate the general tentacle editing a file inside the worktree.
        writeFileSync(path.join(cwd, 'merged.txt'), 'from tentacle\n');
        return { ...dummyContext, cwd };
      },
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: 'edited merged.txt' } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
    });

    const res = await tool.execute(
      { description: 'edit file', prompt: 'add merged.txt', agent: 'general' },
      ctx,
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      // Footer reports a successful merge.
      expect(res.value.result).toMatch(/worktree merge \[ok\]/);
      // The tentacle's edit landed in the parent HEAD (not lost to cleanup).
      const mergedPath = path.join(root, 'merged.txt');
      expect(existsSync(mergedPath)).toBe(true);
      expect(readFileSync(mergedPath, 'utf8').trim()).toBe('from tentacle');
      // Parent repo has a merge commit on top of init.
      const log = git(root, ['log', '--oneline']);
      expect(log).toMatch(/kraken: merge/);
    }
  });

  it('skips merge (bare cleanup) when AUTO_MERGE=0', async () => {
    process.env.ZELARI_KRAKEN_WORKTREE_AUTO_MERGE = '0';

    const ctx: ToolContext = {
      signal: new AbortController().signal,
      cwd: root,
      audit: () => {},
      sessionId: 'wt-nomerge',
    };

    const tool = createTaskTool({
      createSubAgentContext: async ({ cwd }) => {
        writeFileSync(path.join(cwd, 'skipped.txt'), 'tentacle\n');
        return { ...dummyContext, cwd };
      },
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: 'done' } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
    });

    const res = await tool.execute(
      { description: 'edit file', prompt: 'add skipped.txt', agent: 'general' },
      ctx,
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      // No merge footer — just "worktree used".
      expect(res.value.result).toMatch(/worktree used:/);
      expect(res.value.result).not.toMatch(/worktree merge/);
      // Edit did NOT land in parent (cleanup ran without merge).
      expect(existsSync(path.join(root, 'skipped.txt'))).toBe(false);
    }
  });

  it('keeps worktree + branch when KEEP=1 (no merge, no cleanup)', async () => {
    process.env.ZELARI_KRAKEN_WORKTREE_KEEP = '1';

    const ctx: ToolContext = {
      signal: new AbortController().signal,
      cwd: root,
      audit: () => {},
      sessionId: 'wt-keep',
    };

    const tool = createTaskTool({
      createSubAgentContext: async ({ cwd }) => {
        writeFileSync(path.join(cwd, 'kept.txt'), 'tentacle\n');
        return { ...dummyContext, cwd };
      },
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: 'done' } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
    });

    const res = await tool.execute(
      { description: 'edit file', prompt: 'add kept.txt', agent: 'general' },
      ctx,
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.result).toMatch(/worktree kept:/);
      // Worktree dir still exists on disk.
      const wtRoot = path.join(root, '.zelari', 'worktrees');
      const dirs = execFileSync('ls', [wtRoot], { encoding: 'utf8' }).trim();
      expect(dirs.length).toBeGreaterThan(0);
    }
  });
});
