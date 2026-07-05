import type { EvidenceTier } from './types.js';

/** Numeric rank for tier comparison (higher = stronger evidence). */
export const TIER_RANK: Record<EvidenceTier, number> = {
  'n/a': -1,
  claimed: 0,
  grep: 1,
  tool: 2,
  build: 3,
};

export function tierAtLeast(actual: EvidenceTier, minimum: EvidenceTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[minimum];
}

export function parseEvidenceTier(raw: string | undefined): EvidenceTier | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (t === 'n/a' || t === 'na') return 'n/a';
  if (t === 'claimed') return 'claimed';
  if (t === 'grep') return 'grep';
  if (t === 'tool') return 'tool';
  if (t === 'build') return 'build';
  return null;
}

/** Map synthesis table labels to verification check id prefixes. */
export function matchCheckPrefix(label: string): string {
  const s = label.trim().toLowerCase();
  if (s.includes('motion') || s.includes('keyframes') || s.includes('transition')) {
    return 'motion.';
  }
  if (s.includes('js') || s.includes('script') || s.includes('inline')) return 'inline-js.';
  if (s.includes('hook') || s.includes('dead') || s.includes('.rm')) return 'css.dead';
  if (s.includes('readme')) return 'docs.readme';
  if (s.includes('plan') || s.includes('v0.2') || s.includes('palette')) return 'plan.';
  if (s.includes('honest') || s.includes('synthesis')) return 'synthesis.';
  return s;
}
