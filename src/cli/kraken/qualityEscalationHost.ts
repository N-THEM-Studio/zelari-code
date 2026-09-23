/**
 * Kraken graph engine — K4.5 (F27) quality escalation, CLI-side host seam.
 *
 * `packages/core/src/kraken/qualityEscalation.ts` owns the POLICY (score the
 * output, re-run at most once with `escalation.to = 'parent-model'`); core's
 * `ScriptRunner.callTentacle` already routes script-plan tentacles through it.
 * This module holds the two CLI-side adapters the JSON-DAG executor needs to
 * ride the SAME seam, plus the parent-model routing the hint asks for:
 *
 *   - `runTentacleUnit` — the `callTentacle` dispatch, minimally duplicated:
 *     run through `runTentacleWithQualityEscalation`, keep the RAW
 *     `TentacleResult` of the winning run (the wrapper's `HostTentacleResult`
 *     is lossy — the executor needs worktreeHandle/usage/model downstream).
 *   - `withParentModelDeps` — force the PARENT/lead identity for a quality
 *     re-run. `createSubAgentContext` routes a cheap sub-model per kind and
 *     carries the lead identity in `SubAgentContext.fallback` (the same swap
 *     `taskTool` performs on an unknown-model retry); a re-run must leave
 *     `node.model` and the sub-model routing alone and start on that lead.
 *
 * DEFAULT OFF is preserved end to end: without `ZELARI_KRAKEN_QUALITY_ESCALATION`
 * `runTentacleUnit` is one env read plus exactly the run it replaced.
 *
 * @since K4.5b/F27 — quality escalation wired into the CLI paths
 */

import {
  runTentacleWithQualityEscalation,
  type HostTentacleResult,
  type QualityEscalationHint,
  type TentacleOptions,
} from '@zelari/core';
import type { TaskAgentKind, TaskToolDeps, TentacleResult } from '../tools/taskTool.js';

/** Lossy projection of a raw run onto the core bridge result shape. */
export function toHostTentacleResult(res: TentacleResult): HostTentacleResult {
  return res.ok
    ? { ok: true, result: res.result, durationMs: undefined, worktree: res.worktreePath }
    : { ok: false, error: res.error, durationMs: undefined, worktree: null };
}

/**
 * Wrap `TaskToolDeps` so the next tentacle starts on the PARENT/lead model:
 * the routed sub-model is swapped for the lead identity carried in
 * `SubAgentContext.fallback` (model + provider + providerStream — exactly the
 * swap `taskTool` does when the routed id is rejected). No fallback means the
 * context is already on the lead and passes through untouched.
 */
export function withParentModelDeps(deps: TaskToolDeps): TaskToolDeps {
  const create = deps.createSubAgentContext;
  return {
    ...deps,
    createSubAgentContext: async (opts) => {
      const sub = await create(opts);
      const lead = sub?.fallback;
      if (!sub || !lead) return sub;
      return {
        ...sub,
        model: lead.model,
        provider: lead.provider,
        providerStream: lead.providerStream,
      };
    },
  };
}

export interface TentacleUnitArgs {
  /** Label/identity carrier for the escalation events (core seam shape). */
  node: TentacleOptions;
  /** Host agent kind — used for the unreachable-fallback result shape. */
  agent: TaskAgentKind;
  parentCwd: string;
  sessionId: string;
  /** One raw run. `escalation` present ⇒ this call IS the quality re-run. */
  run: (escalation?: QualityEscalationHint) => Promise<TentacleResult>;
  /** Existing telemetry channel (workbench event tail). Best-effort per core. */
  log?: (line: string) => void;
}

/**
 * Run one work unit through the K4.5 seam and return the RAW result of the
 * run that won (the re-run's on `replaced`, the original otherwise — a failed
 * re-run never destroys weak-but-usable work). Same dispatch shape as core's
 * `callTentacle`; the caller decides how `run` maps onto its own machinery.
 */
export async function runTentacleUnit(args: TentacleUnitArgs): Promise<TentacleResult> {
  let first: TentacleResult | undefined;
  let rerun: TentacleResult | undefined;
  const { outcome } = await runTentacleWithQualityEscalation({
    run: async (callArgs) => {
      const raw = await args.run(callArgs.escalation);
      if (callArgs.escalation) rerun = raw;
      else first = raw;
      return toHostTentacleResult(raw);
    },
    node: args.node,
    parentCwd: args.parentCwd,
    sessionId: args.sessionId,
    ...(args.log ? { log: args.log } : {}),
  });
  if (outcome === 'replaced' && rerun) return rerun;
  if (first) return first;
  // Contractually unreachable (the wrapper always performs the first run);
  // an honest failure beats returning undefined.
  return { ok: false, agent: args.agent, error: 'quality escalation executed no tentacle run' };
}
