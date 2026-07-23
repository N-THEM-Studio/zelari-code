/**
 * Kraken slice 2: model routing (K5), radio (K8), worktree helpers (K7),
 * verify-hint + spawn reset (K4/K3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveKrakenSubModel } from '../../src/cli/tools/krakenModel.js';
import {
  appendKrakenRadio,
  readKrakenRadio,
  formatKrakenRadioStatus,
  listKrakenRadioSessions,
} from '../../src/cli/tools/krakenRadio.js';
import {
  isKrakenWorktreeEnabled,
  shouldKeepWorktree,
  formatWorktreeFooter,
  type WorktreeHandle,
} from '../../src/cli/tools/krakenWorktree.js';
import {
  createTaskTool,
  resetTaskSpawnCount,
  maxTaskSpawnsPerTurn,
  verifyHintForGeneral,
  type SubAgentContext,
  type SubAgentHarness,
} from '../../src/cli/tools/taskTool.js';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';
import type { BrainEvent } from '@zelari/core/shared/events';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

const ctx: ToolContext = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  audit: () => {},
  sessionId: 'test-session',
};

function fakeHarness(events: Array<Partial<BrainEvent>>): SubAgentHarness {
  return {
    async *run() {
      for (const e of events) yield e as BrainEvent;
    },
  };
}

const dummyContext: SubAgentContext = {
  providerStream: (async function* () {})() as never,
  model: 'parent-model',
  provider: 'openai-compatible',
  registry: {} as never,
  tools: [],
};

describe('resolveKrakenSubModel (K5)', () => {
  it('defaults to parent model when env unset', () => {
    expect(resolveKrakenSubModel('explore', 'grok-4', {})).toBe('grok-4');
    expect(resolveKrakenSubModel('general', 'grok-4', {})).toBe('grok-4');
    expect(resolveKrakenSubModel('verify', 'grok-4', {})).toBe('grok-4');
  });

  it('uses ZELARI_KRAKEN_SUB_MODEL for explore/verify but not general by default', () => {
    const env = { ZELARI_KRAKEN_SUB_MODEL: 'cheap-mini' };
    expect(resolveKrakenSubModel('explore', 'grok-4', env)).toBe('cheap-mini');
    expect(resolveKrakenSubModel('verify', 'grok-4', env)).toBe('cheap-mini');
    expect(resolveKrakenSubModel('general', 'grok-4', env)).toBe('grok-4');
  });

  it('general uses sub model when ZELARI_KRAKEN_GENERAL_USES_SUB=1', () => {
    const env = {
      ZELARI_KRAKEN_SUB_MODEL: 'cheap-mini',
      ZELARI_KRAKEN_GENERAL_USES_SUB: '1',
    };
    expect(resolveKrakenSubModel('general', 'grok-4', env)).toBe('cheap-mini');
  });

  it('kind-specific env wins over shared', () => {
    const env = {
      ZELARI_KRAKEN_SUB_MODEL: 'cheap-mini',
      ZELARI_KRAKEN_EXPLORE_MODEL: 'explore-special',
      ZELARI_KRAKEN_VERIFY_MODEL: 'verify-special',
      ZELARI_KRAKEN_GENERAL_MODEL: 'general-special',
    };
    expect(resolveKrakenSubModel('explore', 'grok-4', env)).toBe('explore-special');
    expect(resolveKrakenSubModel('verify', 'grok-4', env)).toBe('verify-special');
    expect(resolveKrakenSubModel('general', 'grok-4', env)).toBe('general-special');
  });
});

describe('krakenRadio (K8)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kraken-radio-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('appends and reads JSONL events', () => {
    appendKrakenRadio(root, 'sess1', {
      kind: 'spawn',
      agent: 'explore',
      description: 'map parser',
      thoroughness: 'quick',
    });
    appendKrakenRadio(root, 'sess1', {
      kind: 'done',
      agent: 'explore',
      description: 'map parser',
      detail: 'found src/parser.ts',
      ok: true,
      durationMs: 12,
    });
    const events = readKrakenRadio(root, 'sess1');
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('spawn');
    expect(events[1].ok).toBe(true);
    expect(listKrakenRadioSessions(root)).toContain('sess1');
    const status = formatKrakenRadioStatus(root, 'sess1');
    expect(status).toMatch(/Kraken radio/);
    expect(status).toContain('map parser');
    const file = path.join(root, '.zelari', 'radio', 'sess1.jsonl');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('format empty session is friendly', () => {
    expect(formatKrakenRadioStatus(root, 'empty')).toMatch(/no events/i);
  });
});

describe('krakenWorktree flags (K7)', () => {
  it('isKrakenWorktreeEnabled parses truthy env', () => {
    expect(isKrakenWorktreeEnabled({})).toBe(false);
    expect(isKrakenWorktreeEnabled({ ZELARI_KRAKEN_WORKTREE: '1' })).toBe(true);
    expect(isKrakenWorktreeEnabled({ ZELARI_KRAKEN_WORKTREE: 'true' })).toBe(true);
    expect(isKrakenWorktreeEnabled({ ZELARI_KRAKEN_WORKTREE: '0' })).toBe(false);
  });

  it('shouldKeepWorktree and footer', () => {
    expect(shouldKeepWorktree({})).toBe(false);
    expect(shouldKeepWorktree({ ZELARI_KRAKEN_WORKTREE_KEEP: '1' })).toBe(true);
    const h: WorktreeHandle = {
      id: 'x',
      branch: 'kraken/t-x',
      path: '/tmp/wt',
      repoRoot: '/tmp/repo',
    };
    expect(formatWorktreeFooter(h, { kept: true })).toMatch(/kept/);
    expect(formatWorktreeFooter(h, { kept: false })).toMatch(/worktree used/);
  });
});

describe('taskTool K3/K4 integration', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kraken-task-'));
    resetTaskSpawnCount();
    delete process.env.ZELARI_KRAKEN_WORKTREE;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    resetTaskSpawnCount();
  });

  it('verifyHintForGeneral mentions acceptance', () => {
    const h = verifyHintForGeneral(['typecheck ok']);
    expect(h).toMatch(/verify-hint/);
    expect(h).toContain('typecheck ok');
  });

  it('resetTaskSpawnCount allows a new budget', async () => {
    const prev = process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS;
    process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS = '2';
    try {
      expect(maxTaskSpawnsPerTurn()).toBe(2);
      const tool = createTaskTool({
        allowWorktree: false,
        createSubAgentContext: async () => dummyContext,
        harnessFactory: () =>
          fakeHarness([
            { type: 'message_start' },
            { type: 'message_delta', delta: 'ok' } as Partial<BrainEvent>,
            { type: 'message_end' },
          ]),
      });
      const localCtx = { ...ctx, cwd: root, sessionId: 'cap-test' };
      expect((await tool.execute({ description: 'a', prompt: 'p' }, localCtx)).ok).toBe(true);
      expect((await tool.execute({ description: 'b', prompt: 'p' }, localCtx)).ok).toBe(true);
      const blocked = await tool.execute({ description: 'c', prompt: 'p' }, localCtx);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error).toMatch(/spawn cap/i);

      resetTaskSpawnCount();
      const again = await tool.execute({ description: 'd', prompt: 'p' }, localCtx);
      expect(again.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS;
      else process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS = prev;
    }
  });

  it('general result includes verify-hint footer and radio done/verify_hint', async () => {
    const tool = createTaskTool({
      allowWorktree: false,
      createSubAgentContext: async ({ cwd }) => ({ ...dummyContext, cwd, model: 'm1' }),
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: 'edited foo' } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
    });
    const localCtx = { ...ctx, cwd: root, sessionId: 'gen-test' };
    const res = await tool.execute(
      {
        description: 'fix foo',
        prompt: 'edit foo',
        agent: 'general',
        acceptance: ['tests pass'],
      },
      localCtx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.result).toMatch(/verify-hint/i);
      expect(res.value.result).toContain('tests pass');
      expect(res.value.result).toContain('model=m1');
    }
    const radio = readKrakenRadio(root, 'gen-test');
    expect(radio.some((e) => e.kind === 'spawn')).toBe(true);
    expect(radio.some((e) => e.kind === 'verify_hint' || e.kind === 'done')).toBe(true);
  });

  it('passes cwd into createSubAgentContext', async () => {
    let seenCwd: string | undefined;
    const tool = createTaskTool({
      allowWorktree: false,
      createSubAgentContext: async ({ cwd }) => {
        seenCwd = cwd;
        return dummyContext;
      },
      harnessFactory: () =>
        fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta: 'x' } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]),
    });
    await tool.execute({ description: 'c', prompt: 'p' }, { ...ctx, cwd: root });
    expect(seenCwd).toBe(root);
  });
});

describe('/kraken slash', () => {
  it('parses /kraken and optional session id', () => {
    const a = handleSlashCommand('/kraken');
    expect(a.handled).toBe(true);
    expect(a.kind).toBe('kraken_status');
    const b = handleSlashCommand('/kraken my-sess');
    expect(b.handled).toBe(true);
    expect(b.kind).toBe('kraken_status');
    expect(b.targetSessionId).toBe('my-sess');
  });
});
