/**
 * worktreeFallbackLoud.test — F12 / K2.4 executor degradation.
 *
 * Once a tentacle reports a worktree-creation failure (it fell back to the
 * shared parent tree), the graph executor must STOP rescuing overlapping
 * writers via worktree admission under ZELARI_KRAKEN_WORKTREE=auto — they are
 * no longer actually isolated — and serialize them via the P2.A deferral for
 * the rest of the run.
 *
 * The graph below forces the cross-round shape the bug needs:
 *   - e1 (explore) and g1 (writer) are roots admitted in round 1;
 *   - g1 reports the fallback while it stays in flight;
 *   - g2 (a writer overlapping g1) only becomes ready once e1 settles, so its
 *     scheduling decision lands in a LATER round — with the flag already set.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraphFromPlan } from './planner.js';
import { KrakenGraphExecutor } from './executor.js';
import { readKrakenRadio } from '../tools/krakenRadio.js';
import type { TentacleResult } from '../tools/taskTool.js';

function okResult(description: string): TentacleResult {
  return {
    ok: true,
    agent: 'general',
    thoroughness: 'medium',
    model: 'mock-model',
    result: `done: ${description}`,
    footer: '',
    worktreePath: null,
    worktreeHandle: null,
  };
}

/**
 * Bounded poll so the test can release the gated writer exactly when g2's
 * scheduling decision has landed. `node_deferred` carries only the node LABEL
 * (no nodeId), so the match is on the label for the deferral branch.
 */
async function pollG2Decision(cwd: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  const landed = (): boolean =>
    readKrakenRadio(cwd, 'sess-wtfb', 300).some(
      (e) =>
        (e.kind === 'node_worktree_scheduled' && e.nodeId === 'g2') ||
        (e.kind === 'node_deferred' && e.description === 'jwt'),
    );
  while (!landed()) {
    if (Date.now() - start > timeoutMs) throw new Error('pollG2Decision timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const GRAPH_NODES = [
  // e1: fast reader that gates g2's readiness to a later round.
  { id: 'e1', kind: 'explore' as const, label: 'scan', prompt: 'scan', deps: [] as string[] },
  // g1: root writer that reports a worktree fallback and stays in flight.
  {
    id: 'g1',
    kind: 'general' as const,
    label: 'auth core',
    prompt: 'fix auth core',
    scope: ['SRC/auth'],
    deps: [] as string[],
  },
  // g2: writer overlapping g1, ready only once e1 settles.
  {
    id: 'g2',
    kind: 'general' as const,
    label: 'jwt',
    prompt: 'extend auth',
    scope: ['src/auth/jwt.ts'],
    deps: ['e1'],
  },
];

function buildExecutor(cwd: string, reportFallback: boolean): { executor: KrakenGraphExecutor; release: () => void } {
  let releaseG1!: () => void;
  const g1Gate = new Promise<void>((r) => {
    releaseG1 = r;
  });
  const executor = new KrakenGraphExecutor({
    taskToolDeps: { createSubAgentContext: async () => null },
    parentCwd: cwd,
    sessionId: 'sess-wtfb',
    goal: 'auth',
    maxParallel: 2,
    // Make ownership arbitration catch `SRC/auth` ≡ `src/auth/jwt.ts`.
    ownershipCaseFolding: true,
    runTentacleFn: async (opts) => {
      if (opts.nodeId === 'g1') {
        if (reportFallback) {
          opts.deps.onWorktreeFallback?.({
            reason: 'fatal: could not create work tree dir',
            mode: 'auto',
            nodeId: 'g1',
          });
        }
        await g1Gate;
      }
      return okResult(opts.args.description);
    },
    mergeFn: async () => ({
      ok: true,
      merged: false,
      committed: false,
      conflict: false,
      message: 'no-op',
    }),
  });
  return { executor, release: releaseG1 };
}

describe('executor serializes overlapping writers after a worktree fallback (F12 / K2.4)', () => {
  it('loses worktree admission: g2 defers instead of being rescued, and the degradation is recorded', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-wtfb-'));
    const prev = process.env.ZELARI_KRAKEN_WORKTREE;
    process.env.ZELARI_KRAKEN_WORKTREE = 'auto';
    try {
      const graph = buildGraphFromPlan('kraken-wtfb', GRAPH_NODES);
      const { executor, release } = buildExecutor(cwd, true);

      const run = executor.execute(graph);
      await pollG2Decision(cwd);
      release();
      const summary = await run;
      expect(summary.converged).toBe(true);

      const radio = readKrakenRadio(cwd, 'sess-wtfb', 400);
      // Degraded: the overlapping writer was NOT rescued into a worktree…
      expect(
        radio.filter((e) => e.kind === 'node_worktree_scheduled' && e.nodeId === 'g2'),
      ).toHaveLength(0);
      // …it deferred (serial admission) instead…
      expect(
        radio.some((e) => e.kind === 'node_deferred' && e.description === 'jwt'),
      ).toBe(true);
      // …and the executor recorded the degradation once.
      expect(
        radio.some(
          (e) => e.kind === 'progress' && (e.detail ?? '').includes('degraded to serial admission'),
        ),
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ZELARI_KRAKEN_WORKTREE;
      else process.env.ZELARI_KRAKEN_WORKTREE = prev;
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('control: WITHOUT a fallback the same overlapping writer IS rescued (worktree-isolated)', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-wtfb-ctl-'));
    const prev = process.env.ZELARI_KRAKEN_WORKTREE;
    process.env.ZELARI_KRAKEN_WORKTREE = 'auto';
    try {
      const graph = buildGraphFromPlan('kraken-wtfb-ctl', GRAPH_NODES);
      const { executor, release } = buildExecutor(cwd, false);

      const run = executor.execute(graph);
      await pollG2Decision(cwd);
      release();
      const summary = await run;
      expect(summary.converged).toBe(true);

      const radio = readKrakenRadio(cwd, 'sess-wtfb', 400);
      expect(
        radio.some((e) => e.kind === 'node_worktree_scheduled' && e.nodeId === 'g2'),
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ZELARI_KRAKEN_WORKTREE;
      else process.env.ZELARI_KRAKEN_WORKTREE = prev;
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
