/**
 * Context Engine v2 — per-agent context policy (Frontier Runtime Upgrade §50–51).
 *
 * The full run record (session spine) is the durable truth; what each agent
 * *sees* is a projection governed by one of these policies. Role defaults
 * mirror the plan: lead sees recent history + graph + verification; explore
 * gets summaries; verify gets diff/evidence-oriented context.
 *
 * Pure data — no IO, no LLM. The projector (ContextProjector.ts) consumes it.
 *
 * @since v2.11.0
 */

/** How much of prior history an agent receives. */
export type ContextHistoryMode = 'full' | 'recent' | 'summary' | 'none';

/** How tool results are rendered inside the projection. */
export type ContextToolResultsMode = 'full' | 'projected' | 'summary-only';

export interface AgentContextPolicy {
  history: ContextHistoryMode;
  /** Include the parent agent's delegation summary (tentacles). */
  includeParentSummary: boolean;
  /** Include durable state blocks (.zelari/state — verified knowledge). */
  includeDurableState: boolean;
  /** Include Kraken graph state. */
  includeGraphState: boolean;
  /** Include verification/completion state. */
  includeVerificationState: boolean;
  toolResults: ContextToolResultsMode;
  /** Soft cap (estimated tokens, chars/4) for the projected prompt. */
  maxPromptTokens?: number;
  /** Per-result inline cap in chars (projected mode). Default 12_000. */
  maxToolResultChars?: number;
  /** Recent-window size in turn units (recent/summary modes). Default 20. */
  maxHistoryTurns?: number;
}

/** §51 — Kraken lead: recent history, graph + verification state. */
export const KRAKEN_LEAD_POLICY: AgentContextPolicy = {
  history: 'recent',
  includeParentSummary: false,
  includeDurableState: true,
  includeGraphState: true,
  includeVerificationState: true,
  toolResults: 'projected',
};

/** §51 — Explore: summaries, no graph/verification, no peer transcripts. */
export const KRAKEN_EXPLORE_POLICY: AgentContextPolicy = {
  history: 'summary',
  includeParentSummary: true,
  includeDurableState: true,
  includeGraphState: false,
  includeVerificationState: false,
  toolResults: 'projected',
};

/** §51 — General: summaries + graph awareness. */
export const KRAKEN_GENERAL_POLICY: AgentContextPolicy = {
  history: 'summary',
  includeParentSummary: true,
  includeDurableState: true,
  includeGraphState: true,
  includeVerificationState: false,
  toolResults: 'projected',
};

/** §51 — Verify: goal/diff/evidence oriented; no durable state. */
export const KRAKEN_VERIFY_POLICY: AgentContextPolicy = {
  history: 'summary',
  includeParentSummary: true,
  includeDurableState: false,
  includeGraphState: true,
  includeVerificationState: true,
  toolResults: 'projected',
};

/** Neutral default for roles without a dedicated policy. */
export const DEFAULT_CONTEXT_POLICY: AgentContextPolicy = {
  history: 'recent',
  includeParentSummary: false,
  includeDurableState: false,
  includeGraphState: false,
  includeVerificationState: false,
  toolResults: 'projected',
};

const ROLE_POLICIES: Record<string, AgentContextPolicy> = {
  lead: KRAKEN_LEAD_POLICY,
  explore: KRAKEN_EXPLORE_POLICY,
  general: KRAKEN_GENERAL_POLICY,
  verify: KRAKEN_VERIFY_POLICY,
  council: DEFAULT_CONTEXT_POLICY,
  mission: DEFAULT_CONTEXT_POLICY,
};

/** Resolve the context policy for a runtime agent role. */
export function contextPolicyForRole(role: string): AgentContextPolicy {
  return ROLE_POLICIES[role] ?? DEFAULT_CONTEXT_POLICY;
}

export const CONTEXT_POLICY_VERSION = 1;
