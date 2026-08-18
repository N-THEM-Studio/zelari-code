/**
 * taskTool.verifyReport.test — Fase 7 / ADR-0020 (Kraken Verified Selection).
 *
 * Structured verification wiring inside the task tool:
 *   - verify tentacle conclusion with `<verify-report>` blocks → results
 *     registered in the turn registry (checksPassed counts only `pass`)
 *   - failed verify tentacle → ALL checks unknown (degraded ≠ proof)
 *   - no selection this turn → nothing registered
 *   - explore tentacle never registers check results
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { BrainEvent } from '@zelari/core/shared/events';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import {
  createTaskTool,
  resetTaskSpawnCount,
  type SubAgentContext,
  type TaskToolDeps,
} from './taskTool.js';
import {
  getKrakenCheckResults,
  krakenChecksPassed,
  resetKrakenCandidates,
  setKrakenSelection,
} from '../kraken/candidateRegistry.js';
import type { KrakenSelectionVerdict } from '../kraken/verifier.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-verify-report-'));
}

function makeCtx(cwd = tmpRoot()): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    audit: () => undefined,
    sessionId: 'verify-report-test',
  };
}

/**
 * Deps fake whose scripted harness returns a fixed conclusion text.
 * An empty conclusion simulates a tentacle that produced no output.
 */
function scriptedDeps(conclusion: string): TaskToolDeps {
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
        if (conclusion === '') return;
        yield { type: 'message_start' } as BrainEvent;
        yield { type: 'message_delta', delta: conclusion } as BrainEvent;
        yield { type: 'message_end' } as BrainEvent;
      },
    }),
    allowWorktree: false,
  };
}

const CHECKS = [
  'unit test for session refresh passes',
  'no Set-Cookie regression on logout',
];

function selectedVerdict(): KrakenSelectionVerdict {
  return {
    status: 'selected',
    winnerIndex: 1,
    rationale: 'grounded in evidence',
    requiredChecks: CHECKS,
    degraded: false,
    verifier: { provider: 'p', model: 'm' },
    judgedBy: 'llm',
  };
}

const GOOD_CONCLUSION = [
  'Ran the targeted suite.',
  '<verify-report>',
  `check: ${CHECKS[0]}`,
  'status: pass',
  'note: vitest src/auth 41/41 green',
  '</verify-report>',
  '<verify-report>',
  `check: ${CHECKS[1]}`,
  'status: fail',
  'note: logout still emits double Set-Cookie',
  '</verify-report>',
].join('\n');

async function spawn(
  deps: TaskToolDeps,
  agent: 'verify' | 'explore',
): Promise<{ ok: boolean }> {
  const tool = createTaskTool(deps);
  const res = await tool.execute(
    {
      description: 'verify the fix',
      prompt: 'Verify the implementation.',
      agent,
    },
    makeCtx(),
  );
  return { ok: res.ok };
}

describe('structured verification registration (ADR-0020 Fase 7)', () => {
  beforeEach(() => {
    resetTaskSpawnCount();
    resetKrakenCandidates();
  });
  afterEach(() => {
    resetKrakenCandidates();
  });

  it('verify conclusion with blocks → per-check results registered, unknown ≠ pass', async () => {
    setKrakenSelection(selectedVerdict());
    const { ok } = await spawn(scriptedDeps(GOOD_CONCLUSION), 'verify');
    expect(ok).toBe(true);
    const results = getKrakenCheckResults();
    expect(results).not.toBeNull();
    expect(results?.map((r) => r.status)).toEqual(['pass', 'fail']);
    expect(krakenChecksPassed()).toBe(1);
  });

  it('failed verify tentacle → all checks unknown, zero passed', async () => {
    setKrakenSelection(selectedVerdict());
    const { ok } = await spawn(scriptedDeps(''), 'verify');
    expect(ok).toBe(false);
    const results = getKrakenCheckResults();
    expect(results?.map((r) => r.status)).toEqual(['unknown', 'unknown']);
    expect(krakenChecksPassed()).toBe(0);
  });

  it('verify without report blocks → every check unknown (no report ≠ pass)', async () => {
    setKrakenSelection(selectedVerdict());
    await spawn(scriptedDeps('looks good to me, suite green'), 'verify');
    expect(getKrakenCheckResults()?.map((r) => r.status)).toEqual(['unknown', 'unknown']);
    expect(krakenChecksPassed()).toBe(0);
  });

  it('no selection this turn → nothing registered', async () => {
    const { ok } = await spawn(scriptedDeps(GOOD_CONCLUSION), 'verify');
    expect(ok).toBe(true);
    expect(getKrakenCheckResults()).toBeNull();
    expect(krakenChecksPassed()).toBeUndefined();
  });

  it('explore tentacle never registers check results', async () => {
    setKrakenSelection(selectedVerdict());
    await spawn(scriptedDeps(GOOD_CONCLUSION), 'explore');
    expect(getKrakenCheckResults()).toBeNull();
  });
});
