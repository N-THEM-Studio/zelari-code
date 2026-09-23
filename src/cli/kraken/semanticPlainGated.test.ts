/**
 * semanticPlainGated.test — F19 / K3.7 plain-admission gating.
 *
 * A semantic-disjoint rescue of a held writer has two shapes: run it in its
 * own worktree (scheduling mode 'auto' + isolatable node) or admit it PLAINLY
 * alongside its same-file racer (no isolation — a real git merge risk). The
 * plain shape must only be licensed by the 'auto' scheduling mode — the only
 * mode whose worktree machinery + sequential merges bound the residual
 * same-file risk. Any other mode keeps the P2.A deferral (K3.7).
 *
 * Graph shape (cross-round, proven by worktreeFallbackLoud):
 *   - e1 (explore) and g1 (writer, gated in flight) are roots of round 1;
 *   - g2 — a writer with symbol-disjoint claims on the SAME contested file as
 *     g1 — only becomes ready once e1 settles, so its admission decision
 *     lands while g1 is still running.
 *
 * Two deliberate knobs make this reach the PLAIN semantic branch (K3.7's
 * subject) — both lifted verbatim from the proven wtfb shape:
 *   - scope strings differ only by CASE (`SRC/auth` vs `src/auth/jwt.ts`):
 *     core's `canRunParallel` is case-SENSITIVE (scopes look disjoint ⇒ g2 is
 *     a candidate) while the executor's arbitration FOLDS case (overlap ⇒ g2
 *     is held). Identical-case overlapping scopes would be serialized with NO
 *     event at all — nothing for this test to observe;
 *   - g1 reports a worktree fallback (`onWorktreeFallback`): the worktree
 *     rescue declines (shared tree degraded) and the semantic rescue can only
 *     admit PLAINLY ("plain parallel; same-file merge risk").
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

const GRAPH_NODES = [
  // e1: fast reader that gates g2's readiness to a later round.
  { id: 'e1', kind: 'explore' as const, label: 'scan', prompt: 'scan', deps: [] as string[] },
  // g1: root writer (contested-file owner), gated in flight across g2's decision.
  {
    id: 'g1',
    kind: 'general' as const,
    label: 'alpha core',
    prompt: 'edit alpha',
    scope: ['SRC/auth'],
    ownedSymbols: ['src/auth/jwt.ts#Alpha'],
    deps: [] as string[],
  },
  // g2: overlapping writer with disjoint claims — arbitration holds it.
  {
    id: 'g2',
    kind: 'general' as const,
    label: 'beta core',
    prompt: 'edit beta',
    scope: ['src/auth/jwt.ts'],
    ownedSymbols: ['src/auth/jwt.ts#Beta'],
    deps: ['e1'],
  },
];

/**
 * Bounded poll: release g1 exactly when g2's admission decision has landed —
 * `node_semantic_admitted` (rescued) or `node_deferred` for the held writer.
 * `node_deferred` carries only the node LABEL (no nodeId), so the match is on
 * the label for the deferral branch.
 */
async function pollG2Decision(cwd: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  const landed = (): boolean =>
    readKrakenRadio(cwd, 'sess-k37', 300).some(
      (e) =>
        e.kind === 'node_semantic_admitted' ||
        (e.kind === 'node_deferred' && e.description === 'beta core'),
    );
  while (!landed()) {
    if (Date.now() - start > timeoutMs) throw new Error('pollG2Decision timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildExecutor(
  cwd: string,
): { executor: KrakenGraphExecutor; ran: string[]; release: () => void } {
  let releaseG1!: () => void;
  const g1Gate = new Promise<void>((r) => {
    releaseG1 = r;
  });
  const ran: string[] = [];
  const executor = new KrakenGraphExecutor({
    taskToolDeps: { createSubAgentContext: async () => null },
    parentCwd: cwd,
    sessionId: 'sess-k37',
    goal: 'auth',
    maxParallel: 2,
    // Makes the case-folded scopes overlap in the executor's arbitration.
    ownershipCaseFolding: true,
    // Claims verify as symbol-disjoint against these extracted symbols.
    symbolExtractor: async () => ['Alpha', 'Beta'],
    runTentacleFn: async (opts) => {
      ran.push(opts.nodeId ?? '?');
      if (opts.nodeId === 'g1') {
        // Degrade the shared tree so the worktree rescue declines and the
        // semantic rescue can only take the PLAIN branch.
        opts.deps.onWorktreeFallback?.({
          reason: 'fatal: could not create work tree dir',
          mode: 'auto',
          nodeId: 'g1',
        });
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
  return { executor, ran, release: releaseG1 };
}

describe('executor gates plain semantic admission on scheduling auto (F19 / K3.7)', () => {
  it("mode 'off': the disjoint writer defers (K3.7) instead of being admitted plainly, and still runs serially", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-k37-off-'));
    const prev = process.env.ZELARI_KRAKEN_WORKTREE;
    process.env.ZELARI_KRAKEN_WORKTREE = 'off';
    try {
      const graph = buildGraphFromPlan('kraken-k37-off', GRAPH_NODES);
      const { executor, ran, release } = buildExecutor(cwd);
      const run = executor.execute(graph);
      await pollG2Decision(cwd);
      release();
      const summary = await run;
      expect(summary.converged).toBe(true);

      const radio = readKrakenRadio(cwd, 'sess-k37', 400);
      // NOT rescued (plain or worktree)…
      expect(radio.some((e) => e.kind === 'node_semantic_admitted')).toBe(false);
      // …deferred, with the gate saying exactly why…
      expect(
        radio.some(
          (e) => e.kind === 'node_deferred' && (e.detail ?? '').includes('K3.7'),
        ),
      ).toBe(true);
      // …and no work is lost: g2 runs through serial admission later.
      expect(ran).toContain('g2');
    } finally {
      if (prev === undefined) delete process.env.ZELARI_KRAKEN_WORKTREE;
      else process.env.ZELARI_KRAKEN_WORKTREE = prev;
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("mode 'auto': the same disjoint writer IS admitted plainly — the licensed shape", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-k37-auto-'));
    const prev = process.env.ZELARI_KRAKEN_WORKTREE;
    process.env.ZELARI_KRAKEN_WORKTREE = 'auto';
    try {
      const graph = buildGraphFromPlan('kraken-k37-auto', GRAPH_NODES);
      const { executor, ran, release } = buildExecutor(cwd);
      const run = executor.execute(graph);
      await pollG2Decision(cwd);
      release();
      const summary = await run;
      expect(summary.converged).toBe(true);

      const radio = readKrakenRadio(cwd, 'sess-k37', 400);
      // The plain semantic admission IS licensed under 'auto'…
      expect(
        radio.some(
          (e) =>
            e.kind === 'node_semantic_admitted' &&
            (e.detail ?? '').includes('plain parallel'),
        ),
      ).toBe(true);
      // …never through the worktree rescue (the shared tree is degraded)…
      expect(radio.some((e) => e.kind === 'node_worktree_scheduled')).toBe(false);
      // …and the K3.7 gate never fires in this mode.
      expect(
        radio.some(
          (e) => e.kind === 'node_deferred' && (e.detail ?? '').includes('K3.7'),
        ),
      ).toBe(false);
      expect(ran).toContain('g2');
    } finally {
      if (prev === undefined) delete process.env.ZELARI_KRAKEN_WORKTREE;
      else process.env.ZELARI_KRAKEN_WORKTREE = prev;
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
