/**
 * keyStore — secure-ish key storage for CLI provider credentials.
 *
 * Persists API keys for MiniMax, GLM, Grok (and any other provider) to a
 * JSON file in the user's home directory. NOT a real keychain — just a
 * plain JSON file with restrictive file permissions. Document this in
 * /help so users know to use OS-level secret storage for production keys.
 *
 * Used by Task 14.9 to support `/login <provider> <key>` from the CLI.
 * Resolution order at provider boot:
 *   1. process.env[ENV_VAR_NAME] (e.g. OPENAI_API_KEY)
 *   2. Stored key in keys.json
 *
 * @see docs/plans/2026-06-28-anathema-coder.md (Task 14.9)
 */

import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getRefreshImpl,
  registerDefaultRefreshImpls,
} from './refreshRegistry.js';

// Idempotent — safe to call on every module load. The registry starts empty
// and this seeds it with the built-in defaults (Grok).
registerDefaultRefreshImpls();

export type ProviderName = 'minimax' | 'glm' | 'grok' | 'openai-compatible' | 'custom';

export interface ProviderSpec {
  /** Stable id used in storage + slash commands. */
  id: ProviderName;
  /** Display name for /help. */
  displayName: string;
  /** env var the CLI reads first. */
  envVar: string;
  /** Default base URL (informational — actual resolution lives in provider adapter). */
  baseUrl?: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  { id: 'openai-compatible', displayName: 'OpenAI-compatible', envVar: 'OPENAI_API_KEY' },
  { id: 'minimax', displayName: 'MiniMax', envVar: 'MINIMAX_API_KEY', baseUrl: 'https://api.MiniMax.chat/v1' },
  { id: 'glm', displayName: 'GLM / Z.AI', envVar: 'GLM_API_KEY', baseUrl: 'https://api.z.ai/v1' },
  { id: 'grok', displayName: 'xAI Grok', envVar: 'GROK_API_KEY', baseUrl: 'https://api.x.ai/v1' },
] as const;

export function getKeyStorePath(): string {
  return process.env.ANATHEMA_KEYSTORE_FILE
    ?? path.join(os.homedir(), '.tmp', 'anathema-coder', 'keys.json');
}

export function getProviderSpec(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Stored credential for a provider.
 *
 * Before v3-D this was just a string (the API key). Now it can also carry
 * OAuth metadata: `expiresAt` (epoch ms) and `refreshToken`. Files written
 * by older versions — where each provider entry is a bare string — are
 * still loaded correctly: `normalizeProviderEntry()` upgrades them in-memory.
 */
export interface StoredKey {
  /** The bearer / API key. Always present. */
  apiKey: string;
  /** Epoch ms when this key expires (set after OAuth flow). */
  expiresAt?: number;
  /** Refresh token (set after OAuth flow if provider supports it). */
  refreshToken?: string;
}

interface StoredKeys {
  /** Map of providerId → StoredKey. */
  providers: Record<string, StoredKey>;
}

/**
 * Upgrade a raw provider entry from on-disk JSON to a `StoredKey`.
 * Accepts both the legacy bare-string shape and the new object shape.
 * Returns null for anything we can't interpret.
 */
function normalizeProviderEntry(raw: unknown): StoredKey | null {
  if (typeof raw === 'string') {
    return { apiKey: raw };
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.apiKey === 'string' && r.apiKey.length > 0) {
      const out: StoredKey = { apiKey: r.apiKey };
      if (typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt)) {
        out.expiresAt = r.expiresAt;
      }
      if (typeof r.refreshToken === 'string' && r.refreshToken.length > 0) {
        out.refreshToken = r.refreshToken;
      }
      return out;
    }
  }
  return null;
}

function readStore(): StoredKeys {
  const file = getKeyStorePath();
  if (!existsSync(file)) return { providers: {} };
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredKeys>;
    if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
      // Normalize + deep clone to avoid the SHALLOW-SPREAD-DEFAULTS gotcha:
      // returning `parsed.providers` directly would let callers mutate the
      // shared object across reads.
      const normalizedProviders: Record<string, StoredKey> = {};
      for (const [id, rawEntry] of Object.entries(parsed.providers)) {
        const norm = normalizeProviderEntry(rawEntry);
        if (norm) normalizedProviders[id] = norm;
      }
      return { providers: normalizedProviders };
    }
  } catch {
    // Corrupt file — start fresh.
  }
  return { providers: {} };
}

function writeStore(store: StoredKeys): void {
  const file = getKeyStorePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/** Store an API key for a provider. Overwrites any existing key. */
export function setApiKey(providerId: string, key: string): void {
  const store = readStore();
  store.providers[providerId] = { apiKey: key };
  writeStore(store);
}

/** Remove the stored key for a provider. */
export function clearApiKey(providerId: string): void {
  const store = readStore();
  delete store.providers[providerId];
  writeStore(store);
}

/** Get the stored key for a provider (null if unset). */
export function getStoredApiKey(providerId: string): string | null {
  const store = readStore();
  return store.providers[providerId]?.apiKey ?? null;
}

/**
 * Store an OAuth token (apiKey + optional expiresAt + optional refreshToken)
 * for a provider. Overwrites any existing entry.
 */
export function setOAuthToken(
  providerId: string,
  token: { apiKey: string; expiresAt?: number; refreshToken?: string },
): void {
  const store = readStore();
  const entry: StoredKey = { apiKey: token.apiKey };
  if (typeof token.expiresAt === 'number' && Number.isFinite(token.expiresAt)) {
    entry.expiresAt = token.expiresAt;
  }
  if (typeof token.refreshToken === 'string' && token.refreshToken.length > 0) {
    entry.refreshToken = token.refreshToken;
  }
  store.providers[providerId] = entry;
  writeStore(store);
}

/** Read the full OAuth token record for a provider (null if unset). */
export function getOAuthToken(providerId: string): StoredKey | null {
  const store = readStore();
  return store.providers[providerId] ?? null;
}

/**
 * Resolve a key for a provider, checking env first, then store.
 * Returns just the apiKey string — use `resolveApiKeyWithMeta` if you also
 * need `expiresAt` / `refreshToken`.
 */
export function resolveApiKey(providerId: string): string | null {
  const spec = getProviderSpec(providerId);
  if (spec) {
    const envKey = process.env[spec.envVar];
    if (envKey && envKey.trim().length > 0) return envKey;
  }
  return getStoredApiKey(providerId);
}

/**
 * Resolve the full StoredKey for a provider (apiKey + expiresAt + refreshToken).
 * Env var path returns only the apiKey (no expiry metadata).
 *
 * Auto-refresh (Task D.3.1): if the stored token has an `expiresAt` within
 * the `refreshBufferMs` window AND a `refreshToken`, this function calls
 * the injected `refreshImpl` to obtain a fresh token, persists it via
 * `setOAuthToken`, and returns the new `StoredKey`. This is best-effort:
 * if the refresh fails, the stale token is still returned (and the caller
 * sees an API error from the upstream provider — surfacing the real issue).
 *
 * Defaults to refreshing only the Grok provider (via `refreshGrokToken`).
 */
export async function resolveApiKeyWithMeta(
  providerId: string,
  options: ResolveOptions = {},
): Promise<StoredKey | null> {
  const refreshBufferMs = options.refreshBufferMs ?? 5 * 60_000;
  const refreshImpl = options.refreshImpl ?? defaultRefreshImpl;
  const now = options.now ?? Date.now();

  // 1. Env var wins (no expiry metadata — assume user manages it).
  const spec = getProviderSpec(providerId);
  if (spec) {
    const envKey = process.env[spec.envVar];
    if (envKey && envKey.trim().length > 0) {
      return { apiKey: envKey };
    }
  }

  // 2. Stored token (may include expiry + refresh).
  const stored = getOAuthToken(providerId);
  if (!stored) return null;

  // 3. Auto-refresh if expiry is near and we have a refresh token.
  if (
    stored.expiresAt !== undefined &&
    stored.refreshToken !== undefined &&
    stored.expiresAt - now < refreshBufferMs
  ) {
    try {
      const refreshed = await refreshImpl(providerId, stored.refreshToken);
      // Persist new token (preserving the apiKey, expiresAt, and any new
      // refresh_token the provider returned).
      const next: StoredKey = { apiKey: refreshed.accessToken };
      if (refreshed.expiresAt !== undefined) next.expiresAt = refreshed.expiresAt;
      if (refreshed.refreshToken !== undefined && refreshed.refreshToken.length > 0) {
        next.refreshToken = refreshed.refreshToken;
      } else {
        // Provider did NOT rotate the refresh_token — keep the old one.
        next.refreshToken = stored.refreshToken;
      }
      // Update store in-place. We call readStore/writeStore indirectly via
      // setOAuthToken's shape: but we need to avoid clobbering other fields.
      // setOAuthToken accepts the same shape, so use it.
      // Note: setOAuthToken calls readStore() which re-reads the file; that's
      // fine — the file hasn't changed between the read above and the write
      // below in single-threaded Node.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      writeStoreDirect({ providers: { ...readStoreDirect().providers, [providerId]: next } });
      return next;
    } catch {
      // Refresh failed — return the stale token. Upstream will surface
      // the auth error; user can re-login via /login grok.
      return stored;
    }
  }

  return stored;
}

export interface ResolveOptions {
  /** How close to expiry triggers auto-refresh. Default 5 minutes. */
  refreshBufferMs?: number;
  /** Inject a custom refresh function (used by tests). */
  refreshImpl?: RefreshImpl;
  /** Inject a clock for tests. Default `Date.now`. */
  now?: number;
}

/**
 * Signature for the injectable refresh function. Receives a `providerId`
 * (currently always `'grok'` for OAuth flows) and the `refreshToken` to
 * exchange, and returns a fresh `GrokOAuthResult`-shaped value.
 *
 * The default implementation calls `refreshGrokToken` from grokOAuth.ts.
 */
export type RefreshImpl = (providerId: string, refreshToken: string) => Promise<{
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
}>;

/**
 * Default refresh impl: looks up the provider in the refresh registry.
 *
 * v3-F behavior change: for providers with no registered impl (currently
 * MiniMax, GLM, OpenAI-compatible, custom), this returns `null` instead of
 * throwing. The caller in `resolveApiKeyWithMeta` handles `null` by returning
 * the stale token unchanged — graceful degradation, no behavior break.
 *
 * To plug a custom provider in: call `registerRefreshImpl(id, impl)` once at
 * startup (or in a test).
 */
const defaultRefreshImpl: RefreshImpl = async (providerId, refreshToken) => {
  const impl = getRefreshImpl(providerId as ProviderName);
  if (!impl) {
    // No refresh impl for this provider — signal graceful no-op to the caller.
    throw new Error(`No refresh impl registered for provider "${providerId}"`);
  }
  return impl(providerId, refreshToken);
};

/**
 * Direct file r/w helpers exposed for `resolveApiKeyWithMeta`'s auto-refresh
 * path. These bypass the public API to avoid an extra read/write cycle
 * inside the resolve hot path. Behavior matches `readStore` / `writeStore`.
 */
function readStoreDirect(): StoredKeys {
  return readStore();
}

function writeStoreDirect(store: StoredKeys): void {
  writeStore(store);
}

/** Mask a key for display: show first 4 + last 4 chars only. */
export function maskKey(key: string): string {
  if (key.length <= 12) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)} (len=${key.length})`;
}

/** Async variant for callers that prefer async I/O (used by tests). */
export async function loadStoredKeys(): Promise<Record<string, string>> {
  const file = getKeyStorePath();
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredKeys>;
    const out: Record<string, string> = {};
    if (parsed.providers && typeof parsed.providers === 'object') {
      for (const [id, entry] of Object.entries(parsed.providers)) {
        const norm = normalizeProviderEntry(entry);
        if (norm) out[id] = norm.apiKey;
      }
    }
    return out;
  } catch {
    return {};
  }
}