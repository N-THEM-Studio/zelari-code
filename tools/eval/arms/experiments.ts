/**
 * tools/eval/arms/experiments.ts — ready-made A/B arm presets (upgrade doc
 * §83 model routing, §87 guard A/B). Arms are env diffs; pass them to
 * runExperiment() with your own EvalCase fixtures.
 *
 * NOTE on §88 (Context A/B): deliberately NOT defined here. Context Engine
 * v2 projection is currently a library seam (parentContextForRole) with no
 * runtime env switch yet — defining an arm for a non-existent flag would
 * produce a silently identical B arm. Add `contextAbArms()` once the CLI
 * exposes a projection toggle.
 */

import type { EvalArm } from './types.ts';

/** §87 — runtime guards OFF vs ON (observer bus default set). */
export function guardAbArms(): EvalArm[] {
  return [
    { id: 'guards-off', env: { ZELARI_RUNTIME_OBSERVERS: '0' } },
    { id: 'guards-on', env: { ZELARI_RUNTIME_OBSERVERS: '1' } },
  ];
}

/**
 * Token-efficiency audit (2026-09-25). `pre-audit` restores the request shape
 * before the audit (every tool schema, pretty JSON tool results); `default`
 * is today's request (tool offload + compact tool results); the flagged lean
 * prompt rides on top of it. Keep a change only if cost per PASSED case drops
 * and pass rate, tool failures and model calls per case do not regress beyond
 * noise (see the audit report's test plan). Every arm pins every key so an
 * inherited value cannot leak into another arm.
 */
export function tokenEfficiencyArms(): EvalArm[] {
  const off = { ZELARI_TOOL_OFFLOAD: '0', ZELARI_TOOL_RESULT_FORMAT: 'json', ZELARI_PROMPT_PROFILE: '' };
  const on = { ZELARI_TOOL_OFFLOAD: '', ZELARI_TOOL_RESULT_FORMAT: '', ZELARI_PROMPT_PROFILE: '' };
  return [
    { id: 'pre-audit', env: off },
    { id: 'no-offload', env: { ...on, ZELARI_TOOL_OFFLOAD: '0' } },
    { id: 'json-results', env: { ...on, ZELARI_TOOL_RESULT_FORMAT: 'json' } },
    { id: 'default', env: on },
    { id: 'lean-prompt', env: { ...on, ZELARI_PROMPT_PROFILE: 'lean' } },
  ];
}

/**
 * §83 — all-lead (routing cleared via '' → key removed) vs routed.
 * Model ids are inputs, never hardcoded placeholders.
 */
export function modelRoutingArms(models: {
  explore: string;
  general: string;
  verify: string;
}): EvalArm[] {
  return [
    {
      id: 'all-lead',
      env: {
        ZELARI_KRAKEN_EXPLORE_MODEL: '',
        ZELARI_KRAKEN_GENERAL_MODEL: '',
        ZELARI_KRAKEN_VERIFY_MODEL: '',
      },
    },
    {
      id: 'routed',
      env: {
        ZELARI_KRAKEN_EXPLORE_MODEL: models.explore,
        ZELARI_KRAKEN_GENERAL_MODEL: models.general,
        ZELARI_KRAKEN_VERIFY_MODEL: models.verify,
      },
    },
  ];
}

/**
 * K4.6/F28 — lead-model swap (baseline vs candidate) for
 * tools/eval/runModelSwap.ts. `--model` is per-experiment (runner.ts), so the
 * swapped lead model MUST ride the arm env diff: `OPENAI_MODEL` is
 * providerConfig's env override and always wins over file/defaults
 * (applyEnvOverrides → modelByProvider[activeProviderId]). `model` is manifest
 * metadata. Tentacle routing is NOT touched — the lead swap is the measured
 * variable; compose with modelRoutingArms()/modelPinEnv() when the whole
 * channel must follow the lead. Model ids are inputs, never placeholders.
 */
export function leadModelSwapArms(models: { baseline: string; candidate: string }): EvalArm[] {
  return [
    {
      id: 'lead-baseline',
      model: models.baseline,
      env: { OPENAI_MODEL: models.baseline },
    },
    {
      id: 'lead-candidate',
      model: models.candidate,
      env: { OPENAI_MODEL: models.candidate },
    },
  ];
}

/**
 * K4.6/F28 — degradation GUARD CODES an A/B / model-swap report must carry.
 * Plan F28: `tool_call_truncated`, `text_tools_parse_failed`,
 * `assistant_text_loop`… used to vanish from the arms metrics, so a model swap
 * could silently degrade and the comparison never showed it. The typed family
 * matches the ContextProjector error-code regex (incl. K4.1's
 * `tool_args_parse_failed`).
 */
export const GUARD_AB_REPORT_GUARD_CODES = [
  'tool_args_parse_failed',
  'tool_call_truncated',
  'text_tools_parse_failed',
  'assistant_text_loop',
] as const;

/**
 * §87/§84 — metrics an A/B report should always carry for guard arms.
 * K4.6/F28: the guard codes ride the report metrics too (plan F28).
 */
export const GUARD_AB_REPORT_METRICS = [
  'toolCalls',
  'retries',
  'guardWarnings',
  'durationMs',
  'passed',
  ...GUARD_AB_REPORT_GUARD_CODES,
] as const;
