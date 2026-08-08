/**
 * weaknessMeter — LLM-as-weakness-meter wiring for the Kraken Spec Council.
 *
 * Background
 * ----------
 * The `WEAKNESS_METER_PROMPT` exported by `@zelari/core/weakness` asks a
 * counter-LLM to enumerate the specific assumptions a reviewer made in
 * a verify / spec / conformance reply. The result is a JSON object
 * `{"specificity": 0..1, "assumptions": [...]}`. The inverse of
 * specificity is the Bennett weakness score (1 = maximally general, 0
 * = maximally specific).
 *
 * Until this module existed, the only weakness signal came from the
 * local heuristic in `weaknessFromVerdict` (a regex scan over the same
 * text). The heuristic is cheap (no I/O) and good enough for the
 * default render, but a true LLM meter is more precise at distinguishing
 * "vague assertion" from "specific claim with no markers in the body".
 *
 * This module is opt-in: it does nothing unless
 * `ZELARI_KRAKEN_WEAKNESS_METER=1`. When enabled, the caller invokes
 * {@link measureWeaknessViaLLM} with the persona's free text; the call
 * is a single non-streaming chat completion against the active
 * provider, with a short timeout and silent failure (the local
 * heuristic is always available as a fallback).
 *
 * No I/O happens at import time. Pure side effects live in the helper
 * functions; both are async and unit-testable through dependency
 * injection of the fetch primitive.
 *
 * @since v1.31.x - Bennett's Razor meter wiring (Slice N+1 / CLI)
 */

import {
  WEAKNESS_METER_PROMPT,
  WeaknessMeterResponseSchema,
  type WeaknessMeterResponse,
  weaknessFromMeter,
} from '@zelari/core';
import { getProviderConfig, getModelForProvider, getCustomEndpoint } from '../providerConfig.js';
import { resolveApiKeyWithMeta, type ProviderName } from '../keyStore.js';

/**
 * Whether the meter is enabled. The check is cheap and the result is
 * memoized per process so we don't re-read `process.env` on every call.
 */
let meterEnabledCache: boolean | null = null;
export function isWeaknessMeterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (meterEnabledCache !== null) return meterEnabledCache;
  const raw = env.ZELARI_KRAKEN_WEAKNESS_METER;
  const enabled = raw === '1' || raw === 'true' || raw === 'yes';
  meterEnabledCache = enabled;
  return enabled;
}

/** For tests: clear the memoized env read. */
export function _resetWeaknessMeterCacheForTests(): void {
  meterEnabledCache = null;
}

/**
 * Override model for the meter. Falls back to the active provider's
 * default model when unset. Exposed as a knob because the meter is a
 * single-shot classification call — a smaller / cheaper model is
 * usually fine and saves latency on a long run.
 */
function resolveMeterModel(env: NodeJS.ProcessEnv = process.env, fallback: string): string {
  const raw = env.ZELARI_KRAKEN_WEAKNESS_METER_MODEL;
  if (raw && raw.trim() !== '') return raw.trim();
  return fallback;
}

/** Wall-clock budget for a single meter call. Default 12s. */
const METER_TIMEOUT_MS = (() => {
  const raw = process.env.ZELARI_KRAKEN_WEAKNESS_METER_TIMEOUT_MS;
  if (!raw) return 12_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 12_000;
})();

/** Shape returned to the caller. `null` when the meter is disabled
 *  or the LLM call failed — both cases fall through to the local
 *  heuristic, never to a hard error. */
export interface MeterOutcome {
  /** Result parsed from the model — the raw meter payload. */
  meter: WeaknessMeterResponse;
  /** Bennett weakness = 1 - specificity, in [0, 1]. */
  weakness: number;
  /** Wall-clock duration of the underlying HTTP call (ms). */
  durationMs: number;
  /** Which model the meter ran against (for debugging / audit). */
  model: string;
}

/**
 * Result of {@link measureWeaknessViaLLM}. `null` means "the meter is
 * disabled OR failed; the caller should use the local heuristic".
 */
export type MeterResult = MeterOutcome | null;

/**
 * Run the LLM meter against `text` (the persona's free reply) and
 * return the parsed result. Silent on any failure — the meter is a
 * quality booster, never a hard dependency.
 *
 * Pure of side effects at the module level: the only I/O is the single
 * HTTP call inside the helper. For tests, pass a `fetchImpl` to stub
 * the network and a `providerOverride` to skip the on-disk provider
 * resolution.
 */
export interface MeasureOptions {
  /** Override the fetch primitive (for tests). */
  fetchImpl?: typeof fetch;
  /** Override the resolved provider / model / endpoint / api key
   *  (for tests). When omitted, the meter reads from the active
   *  provider config and key store. */
  providerOverride?: {
    providerId: ProviderName;
    model: string;
    endpoint: string;
    apiKey: string;
  };
  /** Inject an env for tests. */
  env?: NodeJS.ProcessEnv;
  /** Override the meter model independently of the active provider. */
  modelOverride?: string;
}

export async function measureWeaknessViaLLM(
  text: string,
  options: MeasureOptions = {},
): Promise<MeterResult> {
  const env = options.env ?? process.env;
  if (!isWeaknessMeterEnabled(env)) return null;
  if (typeof text !== 'string' || text.trim() === '') return null;

  // Resolve provider + model + key.
  const provider = options.providerOverride ?? (await resolveActiveProvider(env));
  if (!provider) return null;
  const model = options.modelOverride ?? resolveMeterModel(env, provider.model);

  // Compose the prompt. We ask the model to score THIS text (the
  // persona's free reply) — not the whole transcript — because the
  // meter is per-message.
  const userPayload = JSON.stringify({
    task: 'measure weakness of the following reviewer reply',
    reply: text,
  });

  const start = Date.now();
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), METER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(provider.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: WEAKNESS_METER_PROMPT },
            { role: 'user', content: userPayload },
          ],
          // The meter is a classification call; no need for a hot
          // sampling distribution. Most providers accept this pair
          // without complaint; the few that require it get a stable
          // answer.
          temperature: 0,
          stream: false,
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return null;
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') return null;
    return parseMeterContent(raw, model, Date.now() - start);
  } catch {
    return null;
  }
}

/**
 * Parse the model output, accept either a raw JSON object or a
 * fenced ```json ... ``` block (the meter prompt asks for JSON only,
 * but a model may still wrap). Return null on any parse failure.
 *
 * Exported (not just internal) so the unit tests can exercise the
 * parser without re-implementing the JSON / fence handling.
 */
export function parseMeterContent(raw: string, model: string, durationMs: number): MeterResult {
  const trimmed = raw.trim();
  // Strip an optional ```json fence.
  const fenced = /^```(?:json)?\s*([\s\S]+?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1]! : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const validated = WeaknessMeterResponseSchema.safeParse(parsed);
  if (!validated.success) return null;
  return {
    meter: validated.data,
    weakness: weaknessFromMeter(validated.data),
    durationMs,
    model,
  };
}

/**
 * Resolve the active provider configuration for the meter call. Reads
 * the same on-disk / env provider config the rest of the CLI uses so
 * the meter routes through the same channel the user already paid for.
 * Returns null when no provider / key can be resolved.
 */
async function resolveActiveProvider(env: NodeJS.ProcessEnv): Promise<
  | { providerId: ProviderName; model: string; endpoint: string; apiKey: string }
  | null
> {
  const cfg = await getProviderConfig();
  if (!cfg) return null;
  const providerId = cfg.activeProviderId;
  const key = await resolveApiKeyWithMeta(providerId, env);
  if (!key?.apiKey) return null;
  const model =
    getModelForProvider(providerId) ?? cfg.modelByProvider[providerId] ?? '';
  const endpoint =
    getCustomEndpoint(providerId) ??
    `https://api.openai.com/v1/chat/completions`;
  return { providerId, model, endpoint, apiKey: key.apiKey };
}
