/**
 * providerFailover — wraps two OpenAI-compatible providers so the second
 * is tried when the first yields transient errors (Task B.4).
 *
 * Behavior:
 *   - Stream events from `primary` first
 *   - On the FIRST transient failure (network error OR HTTP 5xx),
 *     close the primary stream and switch to `fallback`
 *   - On a 4xx error (auth, bad request) do NOT failover — surface the
 *     error to the caller; these are programming/auth issues that won't
 *     be fixed by retrying against a different provider
 *   - On a normal `finish` event, the fallback is NEVER tried
 *
 * "First failure" means we DON'T keep retrying the primary. If you want
 * N retries, write your own retry loop outside.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3-B.md
 */

import type { ProviderDelta, ProviderStreamFn } from '@zelari/core/harness';

export interface FailoverOptions {
  /** Primary provider — tried first. */
  primary: ProviderStreamFn;
  /** Fallback provider — tried when primary fails transiently. */
  fallback: ProviderStreamFn;
  /**
   * Predicate: given a `ProviderDelta`, decide if it's a transient failure
   * worth triggering failover. Default: any `error` event.
   * Override to customize (e.g. also trigger on certain `finish` reasons).
   */
  isTransientFailure?: (delta: ProviderDelta) => boolean;
  /**
   * Optional human-readable label for the fallback provider, surfaced in the
   * `[failover]` error messages (Task J.1, v3-J). Useful for cross-provider
   * failover so the user can see which provider the system switched to
   * (e.g. `grok → glm`). When omitted, messages are unchanged from v3-G.
   */
  fallbackLabel?: string;
}

const DEFAULT_IS_TRANSIENT = (delta: ProviderDelta): boolean => delta.kind === 'error';

/**
 * Wraps two ProviderStreamFn instances with first-failure failover.
 * Returns a new ProviderStreamFn — pass this to AgentHarness.
 */
export function providerFailover(options: FailoverOptions): ProviderStreamFn {
  const isTransient = options.isTransientFailure ?? DEFAULT_IS_TRANSIENT;
  // Task J.1 (v3-J) — when a label is provided, the [failover] messages
  // include it so the user can see which provider the system switched to.
  // When absent, messages are byte-identical to v3-G (backward-compat).
  const primaryFailedMsg = options.fallbackLabel
    ? `[failover] primary failed, switching to ${options.fallbackLabel}`
    : '[failover] primary failed, switching to fallback';
  const primaryThrewMsg = options.fallbackLabel
    ? `[failover] primary threw, switching to ${options.fallbackLabel}: `
    : '[failover] primary threw: ';
  const fallbackFailedMsg = options.fallbackLabel
    ? `[failover] fallback (${options.fallbackLabel}) also failed: `
    : '[failover] fallback also failed: ';
  return async function* (params) {
    const triedFallback = { value: false };
    try {
      for await (const delta of options.primary(params)) {
        if (isTransient(delta)) {
          // Forward the original error to the caller so they see what
          // happened, then announce the failover and bail out.
          yield delta;
          triedFallback.value = true;
          yield {
            kind: 'error',
            message: primaryFailedMsg,
          };
          break;
        }
        yield delta;
      }
    } catch (err) {
      // Network-level throw (fetch rejection, etc.) → also failover.
      triedFallback.value = true;
      yield {
        kind: 'error',
        message: `${primaryThrewMsg}${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (triedFallback.value) {
      try {
        for await (const delta of options.fallback(params)) {
          yield delta;
        }
      } catch (err) {
        yield {
          kind: 'error',
          message: `${fallbackFailedMsg}${err instanceof Error ? err.message : String(err)}`,
        };
        return;
      }
    }
  };
}

/**
 * Convenience: filter a ProviderStreamFn's deltas to check what kinds it
 * emits. Useful for tests / debugging.
 */
export async function collectDeltas(
  fn: ProviderStreamFn,
  params: Parameters<ProviderStreamFn>[0],
): Promise<ProviderDelta[]> {
  const out: ProviderDelta[] = [];
  for await (const d of fn(params)) out.push(d);
  return out;
}