/**
 * crossProviderFailover — pure helpers for resolving the failover fallback
 * stream based on the `ANATHEMA_FAILOVER_PROVIDER` env var (Task J.2, v3-J).
 *
 * Extracted from `app.tsx` `dispatchPrompt` so the resolution logic is
 * testable without booting React/Ink. The wire site (`app.tsx`) calls
 * `resolveFailoverStream(...)` once per prompt and passes the resulting
 * stream + label to `providerFailover(...)`.
 *
 * Design:
 *   - All configuration flows in via a single `ResolveOptions` object.
 *   - The async `lookupFallbackConfig(id)` dependency is injected so tests
 *     can pass a stub without touching the real keyStore/providerConfig.
 *   - When `ANATHEMA_FAILOVER=0`, the helper returns `primary` untouched
 *     (master kill-switch from v3-G).
 *   - When the env var is unset / empty / unknown / missing key / same as
 *     primary, the helper returns `primary` as the fallback (v3-G
 *     behavior) and surfaces the reason via the returned `warning`.
 *   - When the env var resolves to a usable second provider, the helper
 *     returns the second stream with a label.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3-J.md
 */

import type { ProviderStreamFn } from '@zelari/core/harness';

export interface ResolveOptions {
  /** Master kill-switch (v3-G). When false, return primary unchanged. */
  failoverEnabled: boolean;
  /** Raw value of `ANATHEMA_FAILOVER_PROVIDER` (may be undefined or empty). */
  envValue: string | undefined;
  /** Provider id of the primary stream (for "same as primary" detection). */
  primaryProviderId: string;
  /** Primary stream (also returned as fallback for v3-G behavior). */
  primary: ProviderStreamFn;
  /** All known provider ids (typically `PROVIDERS.map(p => p.id)`). */
  validProviderIds: readonly string[];
  /**
   * Async lookup for the requested fallback provider's `OpenAICompatibleConfig`.
   * Returns null when no API key is configured (mirrors `providerConfigFor`
   * in `openai-compatible.ts`). The factory passed to this function does
   * NOT need to build the stream — only resolve the config.
   */
  lookupFallbackConfig: (providerId: string) => Promise<unknown>;
  /** Builds a `ProviderStreamFn` for a given provider config. */
  buildStream: (config: unknown) => ProviderStreamFn;
}

export interface ResolveResult {
  /** Stream to use as the fallback (always the primary for v3-G paths). */
  fallback: ProviderStreamFn;
  /**
   * Label to surface in [failover] messages. When undefined, providerFailover
   * uses its v3-G messages (byte-identical backward-compat).
   */
  fallbackLabel: string | undefined;
  /**
   * Human-readable warning surfaced to the user (e.g. unknown provider id).
   * Empty string means no warning.
   */
  warning: string;
  /**
   * Diagnostic reason for the resolution outcome. Useful for tests.
   * One of: 'disabled' | 'unset' | 'unknown' | 'same-as-primary'
   *       | 'missing-key' | 'resolved'.
   */
  reason:
    | 'disabled'
    | 'unset'
    | 'unknown'
    | 'same-as-primary'
    | 'missing-key'
    | 'resolved';
}

/**
 * Pure resolver for the failover fallback stream. Side-effect free: takes
 * everything via `options`, returns a `ResolveResult`. Tests can stub the
 * `lookupFallbackConfig` and `buildStream` functions to simulate any
 * provider configuration without booting the full CLI.
 */
export async function resolveFailoverStream(
  options: ResolveOptions,
): Promise<ResolveResult> {
  if (!options.failoverEnabled) {
    return {
      fallback: options.primary,
      fallbackLabel: undefined,
      warning: '',
      reason: 'disabled',
    };
  }
  const requested = options.envValue?.trim();
  if (!requested || requested.length === 0) {
    return {
      fallback: options.primary,
      fallbackLabel: undefined,
      warning: '',
      reason: 'unset',
    };
  }
  const valid = new Set<string>(options.validProviderIds);
  if (!valid.has(requested)) {
    return {
      fallback: options.primary,
      fallbackLabel: undefined,
      warning:
        `[failover] ANATHEMA_FAILOVER_PROVIDER="${requested}" is not a known provider. ` +
        `Falling back to v3-G same-provider behavior. Available: ${options.validProviderIds.join(', ')}.`,
      reason: 'unknown',
    };
  }
  if (requested === options.primaryProviderId) {
    return {
      fallback: options.primary,
      fallbackLabel: undefined,
      warning: '',
      reason: 'same-as-primary',
    };
  }
  const fallbackConfig = await options.lookupFallbackConfig(requested);
  if (!fallbackConfig) {
    return {
      fallback: options.primary,
      fallbackLabel: undefined,
      warning:
        `[failover] No API key configured for provider "${requested}". ` +
        `Falling back to v3-G same-provider behavior.`,
      reason: 'missing-key',
    };
  }
  return {
    fallback: options.buildStream(fallbackConfig),
    fallbackLabel: requested,
    warning: '',
    reason: 'resolved',
  };
}
