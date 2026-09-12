/**
 * Per-tentacle thinking effort (ADR-0017) — CLI slice.
 *
 * Chain: per-spawn `task` `thinkingEffort` arg > per-kind env
 * (`ZELARI_KRAKEN_EXPLORE|GENERAL|VERIFY_THINKING`) > inherited
 * `thinkingByProvider[provider]` (unchanged default). Also: headless option →
 * env mapping, and the `agent_spawned` payload the Desktop reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const providerFromEnvMock = vi.fn();
const buildProviderStreamMock = vi.fn((_cfg: Record<string, unknown>) => async function* () {});

vi.mock('../../src/cli/provider/openai-compatible.js', () => ({
  providerFromEnv: (...args: unknown[]) => providerFromEnvMock(...args),
  providerConfigFor: vi.fn(),
  openaiCompatibleProvider: vi.fn(() => async function* () {}),
}));

// Capture the provider config each tentacle stream is built from: that is where
// the resolved thinking spec must land (subCfg.thinking).
vi.mock('../../src/cli/provider/resolveStream.js', () => ({
  buildProviderStream: (cfg: Record<string, unknown>) => buildProviderStreamMock(cfg),
}));

vi.mock('../../src/cli/tools/krakenModel.js', () => ({
  resolveKrakenSubModel: vi.fn((_agent: string, parentModel: string) => parentModel),
  resolveKrakenSubModelAsync: vi.fn(async (_agent: string, parentModel: string) => parentModel),
  parseQualifiedModelRef: () => null,
}));

import { createKrakenSubAgentContextFactory } from '../../src/cli/toolRegistry.js';
import { AuditLogger } from '../../src/cli/safety/auditLogger.js';
import { applyKrakenTurnEnv } from '../../src/cli/runHeadless.js';
import type { HeadlessOptions } from '../../src/cli/headless.js';
import {
  createTaskTool,
  resetTaskSpawnCount,
  type SubAgentContext,
  type TaskAgentKind,
  type TaskToolDeps,
} from '../../src/cli/tools/taskTool.js';
import type { BrainAgentSpawnedEvent, BrainEvent } from '@zelari/core/shared/events';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

const THINKING_ENV_KEYS = [
  'ZELARI_KRAKEN_EXPLORE_THINKING',
  'ZELARI_KRAKEN_GENERAL_THINKING',
  'ZELARI_KRAKEN_VERIFY_THINKING',
] as const;
type SavedEnv = Array<[string, string | undefined]>;

/** Clear the three keys for the test, returning what to restore afterwards. */
function pinThinkingEnv(): SavedEnv {
  const saved = THINKING_ENV_KEYS.map((k) => [k, process.env[k]] as [string, string | undefined]);
  for (const key of THINKING_ENV_KEYS) delete process.env[key];
  return saved;
}

function restoreThinkingEnv(saved: SavedEnv): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Provider config shaped as the real providerFromEnv()/providerConfigFor(). */
const providerConfig = (thinking: unknown) => ({
  apiKey: 'k',
  baseUrl: 'https://x',
  model: 'parent-model',
  providerId: 'grok',
  thinking,
});

/** Config of the LAST provider stream built (the tentacle's own stream). */
function lastStreamConfig(): Record<string, unknown> {
  const calls = buildProviderStreamMock.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][0] : {};
}

const spawnedOf = (events: BrainEvent[]): BrainAgentSpawnedEvent | undefined =>
  events.find((e) => e.type === 'agent_spawned') as BrainAgentSpawnedEvent | undefined;

/** Scripted harness: one user-visible final message, no tool calls. */
const scriptedHarness: TaskToolDeps['harnessFactory'] = () => ({
  async *run() {
    yield { type: 'message_start' } as BrainEvent;
    yield { type: 'message_delta', delta: 'done' } as BrainEvent;
    yield { type: 'message_end' } as BrainEvent;
  },
});

describe('per-tentacle thinking effort — resolution chain', () => {
  let savedEnv: SavedEnv;
  let cwd: string;

  const ctxFor = (agent: TaskAgentKind, thinkingEffort?: string) =>
    createKrakenSubAgentContextFactory({
      root: process.cwd(),
      audit: new AuditLogger(),
      sessionId: 'test',
    })({ agent, thoroughness: 'medium', cwd, ...(thinkingEffort ? { thinkingEffort } : {}) });

  beforeEach(() => {
    providerFromEnvMock.mockReset();
    buildProviderStreamMock.mockClear();
    savedEnv = pinThinkingEnv();
    cwd = mkdtempSync(path.join(tmpdir(), 'zelari-thinking-'));
  });

  afterEach(() => {
    restoreThinkingEnv(savedEnv);
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('(i) task arg overrides the inherited provider thinking spec', async () => {
    providerFromEnvMock.mockResolvedValue(providerConfig({ kind: 'effort', effort: 'low' }));

    const ctx = await ctxFor('explore', 'high');

    expect(ctx?.thinking).toBe('high');
    expect(lastStreamConfig().thinking).toEqual({ kind: 'effort', effort: 'high' });
  });

  it("(ii) task arg 'inherit' defers to the per-kind env", async () => {
    providerFromEnvMock.mockResolvedValue(providerConfig({ kind: 'effort', effort: 'low' }));
    process.env.ZELARI_KRAKEN_EXPLORE_THINKING = 'medium';

    const ctx = await ctxFor('explore', 'inherit');

    expect(ctx?.thinking).toBe('medium');
    expect(lastStreamConfig().thinking).toEqual({ kind: 'effort', effort: 'medium' });
  });

  it('(iii) kind env wins over the inherited spec; no arg + no env inherits it', async () => {
    providerFromEnvMock.mockResolvedValue(providerConfig({ kind: 'effort', effort: 'low' }));

    // No env, no arg → provider spec (the previous behavior, unchanged).
    const inherited = await ctxFor('verify');
    expect(inherited?.thinking).toBe('low');

    // budget:<n> is env-only (kept out of the `task` arg enum by design).
    process.env.ZELARI_KRAKEN_VERIFY_THINKING = 'budget:8000';
    const overridden = await ctxFor('verify');
    expect(overridden?.thinking).toBe('budget:8000');
    expect(lastStreamConfig().thinking).toEqual({ kind: 'budget', budgetTokens: 8000 });
  });

  it('(iv) invalid env value falls back to the provider spec and still spawns', async () => {
    providerFromEnvMock.mockResolvedValue(providerConfig({ kind: 'effort', effort: 'max' }));
    process.env.ZELARI_KRAKEN_GENERAL_THINKING = 'ludicrous-speed';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ctx = await ctxFor('general');

    expect(ctx).not.toBeNull();
    expect(ctx?.thinking).toBe('max');
    expect(lastStreamConfig().thinking).toEqual({ kind: 'effort', effort: 'max' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ludicrous-speed');
  });

  it('(iv-b) an invalid ARG does not fall through to the env (arg stays authoritative)', async () => {
    providerFromEnvMock.mockResolvedValue(providerConfig({ kind: 'effort', effort: 'low' }));
    process.env.ZELARI_KRAKEN_EXPLORE_THINKING = 'max';
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ctx = await ctxFor('explore', 'turbo');

    expect(ctx?.thinking).toBe('low');
  });
});

describe('per-tentacle thinking effort — headless option → env mapping', () => {
  const base: HeadlessOptions = {
    task: 'x',
    output: 'plain',
    mode: 'kraken',
    phase: 'build',
    useCouncil: false,
  };
  let savedEnv: SavedEnv;

  beforeEach(() => {
    savedEnv = pinThinkingEnv();
  });
  afterEach(() => restoreThinkingEnv(savedEnv));

  it('(v) maps the three thinking fields and never writes blank ones', () => {
    process.env.ZELARI_KRAKEN_GENERAL_THINKING = 'off';

    applyKrakenTurnEnv({
      ...base,
      krakenExploreThinking: 'high',
      krakenGeneralThinking: '   ',
      krakenVerifyThinking: 'budget:4000',
    });

    expect(process.env.ZELARI_KRAKEN_EXPLORE_THINKING).toBe('high');
    expect(process.env.ZELARI_KRAKEN_VERIFY_THINKING).toBe('budget:4000');
    // Blank means "leave it alone" — a pre-set value survives untouched.
    expect(process.env.ZELARI_KRAKEN_GENERAL_THINKING).toBe('off');
  });
});

describe('per-tentacle thinking effort — agent_spawned payload', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'zelari-thinking-spawn-'));
    resetTaskSpawnCount();
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const toolCtx = (): ToolContext => ({
    signal: new AbortController().signal,
    cwd,
    audit: () => {},
    sessionId: 'test',
  });

  // Minimal non-null context (unused by the scripted harness).
  const dummyContext: SubAgentContext = {
    providerStream: (async function* () {})() as never,
    model: 'm',
    provider: 'openai-compatible',
    registry: {} as never,
    tools: [],
  };

  /** Deps capturing activity events; `factory` decides the reported spec. */
  const probeDeps = (
    events: BrainEvent[],
    factory: TaskToolDeps['createSubAgentContext'],
  ): TaskToolDeps => ({
    onTentacleEvent: (ev) => events.push(ev),
    allowWorktree: false,
    createSubAgentContext: factory,
    harnessFactory: scriptedHarness,
  });

  const runProbe = (deps: TaskToolDeps, thinkingEffort: string) =>
    createTaskTool(deps).execute(
      { description: 'probe', prompt: 'do it', agent: 'explore', thinkingEffort },
      toolCtx(),
    );

  it('(vi) carries the thinking spec reported by the context factory', async () => {
    const events: BrainEvent[] = [];
    let seenArg: string | undefined;
    const deps = probeDeps(events, async ({ thinkingEffort }) => {
      seenArg = thinkingEffort;
      return { ...dummyContext, thinking: 'xhigh' };
    });

    const res = await runProbe(deps, 'xhigh');

    expect(res.ok).toBe(true);
    // The arg reaches the createSubAgentContext seam (where env/inherit resolve).
    expect(seenArg).toBe('xhigh');
    expect(spawnedOf(events)?.thinking).toBe('xhigh');
  });

  it('(vi-b) falls back to the arg when a custom factory reports no spec, else omits it', async () => {
    const explicit: BrainEvent[] = [];
    await runProbe(probeDeps(explicit, async () => dummyContext), 'low');
    expect(spawnedOf(explicit)?.thinking).toBe('low');

    const silent: BrainEvent[] = [];
    await runProbe(probeDeps(silent, async () => dummyContext), 'inherit');
    const spawned = spawnedOf(silent);
    expect(spawned).toBeDefined();
    expect('thinking' in (spawned as object)).toBe(false);
  });

  it('accepts the enum values but rejects budget:<n> on the task arg', () => {
    const tool = createTaskTool({ createSubAgentContext: async () => null });
    for (const value of ['inherit', 'auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const parsed = tool.inputSchema.safeParse({ description: 'x', prompt: 'p', thinkingEffort: value });
      expect(parsed.success).toBe(true);
    }
    expect(
      tool.inputSchema.safeParse({ description: 'x', prompt: 'p', thinkingEffort: 'budget:4000' })
        .success,
    ).toBe(false);
    expect(tool.inputSchema.safeParse({ description: 'x', prompt: 'p' }).success).toBe(true);
  });
});
