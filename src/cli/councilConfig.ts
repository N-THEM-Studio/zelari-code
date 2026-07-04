/**
 * Council tier resolution — explicit lite (3) vs full (6) roster sizes.
 *
 * Default for interactive `/council` is **full** (6 members) so Minosse and
 * Lucifero always run. Opt into the lighter tier via `ZELARI_COUNCIL_TIER=lite`
 * or an explicit `councilSize` below 6.
 */

export type CouncilTier = 'lite' | 'full';

export const COUNCIL_TIER_SIZES = {
  lite: 3,
  full: 6,
} as const;

export interface CouncilTierResult {
  tier: CouncilTier;
  councilSize: number;
}

export function resolveCouncilTier(opts?: {
  explicitSize?: number;
  env?: NodeJS.ProcessEnv;
}): CouncilTierResult {
  const env = opts?.env ?? process.env;

  if (opts?.explicitSize !== undefined) {
    const size = clampCouncilSize(opts.explicitSize);
    return { tier: size >= COUNCIL_TIER_SIZES.full ? 'full' : 'lite', councilSize: size };
  }

  const envSize = env['ZELARI_COUNCIL_SIZE'];
  if (envSize) {
    const parsed = Number.parseInt(envSize, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      const size = clampCouncilSize(parsed);
      return { tier: size >= COUNCIL_TIER_SIZES.full ? 'full' : 'lite', councilSize: size };
    }
  }

  const tierEnv = env['ZELARI_COUNCIL_TIER']?.toLowerCase();
  if (tierEnv === 'lite') {
    return { tier: 'lite', councilSize: COUNCIL_TIER_SIZES.lite };
  }
  if (tierEnv === 'full') {
    return { tier: 'full', councilSize: COUNCIL_TIER_SIZES.full };
  }

  return { tier: 'full', councilSize: COUNCIL_TIER_SIZES.full };
}

function clampCouncilSize(n: number): number {
  return Math.min(COUNCIL_TIER_SIZES.full, Math.max(1, Math.floor(n)));
}
