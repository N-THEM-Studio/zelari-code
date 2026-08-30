/**
 * HarnessState increment 1 — typed read-model + Turn Completion Contract.
 *
 * Unit side: synthetic envelopes (replay.test.ts fixture idiom) pin the
 * derivation and the ADR-0023 contract rules (unknown ≠ pass).
 * Integration side: the graph-path spine idiom from krakenGraphSpine.test.ts
 * (planner/executor stubbed, spine REAL) — after the run, readHarnessState on
 * the produced session dir must report a completed session whose first turn
 * carries the graph goal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import type { SessionActor, SessionEventEnvelope } from '@zelari/core/session';
import { deriveHarnessState, readHarnessState } from './harnessState.js';

// Same LLM-seam stubs as the W1 spine test (krakenGraphSpine.test.ts); the
// spine itself is REAL. Hoisted to file top — vi.mock executes before tests.
vi.mock('./kraken/planner.js', () => ({
  planTaskGraph: async () => ({ id: 'graph-hs', nodes: new Map() }),
}));
vi.mock('./kraken/graphStatus.js', () => ({
  formatKrakenGraphAscii: () => 'ascii',
  formatKrakenGraphDigest: () => 'digest',
}));
vi.mock('./kraken/executor.js', () => ({
  isKrakenGraphEnabled: (env: NodeJS.ProcessEnv = process.env) => env.ZELARI_KRAKEN_GRAPH !== '0',
  KrakenGraphExecutor: class {
    constructor(_opts: { signal?: AbortSignal }) {}
    async execute() {
      return {
        converged: true,
        cancelled: false,
        graph: { id: 'graph-hs', nodes: new Map() },
        durationsMs: {},
        unresolvedFindings: [],
      };
    }
  },
}));

let seq = 0;
function ev(
  kind: SessionEventEnvelope['kind'],
  data: Record<string, unknown> = {},
  actor: SessionActor = { type: 'system' },
): SessionEventEnvelope {
  seq += 1;
  return { schemaVersion: 1, sessionId: 's-harness', seq, ts: 1755000000000 + seq, kind, actor, data };
}

describe('deriveHarnessState — turn windowing', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('empty events → zero turns, session pending', () => {
    const state = deriveHarnessState([]);
    expect(state.session.status).toBe('pending');
    expect(state.session.lastSeq).toBe(0);
    expect(state.turns).toEqual([]);
    expect(state.execution).toEqual({ turnsTotal: 0, contracts: [] });
  });

  it('happy turn (user + assistant + settled tool) → complete:true, outcome completed', () => {
    const state = deriveHarnessState([
      ev('session.started', { manifestHash: 'h1' }),
      ev('user.message', { text: 'fix the bug' }, { type: 'user' }),
      ev('assistant.message', { text: 'on it' }, { type: 'agent' }),
      ev('tool.call', { callId: 'c1', tool: 'bash', args: { command: 'npm test' } }, { type: 'agent' }),
      ev('tool.result', { callId: 'c1', tool: 'bash', ok: true, output: 'ok' }, { type: 'tool' }),
      ev('session.ended', { reason: 'completed' }),
    ]);
    expect(state.session.status).toBe('completed');
    expect(state.execution.turnsTotal).toBe(1);
    const turn = state.turns[0]!;
    expect(turn.userText).toBe('fix the bug');
    expect(turn.assistantChars).toBe(5);
    expect(turn.toolCalls).toBe(1);
    expect(turn.toolKinds).toEqual(['bash']);
    expect(turn.outcome).toBe('completed');
    const contract = state.execution.contracts[0]!;
    expect(contract.complete).toBe(true);
    expect(contract.blockers).toEqual([]);
    expect(contract.signals).toMatchObject({ userMessage: true, assistantReply: true, toolsSettled: true });
  });

  it('pre-message events before the first user.message open NO turn', () => {
    const state = deriveHarnessState([
      ev('session.started'),
      ev('session.harness_manifest', { manifestHash: 'h1' }),
      ev('note', { text: 'pre-turn note' }),
      ev('user.message', { text: 'go' }, { type: 'user' }),
    ]);
    expect(state.execution.turnsTotal).toBe(1);
    expect(state.turns[0]!.userText).toBe('go');
    expect(state.turns[0]!.outcome).toBe('pending');
  });

  it('two turns: closed one is completed, unclosed one stays pending', () => {
    const state = deriveHarnessState([
      ev('user.message', { text: 'first' }, { type: 'user' }),
      ev('assistant.message', { text: 'done' }, { type: 'agent' }),
      ev('user.message', { text: 'second' }, { type: 'user' }),
    ]);
    expect(state.execution.turnsTotal).toBe(2);
    expect(state.turns[0]!.outcome).toBe('completed');
    expect(state.turns[0]!.userText).toBe('first');
    expect(state.turns[1]!.outcome).toBe('pending');
    expect(state.execution.contracts[1]!.blockers).toContain('turn-pending');
    expect(state.execution.contracts[1]!.complete).toBe(false);
  });
});

describe('deriveHarnessState — Turn Completion Contract (ADR-0023: unknown ≠ pass)', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('interrupted turn (user but NO assistant) → blocker assistant-reply-missing', () => {
    const state = deriveHarnessState([
      ev('user.message', { text: 'interrupted' }, { type: 'user' }),
      ev('session.ended', { reason: 'completed' }),
    ]);
    const contract = state.execution.contracts[0]!;
    expect(contract.complete).toBe(false);
    expect(contract.signals.assistantReply).toBe(false);
    expect(contract.blockers).toContain('assistant-reply-missing');
  });

  it('unsettled tool call → blocker tools-unsettled', () => {
    const state = deriveHarnessState([
      ev('user.message', { text: 'dangling tool' }, { type: 'user' }),
      ev('assistant.message', { text: 'running…' }, { type: 'agent' }),
      ev('tool.call', { callId: 'c1', tool: 'write_file' }, { type: 'agent' }),
      ev('session.ended', { reason: 'completed' }),
    ]);
    const contract = state.execution.contracts[0]!;
    expect(contract.signals.toolsSettled).toBe(false);
    expect(contract.blockers).toContain('tools-unsettled');
    expect(contract.complete).toBe(false);
  });

  it('strict BLOCKED verdict → not complete, blocker names the verdict', () => {
    const state = deriveHarnessState([
      ev('user.message', { text: 'strict gate' }, { type: 'user' }),
      ev('assistant.message', { text: 'did it' }, { type: 'agent' }),
      ev('tool.call', { callId: 'c1', tool: 'bash' }, { type: 'agent' }),
      ev('tool.result', { callId: 'c1', ok: true }, { type: 'tool' }),
      ev('verification.run', {
        engine: 'kraken-legacy+completion-policy',
        strict: true,
        verdict: 'BLOCKED',
        summary: 'blocked (strict BLOCKED)',
      }),
      ev('session.ended', { reason: 'completed' }),
    ]);
    const contract = state.execution.contracts[0]!;
    expect(contract.signals.verification).toEqual({ strict: true, verdict: 'BLOCKED' });
    expect(contract.complete).toBe(false);
    expect(contract.blockers).toContain('verification-verdict-BLOCKED');
  });

  it('strict PASS verdict → complete despite no other evidence gap', () => {
    const state = deriveHarnessState([
      ev('user.message', { text: 'strict pass' }, { type: 'user' }),
      ev('assistant.message', { text: 'did it' }, { type: 'agent' }),
      ev('verification.run', { strict: true, verdict: 'PASS' }),
      ev('session.ended', { reason: 'completed' }),
    ]);
    expect(state.execution.contracts[0]!.complete).toBe(true);
  });

  it('non-strict verification.run is NOT admissible (unknown ≠ pass)', () => {
    const state = deriveHarnessState([
      ev('user.message', { text: 'loose gate' }, { type: 'user' }),
      ev('assistant.message', { text: 'did it' }, { type: 'agent' }),
      ev('verification.run', { strict: false, verdict: 'PASS' }),
      ev('session.ended', { reason: 'completed' }),
    ]);
    const contract = state.execution.contracts[0]!;
    expect(contract.complete).toBe(false);
    expect(contract.blockers).toContain('verification-not-strict');
  });

  it('evidence-less completed turn has NO verification signal and no gate blocker', () => {
    const state = deriveHarnessState([
      ev('user.message', { text: 'no gate ran' }, { type: 'user' }),
      ev('assistant.message', { text: 'answer' }, { type: 'agent' }),
      ev('session.ended', { reason: 'completed' }),
    ]);
    const contract = state.execution.contracts[0]!;
    expect(contract.signals.verification).toBeUndefined();
    expect(state.turns[0]!.verification).toBeUndefined();
    // verification absent + clean close + all signals → complete allowed
    expect(contract.complete).toBe(true);
  });

  it('LAST verification.run in a turn wins', () => {
    const state = deriveHarnessState([
      ev('user.message', { text: 'retry gate' }, { type: 'user' }),
      ev('assistant.message', { text: 'fixing' }, { type: 'agent' }),
      ev('verification.run', { strict: true, verdict: 'BLOCKED' }),
      ev('assistant.message', { text: 'repaired' }, { type: 'agent' }),
      ev('verification.run', { strict: true, verdict: 'PASS' }),
      ev('session.ended', { reason: 'completed' }),
    ]);
    expect(state.execution.contracts[0]!.signals.verification).toEqual({ strict: true, verdict: 'PASS' });
    expect(state.execution.contracts[0]!.complete).toBe(true);
  });

  it('turn closed by a cancelled session.ended → outcome error, blocker names the reason', () => {
    const state = deriveHarnessState([
      ev('user.message', { text: 'cancelled work' }, { type: 'user' }),
      ev('assistant.message', { text: 'partial' }, { type: 'agent' }),
      ev('session.ended', { reason: 'cancelled' }),
    ]);
    expect(state.session.status).toBe('cancelled');
    expect(state.turns[0]!.outcome).toBe('error');
    const contract = state.execution.contracts[0]!;
    expect(contract.complete).toBe(false);
    expect(contract.blockers).toContain('turn-error-cancelled');
  });
});

describe('deriveHarnessState — SupportLens + tolerance', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('context.projection + memory_event notes and session.compacted land in SupportLens', () => {
    const state = deriveHarnessState([
      ev('note', { subject: 'context.projection', contextChars: 1234, returnedCount: 3, durationMs: 12 }),
      ev('note', { subject: 'memory_event', type: 'memory_recall_start' }),
      ev('note', { subject: 'memory_event', type: 'memory_recall_end' }),
      ev('session.compacted', { fromSeq: 1, toSeq: 2, checkpoint: { role: 'system', content: 'C1' } }),
      ev('session.compacted', { tokensSaved: 40 }),
      ev('user.message', { text: 'go' }, { type: 'user' }),
    ]);
    expect(state.support.contextProjections).toEqual([{ contextChars: 1234, returnedCount: 3, durationMs: 12 }]);
    expect(state.support.memoryEvents).toBe(2);
    expect(state.support.compactions).toBe(2);
    expect(state.support.tokensSavedByCompaction).toBe(40);
  });

  it('context.projection budget-side fields are preserved; malformed notes fall back to defaults', () => {
    const state = deriveHarnessState([
      ev('note', {
        subject: 'context.projection',
        contextChars: 4096,
        returnedCount: 7,
        occupancy: 0.42,
        estimatedHistoryTokens: 900,
        contextLimit: 200000,
        contextPressureTokens: 1234,
        durationMs: 5,
        backend: 'miroir',
        policy: 'warn',
      }),
      ev('note', { subject: 'context.projection' }),
      ev('note', { subject: 'context.projection', contextChars: 'junk', policy: 'bogus' }),
    ]);
    expect(state.support.contextProjections).toEqual([
      {
        contextChars: 4096,
        returnedCount: 7,
        occupancy: 0.42,
        estimatedHistoryTokens: 900,
        contextLimit: 200000,
        contextPressureTokens: 1234,
        durationMs: 5,
        backend: 'miroir',
        policy: 'warn',
      },
      { contextChars: 0, returnedCount: 0 },
      { contextChars: 0, returnedCount: 0 },
    ]);
  });

  it('unknown/retired kinds are ignored (post-W5 vocabulary tolerance)', () => {
    const base = [
      ev('user.message', { text: 't' }, { type: 'user' }),
      ev('assistant.message', { text: 'a' }, { type: 'agent' }),
      ev('session.ended', { reason: 'completed' }),
    ];
    const withLegacy = deriveHarnessState([
      ...base,
      ev('kraken.task' as SessionEventEnvelope['kind'], { junk: true }),
      ev('context.injected' as SessionEventEnvelope['kind'], { junk: true }),
    ]);
    const without = deriveHarnessState(base);
    expect(withLegacy.execution).toEqual(without.execution);
    expect(withLegacy.support).toEqual(without.support);
    expect(withLegacy.execution.contracts[0]!.complete).toBe(true);
  });
});

describe('readHarnessState — real spine (kraken-graph idiom, krakenGraphSpine.test.ts)', () => {
  const GOAL = 'harness-state probe: add one function to src/util.ts';

  const ENV_KEYS = ['ZELARI_KRAKEN_GRAPH', 'ZELARI_SESSIONS_DIR', 'ZELARI_MEMORY'] as const;
  let tmp: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zelari-harness-state-'));
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.ZELARI_KRAKEN_GRAPH; // engine enabled (default)
    delete process.env.ZELARI_SESSIONS_DIR; // sessions land under <workspace>/.zelari/sessions
    process.env.ZELARI_MEMORY = '0';
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  /** Capture (and swallow) stdout+stderr while the run emits NDJSON. */
  async function captureOutput<T>(fn: () => Promise<T>): Promise<T> {
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = (): boolean => true;
    process.stderr.write = (): boolean => true;
    try {
      return await fn();
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
  }

  it('derives a completed HarnessState from the on-disk session dir', async () => {
    const unreachableStream = (() => {
      throw new Error('provider stream must not be reached by the kraken-graph path');
    }) as unknown as ProviderStreamFn;
    const { dispatchHeadlessTurn } = await import('./runHeadless.js');
    const code = await captureOutput(() =>
      dispatchHeadlessTurn(
        {
          task: GOAL,
          krakenGraph: GOAL,
          mode: 'kraken',
          phase: 'build',
          output: 'json',
          useCouncil: false,
          cwd: tmp,
        },
        'hs-provider',
        'hs-fake-model',
        unreachableStream,
        { policyGateDone: true },
      ),
    );
    expect(code).toBe(0);

    const sessions = path.join(tmp, '.zelari', 'sessions');
    const ids = fs.readdirSync(sessions);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const state = await readHarnessState(path.join(sessions, ids[0]!));

    expect(state.session.status).toBe('completed');
    expect(state.execution.turnsTotal).toBeGreaterThanOrEqual(1);
    expect(state.turns[0]!.userText).toBe(GOAL);
    expect(state.turns[0]!.outcome).toBe('completed');
  }, 30_000);
});
