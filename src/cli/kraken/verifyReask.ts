/**
 * verifyReask — t56: minimal one-shot re-ask for an `unknown` verify verdict.
 *
 * Problem
 * -------
 * When a reviewer's reply has no parseable verdict trailer, the executor
 * records the node as `unresolved` (reason 'unknown') and moves on — correct
 * per "unknown ≠ pass", but expensive in one specific way: the verdict was
 * almost certainly FORMULATED in the reply and only the trailer line got
 * mangled by prompt drift. Re-running the whole verify sub-agent pays a
 * second full review for one missing line.
 *
 * What this module does instead
 * -----------------------------
 * A single non-streaming chat completion, no tools, against the same
 * provider channel the CLI already uses (same resolution as the weakness
 * meter): hand the model its own prior output (tail-capped) and ask it to
 * emit ONLY the trailer it already supports. The reply is parsed with the
 * SAME single-source parser as the original verdict (`parseVerifyVerdict`
 * from @zelari/core) — no second grammar to drift.
 *
 * Guarantees:
 *   - capped at ONE call per unknown verdict (the caller enforces this);
 *   - default ON, opt-out via ZELARI_KRAKEN_VERIFY_REASK=0;
 *   - any failure (disabled, no key, HTTP error, unparseable reply)
 *     returns null and the existing unknown-flow is unchanged;
 *   - the verify node's raw `result` is NEVER rewritten by this module —
 *     audit sees what the reviewer actually emitted.
 *
 * Pattern follows `./weaknessMeter.ts` (provider resolution, timeout,
 * silent failure). No I/O at import time.
 *
 * @since v2.x — t56 re-ask minimal su verdetto unknown
 */

import { parseVerifyVerdict } from '@zelari/core';
import { getProviderConfig, getModelForProvider, getCustomEndpoint } from '../providerConfig.js';
import { resolveApiKeyWithMeta, type ProviderName } from '../keyStore.js';

/** Env flag. Default ON ('0' | 'false' | 'no' disables). */
export const VERIFY_REASK_ENV = 'ZELARI_KRAKEN_VERIFY_REASK';

/** Wall-clock budget for the single re-ask call. */
const REASK_TIMEOUT_MS = 12_000;

/** How much of the prior verify output we forward (trailer lives at the end). */
const PRIOR_OUTPUT_CAP_CHARS = 8_000;

const REASK_SYSTEM_PROMPT = [
  'You are a verdict-normalization helper.',
  'The message below is a code-review verify report whose final verdict trailer line is missing or malformed.',
  'Re-read the report and emit, as the LAST line, ONLY the verdict the report already supports:',
  '`VERDICT: PASS` or `VERDICT: FAIL`.',
  'Do not re-review the work, do not add commentary.',
  'If the report genuinely supports neither verdict, emit `VERDICT: UNKNOWN`.',
].join(' ');

/**
 * Whether the re-ask is enabled. Cheap; read per call (no memoization —
 * unlike the weakness meter this is not on a hot path).
 */
export function isVerifyReaskEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[VERIFY_REASK_ENV];
  if (raw === undefined || raw === '') return true; // default ON
  return !(raw === '0' || raw === 'false' || raw === 'no');
}

/** Injectable transport, mirroring `MeasureOptions` in weaknessMeter. */
export interface ReaskOptions {
  /** Override the fetch primitive (for tests). */
  fetchImpl?: typeof fetch;
  /** Override resolved provider/model/endpoint/key (for tests). */
  providerOverride?: {
    providerId: ProviderName;
    model: string;
    endpoint: string;
    apiKey: string;
  };
  /** Inject an env for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * One-shot trailer recovery. Returns `'pass' | 'fail'` when the model
 * restated a usable verdict, `null` otherwise (disabled / failed /
 * still unknown). Never throws.
 */
export async function reaskVerifyTrailer(
  priorOutput: string,
  options: ReaskOptions = {},
): Promise<'pass' | 'fail' | null> {
  const env = options.env ?? process.env;
  if (!isVerifyReaskEnabled(env)) return null;
  if (typeof priorOutput !== 'string' || priorOutput.trim() === '') return null;

  const provider = options.providerOverride ?? (await resolveActiveProvider(env));
  if (!provider) return null;

  // Tail-cap: the verdict trailer sits at the end of the report.
  const capped =
    priorOutput.length > PRIOR_OUTPUT_CAP_CHARS
      ? priorOutput.slice(priorOutput.length - PRIOR_OUTPUT_CAP_CHARS)
      : priorOutput;

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REASK_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(provider.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: REASK_SYSTEM_PROMPT },
            { role: 'user', content: capped },
          ],
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
    // Same single-source parser as the executor — no second grammar.
    const { verdict } = parseVerifyVerdict(raw);
    return verdict === 'pass' || verdict === 'fail' ? verdict : null;
  } catch {
    return null;
  }
}

/** Same on-disk provider resolution the weakness meter uses. */
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
    getCustomEndpoint(providerId) ?? `https://api.openai.com/v1/chat/completions`;
  return { providerId, model, endpoint, apiKey: key.apiKey };
}
