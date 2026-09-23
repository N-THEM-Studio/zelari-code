/**
 * qualityEscalation — K4.5 (F27): escalate on QUALITY, not only on error.
 *
 * Failure (F27, plan 2026-09-18): failover/retry only ever fired on execution
 * ERROR. A tentacle that RAN but produced a maximally weak, degenerate output
 * ("All done.", empty findings, vague claims) was accepted as-is — the quality
 * signals existed (weaknessMeter / reputation) but were purely informational.
 *
 * Contract (plan K4.5, DEFAULT OFF):
 *   - opt-in via `ZELARI_KRAKEN_QUALITY_ESCALATION=1`. With the flag off the
 *     wrapper is one env read + the plain run: no re-run, no scoring, no
 *     events (identical behavior to today).
 *   - flag ON: when a tentacle run SUCCEEDS but its output scores as weak
 *     (Bennett weakness >= threshold — same scale `parsePersonaVerdict` records
 *     as `PersonaVerdict.weaknessScore`), the work unit is re-run EXACTLY ONCE
 *     carrying a `QualityEscalationHint` telling the host to use the PARENT
 *     model. The re-run's output REPLACES the weak one.
 *   - anti-loop: cap = {@link QUALITY_ESCALATION_CAP} = 1 per work unit. A call
 *     that already carries the hint IS the re-run and is never escalated again
 *     (no recursion: the re-run goes straight to `run`, not back through here).
 *   - a FAILED re-run keeps the original output (weak-but-usable work is never
 *     destroyed) and the outcome is traced on the EXISTING telemetry channel
 *     (host.log → radio + workbench) with the stable guard code
 *     {@link QUALITY_ESCALATION_GUARD} — no new telemetry subsystem.
 *
 * Signals (real symbols only): the meter path uses `weaknessFromMeter`
 * (`WeaknessMeterResponse`, produced CLI-side by `src/cli/kraken/weaknessMeter.ts`);
 * the default path is `weaknessScoreFromText`, the very heuristic
 * `parsePersonaVerdict` folds into `PersonaVerdict.weaknessScore`. The
 * reputation signal (`src/cli/kraken/modelReputation.ts`) and the parent-model
 * routing (`src/cli/tools/krakenModel.ts`) are CLI-side and not reachable from
 * this package: the re-run REQUESTS the parent model via
 * `PlanHostBridge.runTentacle({ escalation })` and the host resolves it.
 *
 * Pure policy + one async orchestrator — no I/O beyond the injected `run`.
 *
 * @since v2.63.x — K4.5/F27 quality escalation (opt-in)
 */

import { weaknessFromMeter, weaknessScoreFromText, type WeaknessMeterResponse } from './weakness.js';
import type {
  HostTentacleResult,
  PlanHostBridge,
  QualityEscalationHint,
  TentacleOptions,
} from './runtime/types.js';

/** Opt-in env flag. Default OFF (flip only with data — lezione t57). */
export const QUALITY_ESCALATION_ENV = 'ZELARI_KRAKEN_QUALITY_ESCALATION';

/** Stable guard code for every escalation event (I4 vocabulary, greppable). */
export const QUALITY_ESCALATION_GUARD = 'quality_escalation';

/**
 * Weakness at or above this marks a degenerate claim ("weakness" is
 * `1 - specificity`: 1 = the output asserts nothing, 0 = pinned specifics).
 * 0.85 is maximally-weak territory: no specificity marker AND almost no
 * clauses. A substantive report sits well below it.
 */
export const QUALITY_WEAKNESS_THRESHOLD = 0.85;

/** Hard cap: at most ONE quality re-run per work unit (anti-loop). */
export const QUALITY_ESCALATION_CAP = 1;

/** True only under explicit opt-in (`=1|true|yes`). Never cached: a boolean. */
export function qualityEscalationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[QUALITY_ESCALATION_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export type QualityEscalationReason =
  /** Flag off: identical to today. */
  | 'disabled'
  /** This call IS the quality re-run (cap = 1): never escalate again. */
  | 'already-rerun'
  /** The run errored — that is failover's job (F27), not a quality signal. */
  | 'run-failed'
  /** Judged and above the weakness threshold. */
  | 'weak-output'
  /** Judged and specific enough to keep. */
  | 'strong-enough';

export interface QualityEscalationDecision {
  escalate: boolean;
  reason: QualityEscalationReason;
  /** Threshold in force for this decision. */
  threshold: number;
}

/**
 * The escalation policy, pure and total. Guard order encodes the cap:
 * `already-rerun` wins over any weakness score, so a weak re-run is never
 * re-escalated. `weaknessScore` is only read in the final branch (the wrapper
 * skips computing it entirely when a guard already fired).
 */
export function evaluateQualityEscalation(input: {
  enabled: boolean;
  /** False for an errored run (error failover owns that path). */
  ok: boolean;
  /** True when this run is itself the quality re-run. */
  alreadyRerun: boolean;
  /** Bennett weakness of the output in `[0, 1]` (higher = weaker). */
  weaknessScore: number;
  threshold?: number;
}): QualityEscalationDecision {
  const threshold = input.threshold ?? QUALITY_WEAKNESS_THRESHOLD;
  const decide = (escalate: boolean, reason: QualityEscalationReason): QualityEscalationDecision => ({
    escalate,
    reason,
    threshold,
  });
  if (!input.enabled) return decide(false, 'disabled');
  if (input.alreadyRerun) return decide(false, 'already-rerun');
  if (!input.ok) return decide(false, 'run-failed');
  return input.weaknessScore >= threshold ? decide(true, 'weak-output') : decide(false, 'strong-enough');
}

/**
 * Weakness of a tentacle output in `[0, 1]` (higher = weaker = lower quality).
 * A `weaknessMeter` response wins when present (the LLM meter is the
 * principled signal); otherwise the deterministic heuristic scan.
 * `scoreText` is the meter seam for callers that score differently (it must
 * keep the same direction: higher = weaker).
 */
export function outputWeaknessScore(
  output: { text?: string | null; meter?: WeaknessMeterResponse | null },
  scoreText: (text: string) => number = weaknessScoreFromText,
): number {
  if (output.meter) return weaknessFromMeter(output.meter);
  return scoreText(typeof output.text === 'string' ? output.text : '');
}

/** What the wrapper did about quality, per work unit. */
export type QualityEscalationOutcomeKind = 'none' | 'replaced' | 'kept-original';

export interface QualityEscalationOutcome {
  /** The result the caller must use (re-run output iff `outcome: 'replaced'`). */
  result: HostTentacleResult;
  outcome: QualityEscalationOutcomeKind;
  reason: QualityEscalationReason;
  threshold: number;
  /** Weakness of the FIRST output — present only when it was scored. */
  weaknessScore?: number;
  /** The hint carried by the single re-run, when one was attempted. */
  hint?: QualityEscalationHint;
  /** The re-run's raw result, when it returned one. */
  rerun?: HostTentacleResult;
}

export interface QualityEscalationRunArgs {
  /** The real dispatch (`PlanHostBridge['runTentacle']`). */
  run: PlanHostBridge['runTentacle'];
  node: TentacleOptions;
  parentCwd: string;
  sessionId: string;
  /** Present ⇒ this call IS the re-run: pass-through, never escalate again. */
  escalation?: QualityEscalationHint;
  /** Env seam for tests (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  threshold?: number;
  /** weaknessMeter seam — default: the `PersonaVerdict.weaknessScore` heuristic. */
  scoreText?: (text: string) => number;
  /** Existing telemetry channel (host.log → radio + workbench). Best-effort. */
  log?: (line: string) => void;
}

/**
 * Run one work unit with K4.5 quality escalation. With the flag off (default)
 * this is exactly `args.run(...)` — one env read more, nothing else. With the
 * flag on, a weak-but-ok output triggers at most ONE re-run requesting the
 * parent model (cap = {@link QUALITY_ESCALATION_CAP}); the re-run replaces the
 * weak output on success and is discarded on failure (original kept, event
 * traced). Never throws on telemetry, never recurses.
 */
export async function runTentacleWithQualityEscalation(
  args: QualityEscalationRunArgs,
): Promise<QualityEscalationOutcome> {
  const threshold = args.threshold ?? QUALITY_WEAKNESS_THRESHOLD;
  const first = await args.run({
    node: args.node,
    parentCwd: args.parentCwd,
    sessionId: args.sessionId,
    ...(args.escalation ? { escalation: args.escalation } : {}),
  });

  // DEFAULT OFF: one env read and out — no scoring, no second run, no events.
  if (!qualityEscalationEnabled(args.env ?? process.env)) {
    return { result: first, outcome: 'none', reason: 'disabled', threshold };
  }
  // Anti-loop (cap = 1): a call that already carries the hint IS the re-run.
  if (args.escalation) {
    return { result: first, outcome: 'none', reason: 'already-rerun', threshold };
  }
  // An errored run is error-failover's business; quality judges working output.
  if (!first.ok) {
    return { result: first, outcome: 'none', reason: 'run-failed', threshold };
  }

  const weaknessScore = outputWeaknessScore({ text: first.result }, args.scoreText);
  const decision = evaluateQualityEscalation({
    enabled: true,
    ok: true,
    alreadyRerun: false,
    weaknessScore,
    threshold,
  });
  if (!decision.escalate) {
    return { result: first, outcome: 'none', reason: decision.reason, threshold, weaknessScore };
  }

  const hint: QualityEscalationHint = {
    to: 'parent-model',
    reason: 'weak-output',
    weaknessScore,
    threshold,
  };
  const label = args.node.label;
  safeLog(
    args.log,
    buildQualityEscalationLine({ outcome: 'rerun', label, weaknessScore, threshold }),
  );

  let rerun: HostTentacleResult;
  try {
    rerun = await args.run({
      node: args.node,
      parentCwd: args.parentCwd,
      sessionId: args.sessionId,
      escalation: hint,
    });
  } catch (error) {
    safeLog(
      args.log,
      buildQualityEscalationLine({
        outcome: 'kept-original',
        label,
        weaknessScore,
        threshold,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { result: first, outcome: 'kept-original', reason: 'weak-output', threshold, weaknessScore, hint };
  }

  if (!rerun.ok) {
    safeLog(
      args.log,
      buildQualityEscalationLine({
        outcome: 'kept-original',
        label,
        weaknessScore,
        threshold,
        error: rerun.error ?? 're-run failed',
      }),
    );
    return { result: first, outcome: 'kept-original', reason: 'weak-output', threshold, weaknessScore, hint, rerun };
  }

  safeLog(
    args.log,
    buildQualityEscalationLine({ outcome: 'replaced', label, weaknessScore, threshold }),
  );
  return { result: rerun, outcome: 'replaced', reason: 'weak-output', threshold, weaknessScore, hint, rerun };
}

/**
 * One greppable telemetry line per escalation event (same shape as the
 * `[tool_schema_repair_*]` guard lines: bracketed guard code first).
 */
export function buildQualityEscalationLine(event: {
  outcome: 'rerun' | 'replaced' | 'kept-original';
  label: string;
  weaknessScore: number;
  threshold: number;
  error?: string;
}): string {
  const head = `[${QUALITY_ESCALATION_GUARD}]`;
  const who = `label=${JSON.stringify(event.label)}`;
  const score = `weakness=${event.weaknessScore.toFixed(2)} threshold=${event.threshold.toFixed(2)}`;
  switch (event.outcome) {
    case 'rerun':
      return `${head} rerun on parent model (weak output ${score}) ${who}`;
    case 'replaced':
      return `${head} replaced weak output (${score}) ${who}`;
    case 'kept-original':
      return `${head} kept original output (re-run failed: ${event.error ?? 'unknown'}) (${score}) ${who}`;
  }
}

/** Telemetry is best-effort: a throwing sink never blocks or mutates the run. */
function safeLog(log: ((line: string) => void) | undefined, line: string): void {
  if (!log) return;
  try {
    log(line);
  } catch {
    /* fail-open by contract (see emitSubagentMetrics) */
  }
}
