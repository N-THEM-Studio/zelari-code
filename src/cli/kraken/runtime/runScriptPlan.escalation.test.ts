/**
 * runScriptPlan bridge × K4.5 (F27) quality escalation — tests.
 *
 * The escalation DECISION lives in core (`runTentacleWithQualityEscalation`,
 * wired by `ScriptRunner.callTentacle`); these tests pin what the CLI bridge
 * must do with what the seam sends it:
 *
 *   1. hint ON + weak output ⇒ EXACTLY one re-run, and it starts on the
 *      PARENT/lead model (`SubAgentContext.fallback` identity), never on the
 *      node's sub-model routing — and the re-run's output REPLACES the weak one.
 *   2. hint absent (flag OFF) ⇒ pass-through: one call, no re-run, no events.
 *   3. `worktreeByTentacleId` keyed on the real tentacle id: with an
 *      escalation (2 calls for one unit) merge still sees exactly the winning
 *      handles — no drift, no double-keying (the old predictive counter would
 *      merge [first-run handle, re-run handle] and strand the second unit).
 *
 * Only the LLM/worktree seams are stubbed (`runTentacle`, `mergeKrakenWorktree`);
 * the real compile → sandbox → ScriptRunner → bridge path runs.
 */
import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QUALITY_ESCALATION_ENV } from '@zelari/core';
import type { TaskToolDeps, TentacleResult } from '../../tools/taskTool.js';
import type { WorktreeHandle } from '../../tools/krakenWorktree.js';
import { runScriptPlan } from './runScriptPlan.js';

/** Maximally weak claim: zero specificity markers, zero clauses ⇒ weakness 1. */
const WEAK_TEXT = 'All done.';
/** Marker-heavy claim ⇒ weakness ≈ 0.2 (well below the 0.85 threshold). */
const STRONG_TEXT = 'Must parse version 1.2.3 at line 42.';

const LEAD_MODEL = 'lead-model';
const SUB_MODEL = 'cheap-sub';

const h = vi.hoisted(() => ({
  calls: [] as { label: string; model: string | null }[],
  results: [] as { text: string; handle: unknown; worktreePath: string | null }[],
  merges: [] as unknown[],
}));

vi.mock('../../tools/taskTool.js', () => ({
  runTentacle: async (opts: {
    agent: string;
    thoroughness: string;
    parentCwd: string;
    args: { description: string };
    deps: {
      createSubAgentContext: (o: unknown) => Promise<{ model?: string } | null>;
    };
  }): Promise<TentacleResult> => {
    // Observe the model the run would actually start on: the quality re-run
    // swaps in the lead identity via the wrapped createSubAgentContext.
    const ctx = await opts.deps.createSubAgentContext({
      agent: opts.agent,
      thoroughness: opts.thoroughness,
      cwd: opts.parentCwd,
    });
    h.calls.push({ label: opts.args.description, model: ctx?.model ?? null });
    const next = h.results.shift();
    if (!next) throw new Error(`unexpected runTentacle call #${h.calls.length}`);
    return {
      ok: true,
      agent: opts.agent,
      thoroughness: opts.thoroughness,
      model: 'mock-model',
      result: next.text,
      footer: '',
      worktreePath: next.worktreePath,
      worktreeHandle: next.handle,
    } as unknown as TentacleResult;
  },
}));

vi.mock('../../tools/krakenWorktree.js', () => ({
  mergeKrakenWorktree: async (handle: unknown) => {
    h.merges.push(handle);
    return { ok: true, merged: true, committed: true, conflict: false, message: 'merged' };
  },
}));

const ONE_UNIT_PLAN = `import { tentacle } from '@zelari/kraken-runtime';
const a = await tentacle({ kind: 'general', label: 'w1', prompt: 'p1', scope: ['src/a'] });
`;

const TWO_UNITS_MERGE_PLAN = `import { tentacle, merge } from '@zelari/kraken-runtime';
const a = await tentacle({ kind: 'general', label: 'w1', prompt: 'p1', scope: ['src/a'] });
const b = await tentacle({ kind: 'general', label: 'w2', prompt: 'p2', scope: ['src/b'] });
await merge([a, b]);
`;

function handle(id: string): WorktreeHandle {
  return { id, branch: `br-${id}`, path: `P:/${id}`, repoRoot: 'R:' };
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

async function runPlan(
  planSource: string,
  results: { text: string; handle: unknown; worktreePath: string | null }[],
  log: string[],
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-qesc-'));
  try {
    const planPath = path.join(cwd, 'plan.ts');
    await fs.writeFile(planPath, planSource, 'utf8');
    h.calls.length = 0;
    h.results.length = 0;
    h.merges.length = 0;
    h.results.push(...results);
    return await runScriptPlan({
      planPath,
      goal: 'quality escalation bridge',
      parentCwd: cwd,
      sessionId: 'sess-qesc',
      taskToolDeps: fakeDeps(),
      onLog: (line) => log.push(line),
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

describe('runScriptPlan bridge × quality escalation (K4.5/F27)', () => {
  it('hint ON + weak output ⇒ esattamente 1 re-run sul parent model', async () => {
    const restore = withEscalationEnv('1');
    try {
      const hA = handle('wtA');
      const hB = handle('wtB');
      const log: string[] = [];
      const outcome = await runPlan(
        ONE_UNIT_PLAN,
        [
          { text: WEAK_TEXT, handle: hA, worktreePath: hA.path },
          { text: STRONG_TEXT, handle: hB, worktreePath: hB.path },
        ],
        log,
      );

      // Exactly one re-run: 2 tentacle calls for 1 work unit.
      expect(h.calls).toHaveLength(2);
      // First call keeps the routed sub-model; the re-run starts on the LEAD.
      expect(h.calls.map((c) => c.model)).toEqual([SUB_MODEL, LEAD_MODEL]);
      // The re-run's output replaced the weak one on the ref the script sees.
      expect(outcome.result.tentacles.get('t0001')?.findings).toBe(STRONG_TEXT);
      // The escalation events ride the existing log channel
      // (`buildQualityEscalationLine` via core's host.log forwarding).
      expect(log.some((l) => l.includes('[quality_escalation] rerun on parent model'))).toBe(true);
      expect(log.some((l) => l.includes('replaced weak output'))).toBe(true);
    } finally {
      restore();
    }
  });

  it('hint assente ⇒ pass-through (1 chiamata, nessun re-run)', async () => {
    const restore = withEscalationEnv(undefined);
    try {
      const hA = handle('wtA');
      const log: string[] = [];
      const outcome = await runPlan(
        ONE_UNIT_PLAN,
        [{ text: WEAK_TEXT, handle: hA, worktreePath: hA.path }],
        log,
      );

      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]!.model).toBe(SUB_MODEL); // routing untouched
      expect(outcome.result.tentacles.get('t0001')?.findings).toBe(WEAK_TEXT);
      expect(log.some((l) => l.includes('[quality_escalation]'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('worktree map keyed su id reale: con escalation (2 chiamate) nessun drift/doppio-keying', async () => {
    const restore = withEscalationEnv('1');
    try {
      const hA = handle('wtA'); // first run of unit 1 — weak, superseded
      const hB = handle('wtB'); // re-run of unit 1 — wins
      const hC = handle('wtC'); // unit 2
      const log: string[] = [];
      await runPlan(
        TWO_UNITS_MERGE_PLAN,
        [
          { text: WEAK_TEXT, handle: hA, worktreePath: hA.path },
          { text: STRONG_TEXT, handle: hB, worktreePath: hB.path },
          { text: STRONG_TEXT, handle: hC, worktreePath: hC.path },
        ],
        log,
      );

      expect(h.calls).toHaveLength(3); // 2 units + 1 quality re-run
      // Merge sees EXACTLY the winning handles, in ref order: the re-run's
      // handle under unit 1's real id (t0001), unit 2's under t0002. The old
      // predictive counter keyed [t0001→wtA, t0002→wtB, t0003→wtC] and merge
      // would have merged wtA + wtB, stranding wtC.
      expect(h.merges).toHaveLength(2);
      expect(h.merges.map((m) => (m as WorktreeHandle).id)).toEqual(['wtB', 'wtC']);
    } finally {
      restore();
    }
  });
});
