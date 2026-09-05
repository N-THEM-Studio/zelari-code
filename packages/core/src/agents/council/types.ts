/**
 * types — council run configuration and callback contracts, extracted
 * verbatim from agents/councilApi.ts.
 */
import type { AgentRole } from '../../types/index.js';
import type { ParsedToolCall } from '../toolSchemas.js';
import type { ProviderStreamFn } from '../../core/AgentHarness.js';
import type { SystemPromptConfig } from '../../types/systemTypes.js';
import type { ToolRegistry } from '../../core/tools/registry.js';
import type { CouncilRunMode } from '../../council/runMode.js';
import type { ClarificationRequest } from './outputCleaning.js';

/**
 * Council members whose tool-emission retry is DISABLED.
 *
 * v0.7.7 Opzione B put 'nettun' here because its contract (12 createTask
 * + 1 createMilestone = 13+ sequential calls) exceeded what composer-2.5
 * could persist in the 240s budget, making the retry a pure waste.
 *
 * v0.7.8 removes 'nettun': the plan contract is now satisfiable with a
 * SINGLE `createPlan` batch call (phases + nested tasks + milestone in
 * one emission), so the forced retry has the same 1-call budget that
 * already works reliably for Minosse and Lucifero. The set stays
 * exported as the opt-out mechanism for future members.
 */
export const NON_RETRY_AGENTS: ReadonlySet<string> = new Set([]);
/**
 * Minimal structural interface for a feedback store — matches the
 * `FeedbackStore` class in `electron/cli/councilFeedback.ts` without
 * importing it (keeps the core free of CLI-side deps).
 *
 * Used by `runCouncilPure` to opt-in to feedback-driven specialist ordering
 * via the `.ranked()` method (Task: council integration, v3-I deferred).
 */
export interface FeedbackStoreLike {
  /**
   * Return a NEW array sorted by feedback score, descending.
   * Members with no feedback are placed last, ordered by id ascending.
   */
  ranked<T extends { id: string }>(items: T[]): T[];
}

export interface PureCouncilConfig {
  apiKey: string;
  glmApiKey?: string;
  provider?: string;
  model: string;
  councilSize: number;
  debateMode: boolean;
  ragContext: string;
  workspaceContext: string;
  completedAgentIds?: string[];
  existingOutputs?: { name: string; role: string; content: string }[];
  aiConfig?: SystemPromptConfig;
  agentModels?: Record<string, { providerId: string; model: string }>;
  customProviders?: Array<{
    id: string;
    baseUrl: string;
    authStyle: 'openai' | 'anthropic';
    models: string[];
  }>;
  providerApiKeys?: Record<string, string>;
  /**
   * Optional per-call member remap (Task I.3 close-out).
   *
   * When set (non-empty), `swapMembers(agents, memberSwap)` is applied
   * immediately after `getCouncilAgents()` and BEFORE filtering into
   * specialists / oracle / chairman. Useful for replacing `oracle` with a
   * custom critic on the fly. Throws `UnknownMemberError` on typo in either
   * side of the mapping.
   *
   * Backward-compat: when omitted, behavior is identical to pre-integration.
   *
   * @see swapMembers in src/agents/roles.ts
   */
  memberSwap?: Record<string, string>;
  /**
   * Optional feedback store for specialist ordering (Task I.2 close-out).
   *
   * When set, `feedbackStore.ranked(specialists)` is applied AFTER the swap
   * filter and BEFORE the specialists loop. Only specialists are ranked —
   * oracle (debate-mode review) and chairman (synthesis) keep their fixed
   * positions. This preserves the existing semantics of the council while
   * letting good-rated specialists go first.
   *
   * Backward-compat: when omitted, specialists run in their default order.
   */
  feedbackStore?: FeedbackStoreLike;
  /** Provider stream function (injected for testability). MUST yield ProviderDelta. */
  providerStream: ProviderStreamFn;
  /** Optional event bus for emitting BrainEvents alongside the returned iterable. */
  eventBus?: import('../../shared/eventBus.js').EventBus;
  /** Optional session id. Defaults to a UUID. */
  sessionId?: string;
  /**
   * Optional tool registry. When provided, each council member (specialist
   * and oracle) is given access to the registry via AgentHarness — tool_call
   * deltas trigger real tool execution and emit tool_execution_end events.
   * Without it, the council is text-only (legacy behavior).
   *
   * @see electron/main/core/AgentHarness.ts — `toolRegistry` field
   * @see electron/cli/toolRegistry.ts — `createBuiltinToolRegistry()`
   */
  tools?: ToolRegistry;
  /**
   * Max tool calls per member per turn. Enforced by truncating extra
   * tool_execution_start events to `tool_call_skipped` after this limit.
   * Default: 5. Set to 0 to disable tools entirely (overrides `tools`).
   */
  maxToolCallsPerTurn?: number;
  /**
   * Override the tool-call budget for the chairman (Lucifero) only. Zelari-mode
   * raises this for long autonomous implementation runs while leaving the
   * specialists and oracle on the shared `maxToolCallsPerTurn`. Falls back to
   * `maxToolCallsPerTurn`, then 5.
   */
  maxToolCallsChairman?: number;
  /**
   * Soft max observe→reason→act cycles per member harness run.
   * Forwarded to AgentHarness; default is the harness default (30) when unset.
   * CLI wires this from `ZELARI_MAX_TOOL_LOOP_ITERATIONS`.
   */
  maxToolLoopIterations?: number;
  /**
   * Hard ceiling on tool-loop iterations per member. `0`/unset → harness
   * computes max(soft×3, soft+60). CLI: `ZELARI_MAX_TOOL_LOOP_HARD`.
   */
  maxToolLoopHardCap?: number;
  /**
   * When true, skip all specialists (Caronte…Plutone). Only Minosse (oracle)
   * and Lucifero (chairman) run. Used by Zelari mission implementer-retry
   * slices (implementation 2+) so fix/verify loops do not re-pay a full
   * 6-member council. Default false — full roster.
   */
  skipSpecialists?: boolean;
  /** Council run mode. Default: `implementation`. */
  runMode?: CouncilRunMode;
}

export interface PureCouncilCallbacks {
  /** Status lines surfaced in the TUI (delivery retries, verify passes). */
  onCouncilStatus?: (message: string) => void;
  onAgentStart?: (agent: AgentRole) => void;
  onAgentChunk?: (agent: AgentRole, chunk: string) => void;
  onAgentDone?: (agent: AgentRole, content: string, thinking?: string) => void;
  onSynthesisStart?: () => void;
  onSynthesisChunk?: (chunk: string) => void;
  onSynthesisDone?: (content: string, toolCalls?: ParsedToolCall[], thinking?: string) => void;
  /**
   * Fired after every council member (specialist, oracle, chairman) completes
   * its run, with the accumulated cost for that member (Task I.1, v3-I).
   * The same payload is also yielded as a `member_cost` BrainEvent in the
   * main event stream so JSONL sidecars and live consumers stay consistent.
   *
   * When the provider does not send `usage` (some don't honor
   * `stream_options.include_usage`), the token fields are 0. Tool calls
   * are counted from `tool_execution_start` events. Duration is wall-clock
   * around the member's AgentHarness run.
   */
  onMemberCost?: (cost: {
    memberId: string;
    name: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
    toolCalls: number;
    errored: boolean;
  }) => void;
  /**
   * v1.8.0: when a member emits a structured ---QUESTION--- with choices,
   * the CLI may pause and ask the user (SelectList). Return the chosen
   * answer (or null if cancelled / free-text will follow later). Injected
   * into agentOutputs so subsequent members see the reply.
   */
  onClarification?: (
    req: ClarificationRequest,
  ) => Promise<string | null | undefined>;
}
