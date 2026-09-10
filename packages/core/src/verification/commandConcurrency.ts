/**
 * verification/commandConcurrency.ts — Int2a gate fan-out policy (ADR-0023).
 *
 * A criteria pack runs independent PROCESSES (typecheck / test / build) that
 * are not independent WRITES: on this repo `test` rebuilds `@zelari/core` into
 * `packages/core/dist` while `build` cleans the very same path, so a parallel
 * run can read a partial `dist` and produce flaky FAILs. Fail-closed is not
 * good enough — a flaky gate destroys trust in strict-done exactly like a
 * false PASS does, so fan-out is OPT-IN per repo and OFF by default.
 *
 *   ZELARI_VERIFY_PARALLEL     1|true|yes|on → bounded parallel evaluation of
 *                              command criteria (anything else → sequential)
 *   ZELARI_VERIFY_CONCURRENCY  max commands in flight, default 3
 *
 * Kill-switch: unset, `0` or any unrecognized value → 1, i.e. the sequential
 * `for...of` path this engine has always used (same order, same events).
 *
 * @since v2.38.x
 */

/** Only used when parallelism is explicitly enabled and no limit is given. */
export const DEFAULT_COMMAND_CONCURRENCY = 3;

const PARALLEL_TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Parallel evaluation is opt-in: `1|true|yes|on` (case/space insensitive)
 * enables it, everything else — including unset — keeps the gate sequential.
 */
export function isVerifyParallelEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.ZELARI_VERIFY_PARALLEL?.trim().toLowerCase();
  return raw !== undefined && PARALLEL_TRUTHY.has(raw);
}

/**
 * Effective max number of command criteria in flight: `1` unless parallelism
 * is enabled. `ZELARI_VERIFY_CONCURRENCY` is only consulted when enabled and
 * is clamped to >= 1 (a bad value can never deadlock or fan out unbounded —
 * the runner additionally clamps to the number of criteria).
 */
export function resolveCommandConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  if (!isVerifyParallelEnabled(env)) return 1;
  const raw = Number(env.ZELARI_VERIFY_CONCURRENCY);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_COMMAND_CONCURRENCY;
  return Math.floor(raw);
}
