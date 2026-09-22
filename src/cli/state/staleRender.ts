/**
 * Stale / superseded rendering for durable state layers (t163).
 *
 * A layer is *superseded* when a later commit of the SAME layer kind exists —
 * marked at write time by FileDurableStateStore.commit(). Independently, a
 * layer older than DEFAULT_STALE_MS renders as *stale* (age). Either way a
 * dead session's layer must never be presented as current.
 *
 * Both FileDurableStateStore.materializeContext() (async store) and
 * composeContext's readDurableHeadSync() (sync fallback) render through these
 * pure helpers so the marker text cannot diverge.
 */

/** Layer age (ms) after which a non-superseded layer renders as stale (48h). */
export const DEFAULT_STALE_MS = 48 * 3600_000;

/** Structural subset of StateCommitMeta needed to render the stale marker. */
export interface StaleRenderMeta {
  createdAt?: number;
  layer?: string;
  supersededAt?: number;
  supersededBy?: string;
}

/**
 * Layer "kind" = the layer string with one trailing `-<n>` sequence stripped,
 * e.g. `mission:progress-6` → `mission:progress`. A layer without a trailing
 * number is its own kind. Empty/missing layer → null: unlayered commits never
 * supersede anything and are never superseded (conservative, additive-only).
 */
export function layerKind(layer?: string): string | null {
  if (!layer || !layer.trim()) return null;
  return layer.replace(/-\d+$/, '');
}

/** Compact human age: `<1h` · `Nh` · `Nd` (floor, day = 24h). */
function humanizeAge(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return '<1h';
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Status line for a durable layer, or null when the layer is fresh (no marker
 * — fresh commits stay byte-identical to before t163).
 *
 *   - superseded: `stale · superseded <YYYY-MM-DD> by <supersededBy 8>`
 *   - aged:       `stale · age <Nd|Nh|<1h>` when age > DEFAULT_STALE_MS
 *
 * `now` is injectable so tests can pin the age threshold deterministically.
 */
export function formatStaleMarker(
  meta: StaleRenderMeta,
  now: number = Date.now(),
): string | null {
  if (typeof meta.supersededAt === 'number') {
    const day = new Date(meta.supersededAt).toISOString().slice(0, 10);
    const by = (meta.supersededBy ?? '').slice(0, 8);
    return `stale · superseded ${day} by ${by}`;
  }
  if (typeof meta.createdAt === 'number') {
    const age = now - meta.createdAt;
    if (age > DEFAULT_STALE_MS) return `stale · age ${humanizeAge(age)}`;
  }
  return null;
}
