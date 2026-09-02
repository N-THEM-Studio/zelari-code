/**
 * Kraken slice 2: model routing (K5), radio (K8), worktree helpers (K7),
 * verify-hint + spawn reset (K4/K3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveKrakenPlannerModel,
  resolveKrakenSubModel,
} from '../../src/cli/tools/krakenModel.js';
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
  resetTaskVerifyObligation,
  maxTaskSpawnsPerTurn,
  taskVerifyObligation,
  verifyHintForGeneral,
  type SubAgentContext,
  type SubAgentHarness,
} from '../../src/cli/tools/taskTool.js';
import type { AgentHarnessConfig } from '@zelari/core/harness';
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

describe('resolveKrakenPlannerModel', () => {
  it('defaults to parent / lead model when env unset', () => {
    expect(resolveKrakenPlannerModel('grok-4', {})).toBe('grok-4');
  });

  it('planner env wins over the forwarded lead model', () => {
    expect(
      resolveKrakenPlannerModel('grok-4', {
        ZELARI_KRAKEN_PLANNER_MODEL: 'planner-lite',
      }),
    ).toBe('planner-lite');
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

/**
 * t78 (ADR-0033 slice): runtime `general ⇒ verify` obligation on the `task`
 * tool path. After a successful general, the tool itself spawns a verify with
 * the SAME acceptance[]; a parseable FAIL gets at most one rework round
 * (DEFAULT_MAX_REVIEW_ROUNDS parity); no passing verify by end of budget
 * leaves the obligation open for the strict-done gate (exit 4).
 */
describe('runtime general⇒verify obligation (t78)', () => {
  /** Deps that replay a queued conclusion per spawn and record what ran. */
  function scriptedDeps() {
    const seenAgents: string[] = [];
    const seenUserPrompts: string[] = [];
    const queue: string[] = [];
    const deps = {
      allowWorktree: false as const,
      createSubAgentContext: async ({ agent, cwd }: { agent: string; cwd: string }) => {
        seenAgents.push(agent);
        return { ...dummyContext, cwd, model: 'm1' };
      },
      harnessFactory: (config: AgentHarnessConfig) => {
        const delta = queue.shift() ?? '';
        const user = config.messages.find((m) => m.role === 'user');
        seenUserPrompts.push(user?.content ?? '');
        return fakeHarness([
          { type: 'message_start' },
          { type: 'message_delta', delta } as Partial<BrainEvent>,
          { type: 'message_end' },
        ]);
      },
    };
    return { deps, seenAgents, seenUserPrompts, queue };
  }

  let prevRounds: string | undefined;

  beforeEach(() => {
    resetTaskSpawnCount();
    resetTaskVerifyObligation();
    prevRounds = process.env.ZELARI_KRAKEN_MAX_REVIEW_ROUNDS;
    delete process.env.ZELARI_KRAKEN_MAX_REVIEW_ROUNDS;
  });

  afterEach(() => {
    if (prevRounds === undefined) delete process.env.ZELARI_KRAKEN_MAX_REVIEW_ROUNDS;
    else process.env.ZELARI_KRAKEN_MAX_REVIEW_ROUNDS = prevRounds;
    resetTaskVerifyObligation();
  });

  it('auto-spawns a verify with the same acceptance and clears the obligation on PASS', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-t78-pass-'));
    try {
      const { deps, seenAgents, seenUserPrompts, queue } = scriptedDeps();
      queue.push('edited foo', 'checks ran\nVERDICT: PASS');
      const tool = createTaskTool(deps);
      const res = await tool.execute(
        { description: 'fix foo', prompt: 'edit foo', agent: 'general', acceptance: ['tests pass'] },
        { ...ctx, cwd: root, sessionId: 't78-pass' },
      );
      expect(res.ok).toBe(true);
      // Runtime obligation: a second spawn (verify) happened WITHOUT the
      // parent asking for it — the hint footer alone is no longer the gate.
      expect(seenAgents).toEqual(['general', 'verify']);
      // Same acceptance[] reaches the auto-spawned verify, with the trailer
      // instruction the rework loop parses.
      expect(seenUserPrompts[1]).toContain('tests pass');
      expect(seenUserPrompts[1]).toContain('edit foo');
      expect(seenUserPrompts[1]).toContain('VERDICT: PASS');
      if (res.ok) {
        expect(res.value.result).toMatch(/\[kraken:auto-verify\] verify PASS/);
      }
      expect(taskVerifyObligation()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('on FAIL spends ONE rework round in the same tree, then verifies again', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-t78-rework-'));
    try {
      const { deps, seenAgents, seenUserPrompts, queue } = scriptedDeps();
      queue.push(
        'edited foo',
        'the error path is not handled\nVERDICT: FAIL',
        'handled the error path',
        'fixed now\nVERDICT: PASS',
      );
      const tool = createTaskTool(deps);
      const res = await tool.execute(
        { description: 'fix foo', prompt: 'edit foo', agent: 'general', acceptance: ['tests pass'] },
        { ...ctx, cwd: root, sessionId: 't78-rework' },
      );
      expect(res.ok).toBe(true);
      // writer → verify FAIL → rework (writer again) → fresh verify PASS.
      expect(seenAgents).toEqual(['general', 'verify', 'general', 'verify']);
      // The rework carries the reviewer findings — it must not redo work blind.
      expect(seenUserPrompts[2]).toContain('REJECTED');
      expect(seenUserPrompts[2]).toContain('the error path is not handled');
      if (res.ok) {
        expect(res.value.result).toMatch(/verify PASS/);
      }
      expect(taskVerifyObligation()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('FAIL after the rework budget leaves the obligation open (strict done blocks)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-t78-unresolved-'));
    try {
      const { deps, seenAgents, queue } = scriptedDeps();
      queue.push('edited foo', 'still broken\nVERDICT: FAIL', 'tried again', 'still broken\nVERDICT: FAIL');
      const tool = createTaskTool(deps);
      const res = await tool.execute(
        { description: 'fix foo', prompt: 'edit foo', agent: 'general' },
        { ...ctx, cwd: root, sessionId: 't78-open' },
      );
      // The general itself succeeded — the tool result stays ok, but the
      // unresolved verify debt must be visible for the strict-done gate.
      expect(res.ok).toBe(true);
      // Exactly one rework: no second round after the budget is spent.
      expect(seenAgents).toEqual(['general', 'verify', 'general', 'verify']);
      if (res.ok) {
        expect(res.value.result).toMatch(/UNVERIFIED/);
      }
      const debt = taskVerifyObligation();
      expect(debt?.description).toBe('fix foo');
      expect(debt?.detail).toMatch(/FAIL/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an unknown verdict (no parseable trailer) spawns no rework but stays unverified', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-t78-unknown-'));
    try {
      const { deps, seenAgents, queue } = scriptedDeps();
      queue.push('edited foo', 'cannot tell, tooling was degraded');
      const tool = createTaskTool(deps);
      const res = await tool.execute(
        { description: 'fix foo', prompt: 'edit foo', agent: 'general' },
        { ...ctx, cwd: root, sessionId: 't78-unknown' },
      );
      expect(res.ok).toBe(true);
      expect(seenAgents).toEqual(['general', 'verify']);
      if (res.ok) {
        expect(res.value.result).toMatch(/no parseable VERDICT/);
        expect(res.value.result).toMatch(/UNVERIFIED/);
      }
      expect(taskVerifyObligation()?.description).toBe('fix foo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('explore never creates an obligation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zelari-t78-explore-'));
    try {
      const { deps, seenAgents, queue } = scriptedDeps();
      queue.push('found it');
      const tool = createTaskTool(deps);
      const res = await tool.execute(
        { description: 'look', prompt: 'find X', agent: 'explore' },
        { ...ctx, cwd: root, sessionId: 't78-explore' },
      );
      expect(res.ok).toBe(true);
      expect(seenAgents).toEqual(['explore']);
      expect(taskVerifyObligation()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('TUI consumes the obligation (useChatTurn wiring)', () => {
    const src = readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'cli', 'hooks', 'useChatTurn.ts'),
      'utf-8',
    );
    expect(src).toMatch(/\btaskVerifyObligation\b/);
    expect(src).toMatch(/\bstrictDoneEnabled\b/);
    expect(src).toMatch(/turn is NOT verified-complete/);
    expect(src).toMatch(/finished without a passing verify/);
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

  it('parses /kraken graph <goal> (F6)', () => {
    const a = handleSlashCommand('/kraken graph fix the auth bug');
    expect(a.handled).toBe(true);
    expect(a.kind).toBe('kraken_graph');
    expect(a.graphPrompt).toBe('fix the auth bug');
  });

  it('parses /kraken graph with no goal as an empty prompt', () => {
    const a = handleSlashCommand('/kraken graph');
    expect(a.handled).toBe(true);
    expect(a.kind).toBe('kraken_graph');
    expect(a.graphPrompt).toBe('');
  });
});
