/**
 * taskTool.dynamicChecks.test — Fase 6 / ADR-0020 (Kraken Verified Selection).
 *
 * BUILD dynamic checks: le requiredChecks di una selezione `selected`
 * diventano proof obligations AUTOMATICHE di ogni tentacle verify:
 *   - append dedupe case-insensitive sull'acceptance del parent
 *   - mai iniettate su explore/general
 *   - mai con needs_more_evidence (i check restano advisory)
 *   - assenza di selezione ⇒ comportamento invariato
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
  resetKrakenCandidates,
  setKrakenSelection,
} from '../kraken/candidateRegistry.js';
import type { KrakenSelectionVerdict } from '../kraken/verifier.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-dyn-checks-'));
}

function makeCtx(cwd = tmpRoot()): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    audit: () => undefined,
    sessionId: 'dynamic-checks-test',
  };
}

/**
 * Deps fake che cattura il user prompt del tentacle via harnessFactory:
 * config.messages[0] = system, [1] = user (buildTaskUserPrompt output).
 */
function capturingDeps(): { deps: TaskToolDeps; userPrompts: () => string[] } {
  const prompts: string[] = [];
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
    harnessFactory: (config) => {
      prompts.push(String(config.messages[1]?.content ?? ''));
      return {
        run: async function* (): AsyncGenerator<BrainEvent> {
          yield { type: 'message_start' } as BrainEvent;
          yield { type: 'message_delta', delta: 'verified' } as BrainEvent;
          yield { type: 'message_end' } as BrainEvent;
        },
      };
    },
    allowWorktree: false,
  };
  return { deps, userPrompts: () => prompts };
}

const CHECKS = [
  'unit test for session refresh passes',
  'no Set-Cookie regression on logout',
];

function verdict(
  status: 'selected' | 'needs_more_evidence',
  requiredChecks: string[] = CHECKS,
): KrakenSelectionVerdict {
  return {
    status,
    winnerIndex: status === 'selected' ? 1 : null,
    rationale: 'grounded in evidence',
    requiredChecks,
    degraded: false,
    verifier: { provider: 'p', model: 'm' },
    judgedBy: 'llm',
  };
}

async function spawnVerify(
  deps: TaskToolDeps,
  acceptance?: string[],
): Promise<string> {
  const tool = createTaskTool(deps);
  const res = await tool.execute(
    {
      description: 'verify the fix',
      prompt: 'Verify the implementation.',
      agent: 'verify',
      ...(acceptance ? { acceptance } : {}),
    },
    makeCtx(),
  );
  if (!res.ok) throw new Error(`task failed: ${String(res.error)}`);
  return '';
}

describe('verify acceptance injection (ADR-0020 Fase 6)', () => {
  beforeEach(() => {
    resetTaskSpawnCount();
    resetKrakenCandidates();
  });
  afterEach(() => {
    resetKrakenCandidates();
  });

  it('selected verdict → requiredChecks become the verify acceptance', async () => {
    const { deps, userPrompts } = capturingDeps();
    setKrakenSelection(verdict('selected'));
    await spawnVerify(deps);
    const prompt = userPrompts()[0];
    expect(prompt).toContain('## Acceptance criteria');
    expect(prompt).toContain(CHECKS[0]);
    expect(prompt).toContain(CHECKS[1]);
  });

  it('merges with parent acceptance, deduped case-insensitively', async () => {
    const { deps, userPrompts } = capturingDeps();
    setKrakenSelection(verdict('selected'));
    await spawnVerify(deps, [
      'Existing criterion', // parent-provided, must be kept
      'Unit Test For Session Refresh Passes', // same check, different case
    ]);
    const prompt = userPrompts()[0];
    expect(prompt).toContain('Existing criterion');
    // dedupe: the case-variant does not produce a second copy
    expect(prompt.match(/session refresh passes/gi)).toHaveLength(1);
    // the non-duplicated required check is appended once
    expect(prompt.match(/Set-Cookie regression/gi)).toHaveLength(1);
  });

  it('needs_more_evidence → checks stay advisory (no injection)', async () => {
    const { deps, userPrompts } = capturingDeps();
    setKrakenSelection(verdict('needs_more_evidence'));
    await spawnVerify(deps);
    expect(userPrompts()[0]).not.toContain('## Acceptance criteria');
    expect(userPrompts()[0]).not.toContain(CHECKS[0]);
  });

  it('explore tentacle is never touched by the injection', async () => {
    const { deps, userPrompts } = capturingDeps();
    setKrakenSelection(verdict('selected'));
    const tool = createTaskTool(deps);
    await tool.execute(
      { description: 'explore', prompt: 'Look around.', agent: 'explore' },
      makeCtx(),
    );
    expect(userPrompts()[0]).not.toContain('## Acceptance criteria');
    expect(userPrompts()[0]).not.toContain(CHECKS[0]);
  });

  it('general tentacle keeps its own acceptance only', async () => {
    const { deps, userPrompts } = capturingDeps();
    setKrakenSelection(verdict('selected'));
    const tool = createTaskTool(deps);
    await tool.execute(
      {
        description: 'impl',
        prompt: 'Implement.',
        agent: 'general',
        acceptance: ['Only criterion'],
      },
      makeCtx(),
    );
    const prompt = userPrompts()[0];
    expect(prompt).toContain('Only criterion');
    expect(prompt).not.toContain(CHECKS[0]);
  });

  it('no selection this turn → verify prompt unchanged (no acceptance)', async () => {
    const { deps, userPrompts } = capturingDeps();
    await spawnVerify(deps);
    expect(userPrompts()[0]).not.toContain('## Acceptance criteria');
  });
});
