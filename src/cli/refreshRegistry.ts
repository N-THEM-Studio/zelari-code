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
 * @see docs/plans/ (v3-F plan, 2026-06-29)
 */

import { refreshGrokToken, DEFAULT_GROK_OAUTH_CLIENT_ID } from './grokOAuth.js';
import { refreshChatgptToken } from './chatgptOAuth.js';
import { refreshAnthropicToken } from './anthropicOAuth.js';
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
  accountId?: string;
  idToken?: string;
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

export const chatgptRefreshAdapter: RefreshImpl = async (_providerId, refreshToken) => {
  return refreshChatgptToken({ refreshToken });
};

export const anthropicRefreshAdapter: RefreshImpl = async (_providerId, refreshToken) => {
  return refreshAnthropicToken({ refreshToken });
};

/**
 * Register the built-in default impls. Idempotent — calling multiple times
 * is a no-op once registered. Called at module init from keyStore.
 */
export function registerDefaultRefreshImpls(): void {
  if (!registry.has('grok')) registry.set('grok', grokRefreshAdapter);
  if (!registry.has('chatgpt')) registry.set('chatgpt', chatgptRefreshAdapter);
  if (!registry.has('anthropic')) registry.set('anthropic', anthropicRefreshAdapter);
}

/** Result shape shared by every refresh impl (mirrors `RefreshImpl`'s return). */
export interface RefreshResult {
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  accountId?: string;
  idToken?: string;
}

/**
 * Thrown when the upstream IdP rejects the refresh token (invalid_grant): the
 * stored credential is dead and the only fix is a fresh `/login <id>`.
 * Distinct from transient failures (network, 5xx, 429) where the stale access
 * token may still work and a later retry can succeed.
 *
 * Mirrors OpenClaw's refresh-token-reuse detection (MIT): refresh tokens are
 * single-use, so when two concurrent refreshes race, the loser receives
 * invalid_grant — without this signal the loser wrongly concludes "logged out".
 */
export class RefreshRejectedError extends Error {
  /** Marker callers can check without importing the class. */
  readonly reloginRequired = true;

  constructor(
    message: string,
    public readonly providerId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RefreshRejectedError';
  }
}

/** Type guard: did a refresh fail because the stored credential is dead? */
export function isRefreshRejected(err: unknown): err is RefreshRejectedError {
  if (err instanceof RefreshRejectedError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { reloginRequired?: unknown }).reloginRequired === true
  );
}

function normalizeRefreshError(providerId: string, err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'invalid_grant' || message.includes('invalid_grant')) {
    return new RefreshRejectedError(
      `${providerId}: refresh token rejected (invalid_grant) — run /login ${providerId} to re-authenticate`,
      providerId,
      err,
    );
  }
  return err;
}

/**
 * In-flight refresh per provider (OpenClaw-style serialization): concurrent
 * callers for the SAME provider share one impl call instead of racing two
 * refresh-token exchanges. Anthropic and OpenAI rotate refresh tokens on every
 * exchange, so an unserialized race burns one of the two tokens — the classic
 * reuse trap this map prevents.
 */
const inflightRefresh = new Map<string, Promise<RefreshResult>>();

/**
 * Run the registered refresh impl for `id`, serialized per provider.
 *
 * - No impl registered → throws the same "No refresh impl registered" error
 *   `defaultRefreshImpl` in keyStore used to produce (callers/tests match).
 * - Concurrent calls for the same provider id share the single in-flight
 *   exchange and observe the same outcome.
 * - `invalid_grant`-shaped failures are normalized to `RefreshRejectedError`
 *   so callers can tell "re-login required" apart from transient errors.
 */
export async function runRefreshImpl(id: ProviderName, refreshToken: string): Promise<RefreshResult> {
  const existing = inflightRefresh.get(id);
  if (existing) return existing;
  const impl = getRefreshImpl(id);
  if (!impl) {
    throw new Error(`No refresh impl registered for provider "${id}"`);
  }
  const run = Promise.resolve()
    .then(() => impl(id, refreshToken))
    .catch((err: unknown) => {
      throw normalizeRefreshError(id, err);
    }) as Promise<RefreshResult>;
  inflightRefresh.set(id, run);
  void run
    .finally(() => {
      if (inflightRefresh.get(id) === run) inflightRefresh.delete(id);
    })
    .catch(() => undefined);
  return run;
}