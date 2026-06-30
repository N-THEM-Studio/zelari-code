/**
 * keyValidator — minimal OpenAI-compatible key liveness probe (v3-F).
 *
 * Strategy: ping the provider's `/v1/models` endpoint with the resolved key.
 * This is the standard "is my API key alive?" probe for OpenAI-compatible
 * providers (MiniMax, GLM, Grok, openai-compatible, custom). All five
 * providers in `PROVIDERS` ship a `/v1/models` endpoint that:
 *   - 200 with a model list → key is valid
 *   - 401 → unauthorized (key revoked/expired)
 *   - 403 → forbidden (key lacks scope)
 *   - 5xx → upstream problem (we can't tell if the key is good)
 *   - network error / timeout → caller should retry
 *
 * Why a separate module: F.2 scope says key validation lives in its own file
 * so it can be invoked from:
 *   - `/provider <id> status` (manual user-driven check)
 *   - resolveApiKeyWithMeta (background check after a 401 — future, deferred)
 *   - tests (mock fetch)
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3-F.md (F.2)
 * @see electron/cli/keyStore.ts (ProviderSpec.baseUrl)
 */

import { getProviderSpec, type ProviderName } from './keyStore.js';

export type ValidateReason =
  | 'unauthorized'  // 401 — key is bad / revoked / expired
  | 'forbidden'     // 403 — key lacks required scope
  | 'unknown'       // 5xx or unexpected — can't tell
  | 'network'       // fetch threw or timed out
  | 'no_base_url';  // provider has no baseUrl — validation skipped

export interface ValidateResult {
  /** True if the key is confirmed working, OR validation was skipped. */
  ok: boolean;
  /** When `ok=false`, the failure category. */
  reason?: ValidateReason;
  /** Human-readable detail (HTTP status text, network error message). */
  detail?: string;
  /** True if validation was skipped because the provider has no baseUrl. */
  skipped?: boolean;
  /** HTTP status code, when we got a response. */
  status?: number;
  /** Wall-clock duration in ms (useful for telemetry). */
  durationMs?: number;
}

export interface ValidateOptions {
  /** Override the probe endpoint (default: `${baseUrl}/v1/models`). */
  probeUrl?: string;
  /** Request timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Inject fetch for tests. Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Inject a clock for tests (epoch ms). Default: Date.now. */
  now?: () => number;
}

/**
 * Validate an API key by pinging the provider's models endpoint.
 *
 * Returns `{ ok: true, skipped: true }` for providers without a baseUrl
 * (openai-compatible / custom when no customEndpoint is set — handled by the
 * caller via `getCustomEndpoint`). For now, those providers are skipped.
 *
 * @throws Never — every failure is encoded in the returned `ValidateResult`.
 */
export async function validateApiKey(
  providerId: ProviderName,
  apiKey: string,
  options: ValidateOptions = {},
): Promise<ValidateResult> {
  const start = (options.now ?? Date.now)();
  const spec = getProviderSpec(providerId);
  if (!spec || !spec.baseUrl) {
    return { ok: true, skipped: true, reason: 'no_base_url' };
  }
  const probeUrl = options.probeUrl ?? `${spec.baseUrl.replace(/\/+$/, '')}/models`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  // AbortController for timeout — AbortSignal.timeout is not available on all
  // Node 18 builds, so use the explicit controller form.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(probeUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const durationMs = (options.now ?? Date.now)() - start;
    const status = response.status;
    if (status >= 200 && status < 300) {
      return { ok: true, status, durationMs };
    }
    if (status === 401) {
      return { ok: false, reason: 'unauthorized', status, detail: `HTTP 401`, durationMs };
    }
    if (status === 403) {
      return { ok: false, reason: 'forbidden', status, detail: `HTTP 403`, durationMs };
    }
    return { ok: false, reason: 'unknown', status, detail: `HTTP ${status}`, durationMs };
  } catch (err) {
    const durationMs = (options.now ?? Date.now)() - start;
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = controller.signal.aborted;
    return {
      ok: false,
      reason: isAbort ? 'network' : 'network',
      detail: isAbort ? `timeout after ${timeoutMs}ms` : msg,
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}