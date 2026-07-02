/**
 * refreshRegistry — pluggable per-provider token refresh impls (v3-F).
 *
 * Why: v3-D hard-wired refresh support for Grok only. Other providers (MiniMax,
 * GLM) ship static API keys today and have no public OAuth endpoint. When that
 * changes, callers want to add a refresh impl without touching keyStore or the
 * auto-refresh path in `resolveApiKeyWithMeta`.
 *
 * Design:
 * - A simple `Map<ProviderName, RefreshImpl>` plus helpers.
 * - The default impl for `grok` is registered at module import time via
 *   `registerDefaultRefreshImpls()` (idempotent — safe to call multiple times).
 * - `getRefreshImpl(id)` returns the registered impl OR `null`. Callers are
 *   responsible for the "no impl" branch — typically log + return stale token.
 * - `registerRefreshImpl(id, impl)` lets tests and future providers inject
 *   custom impls without depending on this module's internals.
 *
 * The adapter for Grok (`grokRefreshAdapter`) bridges the
 * `(providerId, refreshToken) => Promise<{...}>` shape required by `RefreshImpl`
 * with `refreshGrokToken`'s `{clientId, refreshToken}` shape. It pulls
 * `GROK_OAUTH_CLIENT_ID` from env at call time (so tests can mutate it).
 *
 * @see electron/cli/keyStore.ts (RefreshImpl type, resolveApiKeyWithMeta)
 * @see docs/plans/2026-06-29-anathema-coder-v3-F.md
 */

import { refreshGrokToken, DEFAULT_GROK_OAUTH_CLIENT_ID } from './grokOAuth.js';
import type { ProviderName } from './keyStore.js';

/**
 * Pluggable refresh impl shape — matches `RefreshImpl` in keyStore.ts.
 *
 * Returning a value with `expiresAt` and/or `refreshToken` is OPTIONAL — the
 * resolver in keyStore tolerates both being absent (the existing refresh_token
 * is preserved, and the access_token is replaced unconditionally).
 */
export type RefreshImpl = (
  providerId: string,
  refreshToken: string,
) => Promise<{
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
}>;

const registry = new Map<ProviderName, RefreshImpl>();

/**
 * Register a refresh impl for a provider. Overwrites any previous impl.
 * Pass `null` or use `unregisterRefreshImpl` to remove.
 */
export function registerRefreshImpl(id: ProviderName, impl: RefreshImpl | null): void {
  if (impl === null) {
    registry.delete(id);
  } else {
    registry.set(id, impl);
  }
}

/** Remove a refresh impl. No-op if not registered. */
export function unregisterRefreshImpl(id: ProviderName): void {
  registry.delete(id);
}

/** Look up a refresh impl. Returns `null` if no impl is registered. */
export function getRefreshImpl(id: ProviderName): RefreshImpl | null {
  return registry.get(id) ?? null;
}

/** Return all registered provider ids (useful for /provider status). */
export function listRefreshImpls(): ProviderName[] {
  return Array.from(registry.keys());
}

/** Test-only helper: wipe the registry. Production code should not call this. */
export function clearRefreshRegistry(): void {
  registry.clear();
}

/**
 * Adapter from `refreshGrokToken({clientId, refreshToken})` to the generic
 * `RefreshImpl(providerId, refreshToken)` shape. Reads GROK_OAUTH_CLIENT_ID
 * from env at call time so tests can override, falling back to the same
 * built-in public client id the `/login grok` OAuth flow uses — the refresh
 * MUST use the client the token was issued to, and users who logged in with
 * the default client have no env var set.
 */
export const grokRefreshAdapter: RefreshImpl = async (
  _providerId,
  refreshToken,
) => {
  const envClientId = process.env.GROK_OAUTH_CLIENT_ID;
  const clientId = envClientId && envClientId.trim().length > 0
    ? envClientId
    : DEFAULT_GROK_OAUTH_CLIENT_ID;
  return refreshGrokToken({ clientId, refreshToken });
};

/**
 * Register the built-in default impls. Idempotent — calling multiple times
 * is a no-op once registered. Called at module init from keyStore.
 */
export function registerDefaultRefreshImpls(): void {
  if (!registry.has('grok')) {
    registry.set('grok', grokRefreshAdapter);
  }
}