/**
 * Context meter math — the honesty kernel behind the session strip's
 * "ctx ~N%" readout (KrakenContextPanel).
 *
 * One rule: the CLI spine's budget event (the `harness_state` context
 * projection — occupancy + contextLimit, the same source as the
 * "budget N% policy" line) is the ONLY authoritative signal. Everything
 * else — chars/4, measured turn tokens, the last prompt size — is a
 * proxy and renders with an explicit "est." tag. The 200k default window
 * is a fallback denominator and tags the readout as estimated too. A
 * stale or missing budget event never renders as silent precision.
 *
 * Pure and DOM-free so the exact bug it closes (64k real tokens on a 200k
 * model showing ~100%) stays pinned by unit tests.
 */
import {
  DEFAULT_CONTEXT_LIMIT,
  contextLevel,
  type ContextLevel,
} from "./components/TurnStatsCard";

/**
 * Budget data from the LAST spine context projection carrying occupancy
 * (normalized by harnessState/normalize.ts as support.lastOccupancy et al.).
 */
export interface SpineOccupancy {
  /** 0–1 occupancy of the real context window (budget pipeline). */
  occupancy: number;
  /** Real model window the occupancy was computed against, when carried. */
  contextLimit?: number;
  /** Date.now() when the harness-state event arrived (freshness clock). */
  receivedAt: number;
}

export interface ContextMeterInput {
  /** Authoritative budget event, when one exists. */
  spine?: SpineOccupancy | null;
  /** Best proxy numerator: max(chars/4, measured turn tokens, last prompt size). */
  proxyTokens?: number;
  /**
   * Real window of the selected model when the desktop knows it (provider
   * config). No desktop-side source today — the spine event carries the
   * real limit instead. Kept as a parameter so a future source plugs in.
   */
  modelContextLimit?: number;
  /** Denominator of last resort (DEFAULT_CONTEXT_LIMIT) — renders as est. */
  fallbackLimit?: number;
  /** Freshness reference (Date.now() at render). */
  now: number;
  /** Spine data older than this falls back to the labeled proxy. */
  maxAgeMs?: number;
}

export type ContextMeterSource = "spine" | "proxy";

export interface ContextMeterResult {
  /** 0–100, one-decimal precision, clamped. */
  pct: number;
  /** Denominator actually used. */
  limit: number;
  /** True when `limit` is the fallback default, not a known real window. */
  limitEstimated: boolean;
  /** True when the readout is a proxy or sits on a fallback limit → "est.". */
  estimated: boolean;
  /** Which numerator won. */
  source: ContextMeterSource;
  /** Bar tone (ok / growing / compact / hard) for the meter fill. */
  level: ContextLevel;
  /** One-line source-of-truth explanation for the card tooltip. */
  tooltip: string;
}

/**
 * A budget event older than this is treated as stale: the strip switches
 * to the labeled proxy instead of parroting a possibly outdated occupancy.
 */
export const DEFAULT_SPINE_MAX_AGE_MS = 10 * 60 * 1000;

function finitePositive(n: number | undefined | null): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** 0–1 occupancies only; anything else is malformed → not admissible. */
function admissibleOccupancy(n: number | undefined | null): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

function limitSuffix(limitEstimated: boolean): string {
  return limitEstimated
    ? `window ${DEFAULT_CONTEXT_LIMIT.toLocaleString()} tok (desktop default, est.)`
    : "window from the budget event";
}

/**
 * Resolve the meter readout. Priority:
 *   numerator  fresh spine occupancy > proxy (labeled est.)
 *   denominator spine contextLimit > modelContextLimit > fallback (est.)
 */
export function computeContextMeter(
  input: ContextMeterInput,
): ContextMeterResult {
  const fallbackLimit = finitePositive(input.fallbackLimit)
    ? input.fallbackLimit
    : DEFAULT_CONTEXT_LIMIT;
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_SPINE_MAX_AGE_MS;
  const spine = input.spine;

  // Denominator: the real window wins whenever ANY source knows it. The
  // window is a property of the model, not of the moment — an older
  // event's limit still beats the 200k fallback.
  let limit = fallbackLimit;
  let limitEstimated = true;
  let limitFromEvent = false;
  if (finitePositive(spine?.contextLimit)) {
    limit = spine!.contextLimit!;
    limitEstimated = false;
    limitFromEvent = true;
  } else if (finitePositive(input.modelContextLimit)) {
    limit = input.modelContextLimit;
    limitEstimated = false;
  }

  // Numerator: the spine occupancy only while FRESH; a future receivedAt
  // (clock skew) counts as fresh, anything past maxAgeMs does not.
  const age =
    spine && finitePositive(spine.receivedAt)
      ? Math.max(0, input.now - spine.receivedAt)
      : Infinity;
  if (
    spine &&
    admissibleOccupancy(spine.occupancy) &&
    finitePositive(spine.receivedAt) &&
    age <= maxAgeMs
  ) {
    const pct = clampPct(spine.occupancy * 100);
    return {
      pct,
      limit,
      limitEstimated,
      estimated: limitEstimated,
      source: "spine",
      level: contextLevel(spine.occupancy),
      tooltip: `Context ${pct}% — live budget event (CLI spine) · ${limitSuffix(
        limitEstimated,
      )}`,
    };
  }

  // Fallback: proxy numerator, always labeled. Never silent precision.
  const proxy = input.proxyTokens;
  const pct =
    finitePositive(proxy) && limit > 0 ? clampPct((proxy / limit) * 100) : 0;
  const stale = spine != null;
  return {
    pct,
    limit,
    limitEstimated,
    estimated: true,
    source: "proxy",
    level: contextLevel(limit > 0 ? pct / 100 : 0),
    tooltip: `Context estimate (est.) ~${pct}% — proxy (chars/4, measured turn tokens, last prompt size)${
      limitFromEvent || !limitEstimated
        ? ` over the real ${limit.toLocaleString()} tok window`
        : ` over the ${limit.toLocaleString()} tok default window (est.)`
    } · no fresh budget event${stale ? " (last one is stale)" : ""}`,
  };
}
