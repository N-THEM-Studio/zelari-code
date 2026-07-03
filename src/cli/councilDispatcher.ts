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
 * @see docs/plans/2026-06-28-zelari-code.md (Task 14.7)
 */

import {
  runCouncilPure,
  type PureCouncilConfig,
} from '@zelari/core/council';
import type { BrainEvent } from '@zelari/core/events';
import type { EventBus } from '@zelari/core/events';
import type { ProviderStreamFn } from '@zelari/core/harness';
import type { ToolRegistry } from '@zelari/core/harness/tools/registry';
import type { FeedbackStore } from './councilFeedback.js';
import { createWorkspaceContext } from './workspace/stubs.js';
import { createWorkspaceToolRegistry } from './workspace/toolRegistry.js';

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
   * `src/cli/toolRegistry.ts` which pre-wires the 6 built-in
   * tools (read/write/edit/bash/grep/list_files) wrapped with the safety layer.
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
  /**
   * Phase 4 wiring test hook: opt out of the default workspace tool
   * registry. The CLI itself never sets this — only tests do, to
   * verify legacy text-only behavior without workspace stubs.
   * @internal
   */
  disableWorkspaceTools?: boolean;
  /**
   * Optional workspace root directory. When set, the workspace context
   * (and the workspace tool stubs) are bound to this directory instead
   * of `process.cwd()`. Useful for running the council design phase
   * against a specific project root (e.g. `~/zelari-projects/foo`).
   * Has no effect when `disableWorkspaceTools: true`.
   */
  workspaceRoot?: string;
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
    // Default to the workspace tool registry (CLI standalone has no
    // AnathemaBrain Electron ctx). Pass `tools: undefined` via options
    // to skip workspace wiring (e.g. in tests).
    tools: options.tools
      ?? (options.disableWorkspaceTools
        ? undefined
        : createWorkspaceToolRegistry(createWorkspaceContext())),
    maxToolCallsPerTurn: options.maxToolCallsPerTurn,
    feedbackStore: options.feedbackStore,
  };

  // Bug A fix (v0.7.5): also register workspace stubs in the global static
  // (setWorkspaceStubs from @zelari/core/skills) so that getAllTools() —
  // called by buildSystemPrompt when constructing the AVAILABLE TOOLS block —
  // exposes them to the model. Without this, the per-call ToolRegistry can
  // execute workspace tool calls, but the model never sees the names in its
  // system prompt and either guesses them or skips them.
  //
  // Mirrors the pattern in src/cli/runHeadless.ts:141-152 and
  // src/cli/hooks/useChatTurn.ts:572-586. Dynamic import avoids the load-
  // order cycle that a static import would create (councilDispatcher is
  // imported by hooks/runHeadless, and @zelari/core/skills is consumed by
  // those same modules — see Gotcha #9 of zelari-code-headless-driver).
  if (!options.disableWorkspaceTools) {
    const { setWorkspaceStubs } = await import('@zelari/core/skills');
    const { createWorkspaceContext: buildCtx, createWorkspaceStubs: buildStubs } = await import('./workspace/stubs.js');
    const wsCtx = options.workspaceRoot
      ? buildCtx(options.workspaceRoot)
      : buildCtx();
    setWorkspaceStubs(buildStubs(wsCtx));
  }

  yield* runCouncilPure(userMessage, config, {});
}