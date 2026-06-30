/**
 * councilDispatcher — CLI-side bridge to runCouncilPure.
 *
 * Builds a minimal {@link PureCouncilConfig} from CLI env (apiKey, model,
 * provider), wires the openai-compatible provider stream, and yields the
 * council run as an AsyncIterable<BrainEvent>. The CLI app then renders
 * events to the chat and persists them via SessionJsonlWriter.
 *
 * Default config:
 *   - councilSize: 3 (sisyphus + prometheus + hephaestus — no oracle)
 *   - debateMode: false (no oracle-debate loop)
 *   - ragContext / workspaceContext: empty (CLI doesn't have a vault here)
 *
 * Phase 14.7: multi-agent council invocation from the Ink CLI.
 *
 * @see docs/plans/2026-06-28-anathema-coder.md (Task 14.7)
 */

import {
  runCouncilPure,
  type PureCouncilConfig,
} from '../agents/councilApi.js';
import type { BrainEvent } from '../shared/events.js';
import type { EventBus } from '../shared/eventBus.js';
import type { ProviderStreamFn } from '../main/core/AgentHarness.js';
import type { ToolRegistry } from '../main/core/tools/registry.js';
import type { FeedbackStore } from './councilFeedback.js';

export interface CouncilDispatchOptions {
  /** API key for the provider (e.g. OPENAI_API_KEY). */
  apiKey: string;
  /** Model identifier (e.g. 'grok-4'). */
  model: string;
  /** Provider id (default 'openai-compatible'). */
  provider?: string;
  /** Number of council members (default 3). */
  councilSize?: number;
  /** Whether to run oracle-debate (default false). */
  debateMode?: boolean;
  /** Optional session id (default = UUID). */
  sessionId?: string;
  /** Optional event bus for fan-out alongside the returned iterable. */
  eventBus?: EventBus;
  /** Provider stream function (injected for testability). */
  providerStream: ProviderStreamFn;
  /** Optional RAG context (default empty). */
  ragContext?: string;
  /** Optional workspace context (default empty). */
  workspaceContext?: string;
  /**
   * Optional tool registry. When provided, each council member gets
   * real tool execution via AgentHarness — tool_call deltas invoke
   * registered tools and emit tool_execution_end events.
   *
   * Typically created via `createBuiltinToolRegistry()` from
   * `electron/cli/toolRegistry.ts` which pre-wires the 5 built-in
   * tools (read/write/edit/bash/grep) wrapped with the safety layer.
   */
  tools?: ToolRegistry;
  /**
   * Max tool calls per member per turn. See PureCouncilConfig for details.
   * Forwarded to runCouncilPure.
   */
  maxToolCallsPerTurn?: number;
  /**
   * Optional feedback store for specialist ordering (Task I.2 close-out).
   * Forwarded to runCouncilPure as `feedbackStore`.
   */
  feedbackStore?: FeedbackStore;
}

export class CouncilDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouncilDispatchError';
  }
}

/**
 * Run a council on `userMessage` and yield the resulting BrainEvents.
 *
 * Throws CouncilDispatchError synchronously if apiKey is missing.
 * The returned async iterable emits the full council lifecycle; consumers
 * should iterate to completion or break early to cancel.
 */
export async function* dispatchCouncil(
  userMessage: string,
  options: CouncilDispatchOptions,
): AsyncIterable<BrainEvent> {
  if (!options.apiKey || options.apiKey.trim().length === 0) {
    throw new CouncilDispatchError(
      'Missing apiKey — set OPENAI_API_KEY (or pass it via env) before invoking /council.',
    );
  }
  if (!userMessage || userMessage.trim().length === 0) {
    throw new CouncilDispatchError('Empty userMessage — /council requires a non-empty input.');
  }

  const config: PureCouncilConfig = {
    apiKey: options.apiKey,
    provider: options.provider ?? 'openai-compatible',
    model: options.model,
    councilSize: options.councilSize ?? 3,
    debateMode: options.debateMode ?? false,
    ragContext: options.ragContext ?? '',
    workspaceContext: options.workspaceContext ?? '',
    providerStream: options.providerStream,
    eventBus: options.eventBus,
    sessionId: options.sessionId,
    tools: options.tools,
    maxToolCallsPerTurn: options.maxToolCallsPerTurn,
    feedbackStore: options.feedbackStore,
  };

  yield* runCouncilPure(userMessage, config, {});
}