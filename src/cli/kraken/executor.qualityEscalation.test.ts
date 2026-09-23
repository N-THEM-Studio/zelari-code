/**
 * executor.ts × K4.5 (F27) quality escalation — tests.
 *
 * The JSON-DAG path rides the SAME seam as core's `callTentacle`
 * (`runTentacleUnit` → `runTentacleWithQualityEscalation`). Pinned here:
 *
 *   1. DEFAULT OFF: without `ZELARI_KRAKEN_QUALITY_ESCALATION` the node's
 *      tentacle call is pass-through — exactly one run, even on a weak output.
 *   2. Flag ON + weak output ⇒ exactly ONE re-run, and it starts on the
 *      PARENT/lead model (lead identity from `SubAgentContext.fallback`),
 *      whose output replaces the weak one on the graph node.
 *
 * Same style as `executor.workbench.test.ts`: only the tentacle seam is
 * stubbed (`runTentacleFn` injection), the real executor drives the graph.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QUALITY_ESCALATION_ENV } from '@zelari/core';
import { buildGraphFromPlan } from './planner.js';
import { KrakenGraphExecutor } from './executor.js';
import type { RunTentacleOptions, TaskToolDeps, TentacleResult } from './tentacle.js';

/** Maximally weak claim: zero specificity markers, zero clauses ⇒ weakness 1. */
const WEAK_TEXT = 'All done.';
/** Marker-heavy claim ⇒ weakness ≈ 0.2 (well below the 0.85 threshold). */
const STRONG_TEXT = 'Must parse version 1.2.3 at line 42.';

const LEAD_MODEL = 'lead-model';
const SUB_MODEL = 'cheap-sub';

function okResult(result: string): TentacleResult {
  return {
    ok: true,
    agent: 'explore',
    thoroughness: 'medium',
    model: 'mock-model',
    result,
    footer: '',
    worktreePath: null,
    worktreeHandle: null,
  };
}

/** Injectable deps whose sub-agent context carries the lead identity fallback. */
function fakeDeps(): TaskToolDeps {
  const providerStream = (async function* () {}) as never;
  const ctx = {
    model: SUB_MODEL,
    provider: 'p',
    providerStream,
    cwd: '.',
    registry: {
      invoke: async () => ({ output: '' }),
      fingerprints: () => [],
      toOpenAITools: () => [],
    },
    tools: [],
    fallback: { model: LEAD_MODEL, provider: 'p', providerStream },
  };
  return { createSubAgentContext: async () => ctx } as unknown as TaskToolDeps;
}

function withEscalationEnv(value: string | undefined): () => void {
  const previous = process.env[QUALITY_ESCALATION_ENV];
  if (value === undefined) delete process.env[QUALITY_ESCALATION_ENV];
  else process.env[QUALITY_ESCALATION_ENV] = value;
  return () => {
    if (previous === undefined) delete process.env[QUALITY_ESCALATION_ENV];
    else process.env[QUALITY_ESCALATION_ENV] = previous;
  };
}

describe('executor JSON-DAG path × quality escalation (K4.5/F27)', () => {
  it('DEFAULT OFF ⇒ pass-through invariato (1 chiamata, nessun re-run)', async () => {
    const restore = withEscalationEnv(undefined);
    try {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-qesc-off-'));
      try {
        const graph = buildGraphFromPlan('kraken-qesc-off', [
          { id: 'e1', kind: 'explore', label: 'probe', prompt: 'probe', deps: [] },
        ]);
        const calls: RunTentacleOptions[] = [];
        const executor = new KrakenGraphExecutor({
          taskToolDeps: fakeDeps(),
          parentCwd: cwd,
          sessionId: 'sess-qesc-off',
          goal: 'quality escalation off',
          runTentacleFn: async (opts) => {
            calls.push(opts);
            return okResult(WEAK_TEXT);
          },
        });
        const summary = await executor.execute(graph);
        expect(summary.converged).toBe(true);
        // Weak output, flag OFF: exactly one tentacle call for the node.
        expect(calls.filter((c) => c.nodeId === 'e1')).toHaveLength(1);
        expect(graph.nodes.get('e1')!.result).toBe(WEAK_TEXT);
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    } finally {
      restore();
    }
  });

  it('flag ON + output debole ⇒ esattamente 1 re-run sul parent model, output sostituito', async () => {
    const restore = withEscalationEnv('1');
    try {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-qesc-on-'));
      try {
        const graph = buildGraphFromPlan('kraken-qesc-on', [
          { id: 'e1', kind: 'explore', label: 'probe', prompt: 'probe', deps: [] },
        ]);
        const calls: RunTentacleOptions[] = [];
        const models: (string | null)[] = [];
        const executor = new KrakenGraphExecutor({
          taskToolDeps: fakeDeps(),
          parentCwd: cwd,
          sessionId: 'sess-qesc-on',
          goal: 'quality escalation on',
          runTentacleFn: async (opts) => {
            calls.push(opts);
            // The quality re-run arrives with the parent-model deps wrapper:
            // observe the model it would actually start on.
            const ctx = await opts.deps.createSubAgentContext({
              agent: opts.agent,
              thoroughness: opts.thoroughness,
              cwd: opts.parentCwd,
            });
            models.push(ctx?.model ?? null);
            // First run of e1 is weak (triggers the escalation), the re-run
            // and any other node produce a strong output.
            const firstOfNode = calls.filter((c) => c.nodeId === opts.nodeId).length === 1;
            return okResult(firstOfNode ? WEAK_TEXT : STRONG_TEXT);
          },
        });
        await executor.execute(graph);

        // Exactly one re-run: 2 tentacle calls for the node.
        expect(calls.filter((c) => c.nodeId === 'e1')).toHaveLength(2);
        // Routed sub-model first, PARENT/lead model on the re-run.
        expect(models).toEqual([SUB_MODEL, LEAD_MODEL]);
        // The re-run's output replaced the weak one on the graph node.
        expect(graph.nodes.get('e1')!.result).toBe(STRONG_TEXT);
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    } finally {
      restore();
    }
  });
});
