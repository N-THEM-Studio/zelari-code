/**
 * cli-tentacleActivityOutcome.test.ts — the `agent_ended` payload the Desktop
 * Kraken panel reads carries the tentacle's tool outcome (F4): a "completed"
 * tentacle whose tool channel was mostly errors is flagged `toolsDegraded`,
 * so the row stops looking like a clean ✓ (P1: DEGRADED is not evidence).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTaskTool,
  resetTaskSpawnCount,
  type SubAgentContext,
  type TaskToolDeps,
} from '../../src/cli/tools/taskTool.js';
import type { BrainAgentEndedEvent, BrainEvent } from '@zelari/core/shared/events';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

/** Scripted harness: `errors` of `calls` tool executions fail, then a report. */
const toolHarness =
  (calls: number, errors: number): TaskToolDeps['harnessFactory'] =>
  () => ({
    async *run() {
      for (let i = 0; i < calls; i++) {
        yield { type: 'tool_execution_start', toolCallId: `c${i}`, toolName: 'read', args: {} } as BrainEvent;
        yield {
          type: 'tool_execution_end',
          toolCallId: `c${i}`,
          toolName: 'read',
          isError: i < errors,
          result: i < errors ? 'ENOENT' : 'ok',
        } as BrainEvent;
      }
      yield { type: 'message_start' } as BrainEvent;
      yield { type: 'message_delta', delta: 'report' } as BrainEvent;
      yield { type: 'message_end' } as BrainEvent;
    },
  });

const dummyContext: SubAgentContext = {
  providerStream: (async function* () {})() as never,
  model: 'm',
  provider: 'openai-compatible',
  registry: {} as never,
  tools: [],
};

describe('agent_ended — tool outcome for the Desktop panel', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'zelari-tentacle-outcome-'));
    resetTaskSpawnCount();
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const run = async (calls: number, errors: number): Promise<BrainAgentEndedEvent | undefined> => {
    const events: BrainEvent[] = [];
    const ctx: ToolContext = { signal: new AbortController().signal, cwd, audit: () => {}, sessionId: 'test' };
    await createTaskTool({
      onTentacleEvent: (ev) => events.push(ev),
      allowWorktree: false,
      createSubAgentContext: async () => dummyContext,
      harnessFactory: toolHarness(calls, errors),
    }).execute({ description: 'probe', prompt: 'do it', agent: 'explore' }, ctx);
    return events.find((e) => e.type === 'agent_ended') as BrainAgentEndedEvent | undefined;
  };

  it('a mostly-failed tool channel is flagged degraded, with the counts', async () => {
    const ended = await run(5, 4);
    expect(ended).toBeDefined();
    expect(ended!.toolCalls).toBe(5);
    expect(ended!.toolErrors).toBe(4);
    expect(ended!.toolsDegraded).toBe(true);
  });

  it('a healthy channel reports its calls and no degradation', async () => {
    const ended = await run(3, 1);
    expect(ended!.toolCalls).toBe(3);
    expect(ended!.toolErrors).toBe(1);
    expect(ended!.toolsDegraded).toBeUndefined();
    const clean = await run(2, 0);
    expect(clean!.toolErrors).toBeUndefined();
    expect(clean!.toolsDegraded).toBeUndefined();
  });
});
