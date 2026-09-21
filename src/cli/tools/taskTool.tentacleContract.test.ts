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
  resetTaskVerifyObligation,
  runAutoVerifyAfterGeneral,
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
