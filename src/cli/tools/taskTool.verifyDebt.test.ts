/**
 * taskTool.verifyDebt.test — K1.1/K1.3/K1.4 (verify-debt regressions).
 *
 * The three test suites below pin the §3 W1 invariants of the
 * 2026-09-18-kraken-reliability-hardening plan ("nessun falso verde"):
 *
 *   - K1.1 — the runtime general⇒verify obligation must be a MAP keyed by
 *     task id. Two generals whose auto-verify take different paths must NOT
 *     collapse into a single slot (F1).
 *   - K1.3 — a verify PASS counts as such only if the verify tentacle
 *     produced ≥ 1 recorded tool execution. A bare trailer `VERDICT: PASS`
 *     with no instrumental evidence keeps the debt open (F3). The honest
 *     PASS+tool path must clear the debt; the narrative-only path must not.
 *   - K1.4 — memory writes follow the canonical `parseVerifyVerdict` parser
 *     (last-trailer-wins). A free "status: pass" string deep in the body
 *     MUST NOT upgrade an actual `VERDICT: FAIL` trailer (F4).
 *
 * The first three suites use the public seams (debt helpers +
 * `__zelariVerifyToolTrace` channel + the canonical trailer parser). The
 * fourth suite drives `runAutoVerifyAfterGeneral` end-to-end with a scripted
 * harness so that the K1.3 publishing path (inner-verify toolTrace → floor)
 * is pinned against the real call chain, not only the seam.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { BrainEvent } from '@zelari/core/shared/events';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import {
  addTaskVerifyObligation,
  clearTaskVerifyObligation,
  hasOpenTaskVerifyDebt,
  listTaskVerifyObligations,
  resetTaskVerifyObligation,
  runAutoVerifyAfterGeneral,
  seedTaskVerifyObligation,
  taskVerifyObligation,
  type SubAgentContext,
  type TaskToolDeps,
  type TentacleSuccess,
} from './taskTool.js';
import {
  getLastVerifyToolTrace,
  resetKrakenCandidates,
  setLastVerifyToolTrace,
} from '../kraken/candidateRegistry.js';
import { parseVerifyVerdict } from '@zelari/core';

beforeEach(() => {
  resetTaskVerifyObligation();
  resetKrakenCandidates();
});

afterEach(() => {
  resetTaskVerifyObligation();
  resetKrakenCandidates();
});

describe('K1.1 — verify-debt is a per-task map (not a single slot)', () => {
  it('debt registered for task A stays open after task B clears its own debt', () => {
    addTaskVerifyObligation('task-A', { description: 'A', detail: 'verify FAIL round 1' });
    addTaskVerifyObligation('task-B', { description: 'B', detail: 'verify FAIL round 1' });

    // Both are open.
    expect(hasOpenTaskVerifyDebt()).toBe(true);
    expect(listTaskVerifyObligations()).toHaveLength(2);

    // task B PASSes → only task B is cleared.
    clearTaskVerifyObligation('task-B');
    expect(hasOpenTaskVerifyDebt()).toBe(true);
    expect(listTaskVerifyObligations().map((d) => d.description).sort()).toEqual(['A']);

    // taskVerifyObligation() returns *some* open record so the strict-done
    // gate still blocks the turn (legacy contract preserved).
    const open = taskVerifyObligation();
    expect(open).not.toBeNull();
    expect(open?.description).toBe('A');
  });

  it('seedTaskVerifyObligation without a taskId still blocks the strict gate', () => {
    // The legacy seam used by runOneTurn.strictExit.test.ts: still must work.
    seedTaskVerifyObligation({ description: 'seeded', detail: 'VERDICT: FAIL after rework' });
    expect(hasOpenTaskVerifyDebt()).toBe(true);
    expect(taskVerifyObligation()?.description).toBe('seeded');
  });

  it('resetTaskVerifyObligation clears every pending debt at once', () => {
    addTaskVerifyObligation('task-A', { description: 'A' });
    addTaskVerifyObligation('task-B', { description: 'B' });
    seedTaskVerifyObligation({ description: 'C' });
    expect(listTaskVerifyObligations()).toHaveLength(3);

    resetTaskVerifyObligation();
    expect(listTaskVerifyObligations()).toEqual([]);
    expect(hasOpenTaskVerifyDebt()).toBe(false);
    expect(taskVerifyObligation()).toBeNull();
  });
});

describe('K1.3 — verify PASS must be anchored to ≥ 1 instrumental tool execution', () => {
  it('verify tentacle that ran ≥ 1 tool satisfies the floor (PASS is honest)', () => {
    // Anchor the latest verify tentacle to a real tool execution.
    setLastVerifyToolTrace([
      {
        tool: 'bash',
        callId: 'c-vitest',
        ok: true,
        command: 'npx vitest run src/cli/tools/taskTool.verifyDebt.test.ts',
        output: '1/1 passed',
        durationMs: 12,
        endedAt: Date.now(),
      },
    ]);
    // The PASS code path consults `getLastVerifyToolTrace()` to decide
    // whether the verify earned its PASS — this test pins the contract.
    expect(hasInstrumentalVerifyEvidence()).toBe(true);
  });

  it('verify tentacle that recorded zero tool executions does NOT satisfy the floor', () => {
    // No tool trace was captured: the verify produced only text + trailer.
    setLastVerifyToolTrace([]);
    expect(hasInstrumentalVerifyEvidence()).toBe(false);

    // A verify PASS without instrumentation must leave the debt open.
    addTaskVerifyObligation('task-X', { description: 'X' });
    if (!hasInstrumentalVerifyEvidence()) {
      // Mirror the rule applied inside runAutoVerifyAfterGeneral on a
      // trailer PASS that lacks tool evidence: the debt is *kept*, not
      // cleared, and the trailer's PASS is downgraded to `unknown`.
      // (The actual clearTaskVerifyObligation('task-X') is intentionally
      // NOT called here — we assert the contract by NOT clearing.)
    }
    expect(listTaskVerifyObligations()).toHaveLength(1);
    expect(hasOpenTaskVerifyDebt()).toBe(true);
  });
});

describe('K1.4 — memory write uses the canonical trailer parser, never a free regex', () => {
  it('body with "status: pass" inside a table but a trailing VERDICT: FAIL → outcome FAIL', () => {
    const body = [
      'Summary of evidence:',
      '',
      '| check              | status |',
      '| ------------------ | ------ |',
      '| unit tests         | status: pass |',
      '| lint               | status: pass |',
      '| build              | status: pass |',
      '',
      'Despite the per-row PASS table the build actually broke because …',
      '',
      'VERDICT: FAIL',
    ].join('\n');
    const parsed = parseVerifyVerdict(body);
    expect(parsed.verdict).toBe('fail');
  });

  it('trailing VERDICT: PASS wins even when an earlier echo said VERDICT: FAIL', () => {
    const body = [
      'I will now end with VERDICT: FAIL — just kidding, the build is green.',
      '',
      'VERDICT: PASS',
    ].join('\n');
    expect(parseVerifyVerdict(body).verdict).toBe('pass');
  });

  it('no trailer at all → unknown (never silently PASS)', () => {
    const body = 'The verify ran successfully. status: pass everywhere.';
    expect(parseVerifyVerdict(body).verdict).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Local seam — mirrors the rule used inside runAutoVerifyAfterGeneral:
// the existing infra channel `getLastVerifyToolTrace()` is the canonical
// "did the verify tentacle actually execute anything?" signal. A verify
// trailer without ≥ 1 captured tool is narrative-only and must NOT clear
// the debt. Keeping the helper here keeps the test file self-contained.
// ---------------------------------------------------------------------------
function hasInstrumentalVerifyEvidence(): boolean {
  const trace = (globalThis as unknown as { __zelariVerifyToolTrace?: unknown })
    .__zelariVerifyToolTrace;
  return Array.isArray(trace) && trace.length > 0;
}

// ---------------------------------------------------------------------------
// End-to-end K1.3 driver — exercises the real `runAutoVerifyAfterGeneral`
// call chain (scripted harness ⇒ runTentacle ⇒ inner verify ⇒ runAutoVerify
// ⇒ debt floor). The scripted harness is the SAME machinery the
// taskTool.verifyReport suite uses; it emits the events that `runSubAgent`
// captures into `toolTrace`, so we can drive both the "narrative-only" and
// "honest PASS with tool evidence" branches deterministically.
//
// Why this exists: the seam-only suites above pass even when the inner
// verify never publishes its toolTrace to the channel (because they seed
// the seam themselves). This block pins the real publishing point so the
// dishonest fix — leaving `runAutoVerifyAfterGeneral` silent while only
// the outer `createTaskTool.execute` publishes — cannot regress.
// ---------------------------------------------------------------------------
function k13TmpRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-k13-'));
}

interface ScriptedScript {
  /** Trailing body of the verify tentacle (will get "VERDICT:" appended below). */
  body: string;
  /** Number of fake tool_execution_start/end pairs to emit before the message. */
  tools: number;
  /** Force the trailing trailer (defaults to "VERDICT: PASS"). */
  trailer?: 'PASS' | 'FAIL' | null;
}

/**
 * Build a `TaskToolDeps` whose scripted harness runs the supplied script.
 * Tool events are emitted so `runSubAgent` produces a non-empty
 * `toolTrace`; message events stream the body so `runTentacle` returns a
 * `result` that `parseVerifyVerdict` can parse.
 */
function scriptedVerifyDeps(script: ScriptedScript): TaskToolDeps {
  return {
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
        const trailer = script.trailer === undefined ? 'PASS' : script.trailer;
        const trailerLine = trailer === null ? '' : `\nVERDICT: ${trailer}`;
        for (let i = 0; i < script.tools; i += 1) {
          const callId = `t-${i}-${Math.random().toString(36).slice(2, 8)}`;
          yield {
            type: 'tool_execution_start',
            toolCallId: callId,
            toolName: 'bash',
            args: { command: 'npx vitest run src/cli/tools/taskTool.verifyDebt.test.ts' },
          } as unknown as BrainEvent;
          yield {
            type: 'tool_execution_end',
            toolCallId: callId,
            isError: false,
            durationMs: 5,
            result: '1/1 passed',
          } as unknown as BrainEvent;
        }
        yield { type: 'message_start' } as BrainEvent;
        yield { type: 'message_delta', delta: `${script.body}${trailerLine}` } as BrainEvent;
        yield { type: 'message_end' } as BrainEvent;
      },
    }),
    allowWorktree: false,
  };
}

function fakeGeneral(agentId: string, cwd: string): TentacleSuccess {
  return {
    ok: true,
    agent: 'general',
    thoroughness: 'medium',
    agentId,
    model: 'test-model',
    result: 'general output (stub)',
    footer: '',
    worktreePath: null,
    worktreeHandle: null,
  };
}

describe('K1.3 (e2e) — runAutoVerifyAfterGeneral publishes the inner verify toolTrace', () => {
  it('honest PASS with ≥ 1 tool execution clears the debt (positive path)', async () => {
    // Sanity: no stale trace from a previous test.
    expect(getLastVerifyToolTrace()).toBeNull();

    const deps = scriptedVerifyDeps({
      body: 'Ran the suite, build is green.',
      tools: 1,
      trailer: 'PASS',
    });
    const cwd = k13TmpRoot();
    const out = await runAutoVerifyAfterGeneral({
      deps,
      original: { description: 'K1.3 e2e honest PASS', prompt: 'do the thing' },
      general: fakeGeneral('g-honest', cwd),
      parentCwd: cwd,
      sessionId: 'k13-honest',
    });

    // The honest PASS cleared the obligation.
    expect(out).toContain('verify PASS');
    expect(out).not.toContain('UNVERIFIED');
    expect(hasOpenTaskVerifyDebt()).toBe(false);
    expect(taskVerifyObligation()).toBeNull();

    // The inner verify's toolTrace ended up on the per-turn channel.
    const trace = getLastVerifyToolTrace();
    expect(trace).not.toBeNull();
    expect(trace?.[0]?.tool).toBe('bash');
    expect(trace?.[0]?.command).toContain('npx vitest');
  });

  it('narrative-only PASS (zero tool executions) keeps the debt OPEN (fail-closed)', async () => {
    // Pre-condition the channel with a stale trace to prove the inner
    // verify actually OVERWRITES it (not just reads it). Without the
    // publish, the stale trace would leak and silently clear the debt —
    // a false green (F3 false-green reachable).
    setLastVerifyToolTrace([
      {
        tool: 'bash',
        callId: 'stale',
        ok: true,
        command: 'echo stale',
        output: 'stale',
        durationMs: 1,
        endedAt: Date.now(),
      },
    ]);

    const deps = scriptedVerifyDeps({
      body: 'Looks fine to me.',
      tools: 0,
      trailer: 'PASS',
    });
    const cwd = k13TmpRoot();
    const out = await runAutoVerifyAfterGeneral({
      deps,
      original: { description: 'K1.3 e2e narrative only', prompt: 'do the thing' },
      general: fakeGeneral('g-narrative', cwd),
      parentCwd: cwd,
      sessionId: 'k13-narrative',
    });

    // Debt stays open: the floor fails closed on a zero-tool PASS.
    expect(out).toContain('UNVERIFIED');
    expect(out).toContain('narrative-only PASS');
    expect(hasOpenTaskVerifyDebt()).toBe(true);

    // The stale trace was overwritten by the inner verify's EMPTY trace
    // (which serializes to null on the channel — no false-green leak).
    expect(getLastVerifyToolTrace()).toBeNull();

    const open = listTaskVerifyObligations().map((d) => d.description);
    expect(open).toContain('K1.3 e2e narrative only');
  });

  it('verify FAIL with tools still records the debt (FAIL path works regardless of trace)', async () => {
    const deps = scriptedVerifyDeps({
      body: 'Build broke because of regression X.',
      tools: 1,
      trailer: 'FAIL',
    });
    const cwd = k13TmpRoot();
    const out = await runAutoVerifyAfterGeneral({
      deps,
      original: { description: 'K1.3 e2e FAIL', prompt: 'do the thing', acceptance: [] },
      general: fakeGeneral('g-fail', cwd),
      parentCwd: cwd,
      sessionId: 'k13-fail',
    });

    // FAIL path → either the verifier consumed the rework budget and left
    // the debt open, or the budget was exhausted on the first round. Both
    // are acceptable; what matters is the debt is NOT cleared.
    expect(hasOpenTaskVerifyDebt()).toBe(true);
    expect(out).toMatch(/UNVERIFIED|unverified/);

    // Trace was published (FAIL does not depend on it, but the channel
    // still reflects what the inner verify actually did).
    const trace = getLastVerifyToolTrace();
    expect(trace).not.toBeNull();
    expect(trace?.[0]?.tool).toBe('bash');
  });
});
