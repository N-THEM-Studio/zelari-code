/**
 * taskTool.tentacleContract.test — P1 of the 2026-09-21 tentacle plan.
 *
 *   - t153 (P1a): the three kind prompts live in ./taskPrompts.ts and the
 *     GENERAL prompt (the only kind that modifies the repo) carries the
 *     edit-integrity + return-format contract within a size bound.
 *   - t154 (P1b): buildTaskAutoVerifyPrompt COMPOSES the two output formats
 *     (system-prompt <verify-report> blocks + task-prompt VERDICT trailer)
 *     instead of issuing two conflicting "final line" instructions. A
 *     simulated composed message must still satisfy the verdict parser.
 *   - t155 (P1c): the auto-spawned inner verify INHERITS the parent
 *     general's thoroughness instead of hardcoded 'medium'.
 *   - t157 (P2c): a tentacle that re-emits the same assistant message turn
 *     after turn is stopped by the loop guard, and the PARENT sees that stop
 *     (`task` tool result) instead of a silent budget exhaustion; repeated
 *     tool calls with distinct prose stay legitimate.
 *   - t160 (P3): every kind prompt opens with an ENVIRONMENT line advertising
 *     the sandbox it really gets (explore read-only, general worktree +
 *     parent squash-merge, verify network only as tooling). These assertions
 *     pin the advertise to the REAL permission map so text and runtime cannot
 *     drift apart.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { BrainEvent } from '@zelari/core/shared/events';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import { parseVerifyVerdict } from '@zelari/core';
import {
  buildTaskAutoVerifyPrompt,
  permissionsForTaskAgent,
  resetTaskVerifyObligation,
  runAutoVerifyAfterGeneral,
  runTentacle,
  type SubAgentContext,
  type TaskToolDeps,
  type TentacleSuccess,
} from './taskTool.js';
import { parseVerifyReport } from '../kraken/verifyReport.js';
import { EXPLORE_PROMPT, GENERAL_PROMPT, VERIFY_PROMPT } from './taskPrompts.js';

beforeEach(() => {
  resetTaskVerifyObligation();
});

afterEach(() => {
  resetTaskVerifyObligation();
});

describe('t153 — taskPrompts module (P1a)', () => {
  it('exports the three kind prompts as non-empty strings', () => {
    for (const p of [EXPLORE_PROMPT, GENERAL_PROMPT, VERIFY_PROMPT]) {
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(200);
    }
  });

  it('GENERAL carries the EDIT INTEGRITY contract (read-before-write, anchored edits)', () => {
    expect(GENERAL_PROMPT).toContain('EDIT INTEGRITY');
    expect(GENERAL_PROMPT).toContain('BEFORE editing');
    expect(GENERAL_PROMPT).toContain('old-to-new replacement');
    expect(GENERAL_PROMPT).toContain('stale anchor');
  });

  it('GENERAL mandates the RETURN FORMAT (changed / files / checks / risks)', () => {
    expect(GENERAL_PROMPT).toContain('RETURN FORMAT');
    expect(GENERAL_PROMPT).toContain('What changed');
    expect(GENERAL_PROMPT).toContain('Files touched');
    expect(GENERAL_PROMPT).toContain('Checks:');
    expect(GENERAL_PROMPT).toContain('Risks/follow-ups');
  });

  it('GENERAL keeps the hard fences (no nested agents, scope, worktree) and the bound', () => {
    expect(GENERAL_PROMPT).toContain('Do not spawn further sub-agents');
    expect(GENERAL_PROMPT).toContain('Scope paths');
    expect(GENERAL_PROMPT).toContain('git worktree');
    // Plan bound: serious but bounded (~1800 chars max).
    expect(GENERAL_PROMPT.length).toBeGreaterThan(800);
    expect(GENERAL_PROMPT.length).toBeLessThan(1800);
  });

  it('EXPLORE stays read-only with observation integrity; VERIFY keeps the report shape', () => {
    expect(EXPLORE_PROMPT).toContain('READ-ONLY');
    expect(EXPLORE_PROMPT).toContain('OBSERVATION INTEGRITY');
    expect(VERIFY_PROMPT).toContain('<verify-report>');
    expect(VERIFY_PROMPT).toContain('status: pass | fail | unknown');
  });
});

describe('t160 — per-kind ENVIRONMENT advertise (P3)', () => {
  it('every kind declares the sandbox it actually gets', () => {
    for (const p of [EXPLORE_PROMPT, GENERAL_PROMPT, VERIFY_PROMPT]) {
      expect(p).toContain('ENVIRONMENT');
    }
    // One line per kind, mirroring the toolRegistry profile split:
    // explore = observe only, verify = observe + bash, general = + mutators.
    expect(EXPLORE_PROMPT).toContain('ENVIRONMENT (read-only)');
    expect(VERIFY_PROMPT).toContain('ENVIRONMENT: read + shell + network');
    expect(GENERAL_PROMPT).toContain('ENVIRONMENT: write + shell + network');
  });

  it('explore advertises no write/shell and no illusion of running the checks', () => {
    expect(EXPLORE_PROMPT).toContain('you have no write and no shell');
    expect(EXPLORE_PROMPT).toContain('install packages or run tests');
    // Negative advertise: explore can neither commit nor verify by executing —
    // it has no write and no bash tool (toolRegistry profile 'explore').
    expect(EXPLORE_PROMPT).not.toContain('commit');
    expect(EXPLORE_PROMPT).not.toContain('squash-merge');
  });

  it('general advertises the worktree branch + parent squash-merge contract', () => {
    expect(GENERAL_PROMPT).toContain('isolated git worktree');
    expect(GENERAL_PROMPT).toContain('own branch');
    expect(GENERAL_PROMPT).toContain('squash-merges');
    // The old bare worktree fence survives inside the advertise.
    expect(GENERAL_PROMPT).toContain('edit only inside that tree');
  });

  it('verify advertises network as a MEANS for tooling, never as a source', () => {
    expect(VERIFY_PROMPT).toContain('The network is a MEANS');
    expect(VERIFY_PROMPT).toContain('npm install/test');
    expect(VERIFY_PROMPT).toContain('never as evidence');
    // The ask did NOT weaken the blind, evidence-first contract.
    expect(VERIFY_PROMPT).toContain('You are BLIND');
    expect(VERIFY_PROMPT).toContain('a pass needs evidence YOU produced this run.');
  });

  it('the advertise agrees with the REAL permission map (drift guard)', () => {
    // t160 rationale (taskTool.permissionsForTaskAgent): the verify KEEPS
    // `network` because the auto-spawned verify may run inside the general's
    // `git worktree add` checkout (no node_modules) and must be able to run
    // its own acceptance commands. Blindness is about evidence, not offline.
    expect(permissionsForTaskAgent('verify')).toContain('network');
    expect(permissionsForTaskAgent('verify')).not.toContain('write');
    expect(VERIFY_PROMPT).toContain('never write');
    // general: full union, and the prompt advertises all three capabilities.
    expect(permissionsForTaskAgent('general')).toEqual([
      'read',
      'write',
      'execute',
      'network',
    ]);
    // explore: read only — the spawn pops no execute/network approval card.
    expect(permissionsForTaskAgent('explore')).toEqual(['read']);
    expect(EXPLORE_PROMPT).toContain('read-only');
  });
});

describe('t154 — auto-verify prompt composes report blocks + VERDICT trailer (P1b)', () => {
  const prompt = buildTaskAutoVerifyPrompt({
    description: 'slice X',
    prompt: 'do the thing',
    acceptance: ['criterion-1'],
  });

  it('instructs BOTH formats, with the report blocks BEFORE the trailer', () => {
    expect(prompt).toContain('<verify-report>');
    expect(prompt).toContain('VERDICT: PASS');
    expect(prompt.indexOf('<verify-report>')).toBeLessThan(prompt.indexOf('VERDICT: PASS'));
    expect(prompt).toContain('LAST line');
  });

  it('a composed message (blocks then trailer) satisfies the verdict parser as PASS', () => {
    const composed = [
      'Ran the targeted suite for slice X.',
      '<verify-report>',
      'check: criterion-1',
      'status: pass',
      'note: npx vitest run src/cli/tools — 1/1 passed',
      '</verify-report>',
      'VERDICT: PASS',
    ].join('\n');
    expect(parseVerifyVerdict(composed).verdict).toBe('pass');
    // The report parser must also survive the trailer sitting AFTER the
    // blocks (shape-agnostic smoke: it parses without throwing).
    expect(() => parseVerifyReport(composed, ['criterion-1'])).not.toThrow();
  });

  it('a trailer-less message still parses as unknown (semantics unchanged)', () => {
    const noTrailer = [
      '<verify-report>',
      'check: criterion-1',
      'status: pass',
      'note: evidence',
      '</verify-report>',
    ].join('\n');
    expect(parseVerifyVerdict(noTrailer).verdict).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// t155 driver — same scripted-harness machinery as taskTool.verifyDebt.test:
// runAutoVerifyAfterGeneral → runTentacle → createSubAgentContext, with the
// context factory RECORDING the thoroughness each spawn receives.
// ---------------------------------------------------------------------------

interface SeenSpawn {
  agent: string;
  thoroughness: string;
}

function scriptedDepsRecording(seen: SeenSpawn[]): TaskToolDeps {
  return {
    createSubAgentContext: async ({ agent, thoroughness }) => {
      seen.push({ agent, thoroughness });
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
        const callId = `t-${Math.random().toString(36).slice(2, 8)}`;
        yield {
          type: 'tool_execution_start',
          toolCallId: callId,
          toolName: 'bash',
          args: { command: 'npx vitest run src/cli/tools/taskTool.tentacleContract.test.ts' },
        } as unknown as BrainEvent;
        yield {
          type: 'tool_execution_end',
          toolCallId: callId,
          isError: false,
          durationMs: 5,
          result: '1/1 passed',
        } as unknown as BrainEvent;
        yield { type: 'message_start' } as BrainEvent;
        yield { type: 'message_delta', delta: 'Suite green.\nVERDICT: PASS' } as BrainEvent;
        yield { type: 'message_end' } as BrainEvent;
      },
    }),
    allowWorktree: false,
  };
}

function fakeGeneral(agentId: string, cwd: string, thoroughness: TentacleSuccess['thoroughness']): TentacleSuccess {
  return {
    ok: true,
    agent: 'general',
    thoroughness,
    agentId,
    model: 'test-model',
    result: 'general output (stub)',
    footer: '',
    worktreePath: cwd,
    worktreeHandle: null,
  };
}

describe('t155 — inner verify inherits the general thoroughness (P1c)', () => {
  for (const th of ['quick', 'medium', 'deep'] as const) {
    it(`${th} general ⇒ ${th} inner verify (no hardcoded medium)`, async () => {
      const seen: SeenSpawn[] = [];
      const cwd = fs.mkdtempSync(path.join(tmpdir(), 'zelari-t155-'));
      const out = await runAutoVerifyAfterGeneral({
        deps: scriptedDepsRecording(seen),
        original: { description: `inherit ${th}`, prompt: 'do the thing' },
        general: fakeGeneral(`g-${th}`, cwd, th),
        parentCwd: cwd,
        sessionId: `t155-${th}`,
      });
      // The chain ran and passed (sanity: inheritance must not break the run).
      expect(out).toContain('verify PASS');
      expect(seen.length).toBeGreaterThan(0);
      // Every verify spawn in the chain received the PARENT's thoroughness.
      const verifySpawns = seen.filter((s) => s.agent === 'verify');
      expect(verifySpawns.length).toBeGreaterThan(0);
      for (const s of verifySpawns) {
        expect(s.thoroughness).toBe(th);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// t157 driver — scripted harness emitting ONE assistant message per turn
// (optional tool calls). The guard reads completed assistant messages, so a
// per-turn `message_start/delta/end` cycle is exactly the incident shape: one
// repetition per turn, each too small to trip core's intra-message detector.
// ---------------------------------------------------------------------------

/** Status-theater line from the 2026-09-21 incident (> guard min length). */
const LOOP_LINE =
  'Bene, dungeon.js fatto. Aggiorno todo e procedo con inventory adesso, come previsto.';

function scriptedTurnsDeps(turns: string[], repeatToolCall: boolean): TaskToolDeps {
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
        for (const [i, text] of turns.entries()) {
          if (repeatToolCall) {
            // Same command every turn: legitimate (a retry), so it must never
            // be what trips the guard.
            const callId = `t157-${i}`;
            yield {
              type: 'tool_execution_start',
              toolCallId: callId,
              toolName: 'bash',
              args: { command: 'npx vitest run src/cli/tools' },
            } as unknown as BrainEvent;
            yield {
              type: 'tool_execution_end',
              toolCallId: callId,
              isError: false,
              durationMs: 3,
              result: '1/1 passed',
            } as unknown as BrainEvent;
          }
          yield { type: 'message_start' } as BrainEvent;
          yield { type: 'message_delta', delta: text } as BrainEvent;
          yield { type: 'message_end' } as BrainEvent;
        }
      },
    }),
    allowWorktree: false,
  };
}

describe('t157 — degenerate loop stop reaches the parent (P2c)', () => {
  it('3 identical assistant turns ⇒ failed task result carrying the loop signal + partial output', async () => {
    const cwd = fs.mkdtempSync(path.join(tmpdir(), 'zelari-t157-'));
    const res = await runTentacle({
      deps: scriptedTurnsDeps([LOOP_LINE, LOOP_LINE, LOOP_LINE, LOOP_LINE, LOOP_LINE], true),
      args: { description: 'degenerate loop', prompt: 'research the thing' },
      agent: 'explore',
      thoroughness: 'quick',
      parentCwd: cwd,
      sessionId: 't157-degenerate',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('the guard must fail the tentacle, not return a result');
    expect(res.error).toContain('degenerate loop detected');
    expect(res.error).toContain('same assistant output repeated 3 times');
    expect(res.error).toContain('turn 3');
    // The partial output survives the stop (never a mute cut).
    expect(res.error).toContain('partial output');
    expect(res.error).toContain('aggiorno todo e procedo con inventory');
    expect(res.degenerate).toMatchObject({ turn: 3, repetitions: 3 });
    // Structured and textual signals agree.
    expect(res.error).toContain(`turn ${res.degenerate!.turn}`);
  });

  it('distinct assistant turns + identical tool calls ⇒ no false positive', async () => {
    const cwd = fs.mkdtempSync(path.join(tmpdir(), 'zelari-t157-'));
    const distinct = [
      'Letto il modulo guard: conto delle ripetizioni consecutive sul testo assistant.',
      'Ora scrivo i test puri del guard nel file dedicato e li eseguo con vitest.',
      'Suite verde sul guard; passo al typecheck del workspace prima del commit.',
      'Commit atomico dei tre file dello scope e report finale al parent adesso.',
      'Ultimo controllo del git status per chiudere la slice senza residui sporchi.',
    ];
    const res = await runTentacle({
      deps: scriptedTurnsDeps(distinct, true),
      args: { description: 'legit run', prompt: 'implement the slice' },
      agent: 'explore',
      thoroughness: 'quick',
      parentCwd: cwd,
      sessionId: 't157-legit',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    // The whole script ran: the guard stopped nothing.
    expect(res.turns).toBe(distinct.length);
    expect(res.result).toContain('Ultimo controllo del git status');
  });
});
