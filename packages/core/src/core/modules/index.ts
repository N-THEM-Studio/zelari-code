/**
 * core/modules — agent-loop policy modules.
 *
 * Each module is self-contained and provider-neutral; the harness consults
 * them at explicit points (see AgentHarness) instead of embedding the policy
 * in the loop body.
 *
 * - runaway-guard: identical-repetition warn + no-progress stall abort.
 * - system-reminder: pure reminder builder (contextual todo/budget nudge).
 *
 * @since v2.51.0
 */
export * from './runaway-guard/index.js';
export * from './system-reminder/index.js';
