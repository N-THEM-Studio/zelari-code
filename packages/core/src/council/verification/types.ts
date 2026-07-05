/**
 * Types for deterministic post-council implementation verification.
 */

export type VerificationSeverity = 'error' | 'warn';

/** Evidence ladder: claimed < grep < tool < build. */
export type EvidenceTier = 'claimed' | 'grep' | 'tool' | 'build' | 'n/a';

export type VerificationCheckId =
  | 'motion.keyframes'
  | 'motion.transitions'
  | 'inline-js.budget'
  | 'css.dead-hook'
  | 'plan.reality'
  | 'docs.readme-stale'
  | 'synthesis.honesty'
  | 'synthesis.tier-inflation'
  | 'synthesis.cite-invalid'
  | 'synthesis.degraded-banner'
  | 'nfr-spec.missing';

export interface VerificationCheckResult {
  id: VerificationCheckId;
  severity: VerificationSeverity;
  ok: boolean;
  message: string;
  /** Evidence tier achieved by this check (deterministic checks default to grep). */
  tier?: EvidenceTier;
  /** project-relative path */
  file?: string;
  line?: number;
  evidence?: string;
}

export interface NfrAnimationSpec {
  /** Only transform and opacity in @keyframes and transitions. */
  compositorOnly?: boolean;
  /** Also flag layout-affecting props (grid-template-rows, padding, width, …). */
  forbidLayoutProps?: boolean;
}

export interface NfrSpec {
  version: 1;
  /** Paths relative to project root. */
  targets: string[];
  animation?: NfrAnimationSpec;
  inlineJs?: { maxBytes: number };
  /** Grep milestone descriptions for these phrases; warn if absent in targets. */
  planFeatureKeywords?: string[];
}

export interface VerificationReport {
  ok: boolean;
  generatedAt: string;
  runMode: 'implementation';
  targets: string[];
  results: VerificationCheckResult[];
}

export interface RunVerificationInput {
  projectRoot: string;
  zelariRoot: string;
  nfrSpec?: NfrSpec | null;
  /** Chairman synthesis text for honesty lint. */
  synthesisText?: string;
  /** Council run was degraded (abort/error/no writes). */
  degradedRun?: boolean;
}
