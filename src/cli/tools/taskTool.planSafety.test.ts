/**
 * taskTool.planSafety.test — Fase 1 / ADR-0020 (Kraken Verified Selection).
 *
 * DoD della Fase 1:
 *   - PLAN può spawnare explore (task registrato, policy explore-only)
 *   - PLAN non può spawnare general né verify
 *   - PLAN non espone write/bash (read-only invariato)
 *   - BUILD task continua a comportarsi come prima
 *   - Cancel parent cancella il tentacolo (signal propagato a runTentacle)
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrainEvent } from '@zelari/core/shared/events';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { createBuiltinToolRegistry } from '../toolRegistry.js';
import {
  createTaskTool,
  resetTaskSpawnCount,
  type SubAgentContext,
  type TaskToolDeps,
} from './taskTool.js';
import {
  isKrakenSelectionEnabled,
  krakenCandidates,
  resetKrakenCandidates,
} from '../kraken/candidateRegistry.js';
import { AuditLogger } from '../safety/auditLogger.js';
import { defaultPermissionPolicy } from '../safety/toolPermissions.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-plan-safe-'));
}

function makeRegistry(extra: Record<string, unknown> = {}) {
  return createBuiltinToolRegistry({
    root: repoRoot,
    lspProvider: null,
    audit: new AuditLogger(
      path.join(
        tmpdir(),
        `zelari-plansafe-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
      ),
    ),
    permissionPolicy: defaultPermissionPolicy({ auto: true }),
    ...extra,
  });
}

function makeCtx(cwd = tmpRoot()): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    audit: () => undefined,
    sessionId: 'plan-safety-test',
  };
}

/** Deps fake: null context = "no provider" path, enough to observe the gate. */
function probeDeps() {
  const calls: string[] = [];
  const deps: TaskToolDeps = {
    createSubAgentContext: async ({ agent }) => {
      calls.push(agent);
      return null;
    },
    allowWorktree: false,
  };
  return { deps, calls };
}

/** Deps fake with a valid context + scripted harness (signal tests). */
function scriptedDeps(): { deps: TaskToolDeps; harnessStarted: () => number } {
  let started = 0;
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
    harnessFactory: () => ({
      run: async function* (): AsyncGenerator<BrainEvent> {
        started++;
        yield { type: 'message_start' } as BrainEvent;
        yield { type: 'message_delta', delta: 'tentacle conclusion' } as BrainEvent;
        yield { type: 'message_end' } as BrainEvent;
      },
    }),
    allowWorktree: false,
  };
  return { deps, harnessStarted: () => started };
}

describe('registry gating (ADR-0020 Fase 1)', () => {
  it('planMode registry registers task AND stays read-only', () => {
    const { tools } = makeRegistry({ planMode: true });
    const names = tools.map((t) => t.name);
    expect(names).toContain('task');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('apply_diff');
    expect(names).not.toContain('bash');
  });

  it('planMode task is wired explore-only (restricted schema + description)', () => {
    const { registry } = makeRegistry({ planMode: true });
    const task = registry.get('task');
    expect(task).toBeTruthy();
    expect(task?.description).toContain('RESTRICTED in this mode');
    // zod enum narrowed: general is not a valid value anymore
    const bad = (task?.inputSchema as { safeParse: (v: unknown) => { success: boolean } })
      ?.safeParse({ description: 'd', prompt: 'p', agent: 'general' });
    expect(bad?.success).toBe(false);
    const good = (task?.inputSchema as { safeParse: (v: unknown) => { success: boolean } })
      ?.safeParse({ description: 'd', prompt: 'p', agent: 'explore' });
    expect(good?.success).toBe(true);
  });

  it('planExploreTask=false restores the pre-ADR-0020 behaviour (no task in plan)', () => {
    const { tools } = makeRegistry({ planMode: true, planExploreTask: false });
    expect(tools.map((t) => t.name)).not.toContain('task');
  });

  it('full BUILD registry keeps task unrestricted (regression)', () => {
    const { registry, tools } = makeRegistry();
    expect(tools.map((t) => t.name)).toContain('task');
    expect(registry.get('task')?.description).not.toContain('RESTRICTED in this mode');
  });

  it('explicit readOnly registry omits task (sub-agent anti-recursion, regression)', () => {
    const { tools } = makeRegistry({ readOnly: true });
    expect(tools.map((t) => t.name)).not.toContain('task');
  });

  it('explore sub-profile omits task (no nesting, regression)', () => {
    const { tools } = makeRegistry({ profile: 'explore' });
    expect(tools.map((t) => t.name)).not.toContain('task');
  });
});

describe('task policy (ADR-0020 Fase 1)', () => {
  beforeEach(() => {
    resetTaskSpawnCount();
  });

  it('explore-only policy rejects agent=general BEFORE spawning or consuming budget', async () => {
    const { deps, calls } = probeDeps();
    const tool = createTaskTool(deps, { allowedAgents: ['explore'] });
    const res = await tool.execute(
      { description: 'd', prompt: 'p', agent: 'general' },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/not allowed in this mode/i);
      expect(res.error).toContain('explore');
    }
    expect(calls).toHaveLength(0);
    // budget NOT consumed: the very next spawn is still allowed
    const next = await tool.execute(
      { description: 'd', prompt: 'p', agent: 'verify' },
      makeCtx(),
    );
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.error).toMatch(/not allowed in this mode/i);
    expect(calls).toHaveLength(0);
  });

  it('explore-only policy accepts the default agent (explore reaches the context factory)', async () => {
    const { deps, calls } = probeDeps();
    const tool = createTaskTool(deps, { allowedAgents: ['explore'] });
    const res = await tool.execute({ description: 'd', prompt: 'p' }, makeCtx());
    expect(calls).toEqual(['explore']);
    // fake context is null → "no provider", which PROVES we got past the gate
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no provider/);
  });

  it('unrestricted BUILD tool still accepts general (regression)', async () => {
    const { deps, calls } = probeDeps();
    const tool = createTaskTool(deps);
    const res = await tool.execute(
      { description: 'd', prompt: 'p', agent: 'general' },
      makeCtx(),
    );
    expect(calls).toEqual(['general']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no provider/);
  });
});

describe('cancellation propagation (ADR-0020 Fase 1)', () => {  beforeEach(() => {
    resetTaskSpawnCount();
  });

  it('an already-aborted parent signal cancels the tentacle instead of running it', async () => {
    const { deps, harnessStarted } = scriptedDeps();
    const tool = createTaskTool(deps);
    const controller = new AbortController();
    controller.abort();
    const res = await tool.execute(
      { description: 'd', prompt: 'p', agent: 'explore' },
      { ...makeCtx(), signal: controller.signal },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cancelled/i);
    expect(harnessStarted()).toBe(0);
  });

  it('a live signal does not break the normal tentacle run (regression)', async () => {
    const { deps, harnessStarted } = scriptedDeps();
    const tool = createTaskTool(deps);
    const res = await tool.execute(
      { description: 'd', prompt: 'p', agent: 'explore' },
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.result).toContain('tentacle conclusion');
    expect(harnessStarted()).toBe(1);
  });
});

describe('candidate contract (ADR-0020 Fase 3)', () => {
  const ctx = makeCtx();

  beforeEach(() => {
    resetTaskSpawnCount();
    resetKrakenCandidates();
  });

  it('purpose=candidate is refused while the alpha flag is OFF', async () => {
    const prev = process.env.ZELARI_KRAKEN_SELECTION;
    delete process.env.ZELARI_KRAKEN_SELECTION;
    try {
      const { deps, calls } = probeDeps();
      const tool = createTaskTool(deps);
      const res = await tool.execute(
        { description: 'd', prompt: 'p', purpose: 'candidate' },
        ctx,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/ZELARI_KRAKEN_SELECTION=1/);
      expect(calls).toHaveLength(0);
      expect(krakenCandidates()).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.ZELARI_KRAKEN_SELECTION;
      else process.env.ZELARI_KRAKEN_SELECTION = prev;
    }
  });

  it('candidate forces agent=explore (general rejected without spawning)', async () => {
    process.env.ZELARI_KRAKEN_SELECTION = '1';
    try {
      const { deps, calls } = probeDeps();
      const tool = createTaskTool(deps);
      const res = await tool.execute(
        { description: 'd', prompt: 'p', agent: 'general', purpose: 'candidate' },
        ctx,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/forces agent=explore/);
      expect(calls).toHaveLength(0);
      expect(isKrakenSelectionEnabled()).toBe(true);
    } finally {
      delete process.env.ZELARI_KRAKEN_SELECTION;
    }
  });

  it('candidate failures are registered as malformed (slot consumed, evidence preserved)', async () => {
    process.env.ZELARI_KRAKEN_SELECTION = '1';
    try {
      // probeDeps returns a null context → tentacle fails with no provider
      const { deps } = probeDeps();
      const tool = createTaskTool(deps);
      const res = await tool.execute(
        { description: 'd', prompt: 'p', purpose: 'candidate' },
        ctx,
      );
      expect(res.ok).toBe(false);
      const all = krakenCandidates();
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe('malformed');
    } finally {
      delete process.env.ZELARI_KRAKEN_SELECTION;
    }
  });
});

describe('kraken_select gating (ADR-0020 Fase 4)', () => {
  it('absent by default (flag off → registry unchanged)', () => {
    const { tools } = makeRegistry();
    expect(tools.find((t) => t.name === 'kraken_select')).toBeUndefined();
  });

  it('registered on the parent full registry when krakenSelect=true', () => {
    const { tools, registry } = makeRegistry({ krakenSelect: true });
    const summary = tools.find((t) => t.name === 'kraken_select');
    expect(summary).toBeDefined();
    expect(summary?.permissions).toContain('read');
    expect(registry.get('kraken_select')).toBeDefined();
  });

  it('stays available in PLAN mode (selection is plan-safe)', () => {
    const { tools } = makeRegistry({ krakenSelect: true, planMode: true });
    expect(tools.find((t) => t.name === 'kraken_select')).toBeDefined();
  });

  it('NEVER registered on read-only sub-agent profiles (tentacles)', () => {
    const { tools, registry } = makeRegistry({ krakenSelect: true, readOnly: true });
    expect(tools.find((t) => t.name === 'kraken_select')).toBeUndefined();
    expect(registry.get('kraken_select')).toBeUndefined();
  });

  it('execute is safe without deps wiring (no candidates → typedOk no-op)', async () => {
    resetKrakenCandidates();
    const { registry } = makeRegistry({ krakenSelect: true });
    const tool = registry.get('kraken_select');
    expect(tool).toBeDefined();
    const res = await tool!.execute({} as never, makeCtx());
    expect(res.ok).toBe(true);
  });
});
