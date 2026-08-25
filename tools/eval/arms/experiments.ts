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

/** §87/§84 — metrics an A/B report should always carry for guard arms. */
export const GUARD_AB_REPORT_METRICS = [
  'toolCalls',
  'retries',
  'guardWarnings',
  'durationMs',
  'passed',
] as const;
