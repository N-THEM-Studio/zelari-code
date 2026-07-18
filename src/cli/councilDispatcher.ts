/**
 * councilDispatcher — CLI-side bridge to runCouncilPure.
 *
 * Builds a {@link PureCouncilConfig} from CLI env (apiKey, model,
 * provider), wires the openai-compatible provider stream, and yields the
 * council run as an AsyncIterable<BrainEvent>.
 *
 * Default config (v0.7.9):
 *   - councilSize: 6 (full council — Caronte through Lucifero)
 *   - runMode: auto-detected from user message + existing plan
 *   - debateMode: false (no multi-round debate loop)
 *
 * @see docs/plans/2026-06-28-zelari-code.md (Task 14.7)
 */

import {
  runCouncilPure,
  resolveCouncilRunMode,
  type CouncilRunMode,
  type PureCouncilCallbacks,
  type PureCouncilConfig,
} from "@zelari/core/council";
import type { BrainEvent } from "@zelari/core/events";
import type { EventBus } from "@zelari/core/events";
import type { ProviderStreamFn } from "@zelari/core/harness";
import type { ToolRegistry } from "@zelari/core/harness/tools/registry";
import type { FeedbackStore } from "./councilFeedback.js";
import { resolveCouncilTier } from "./councilConfig.js";
import { hasWorkspacePlan } from "./workspace/planDetect.js";
import { createWorkspaceContext } from "./workspace/stubs.js";
import { createWorkspaceToolRegistry } from "./workspace/toolRegistry.js";

export interface CouncilDispatchOptions {
  /** API key for the provider (e.g. OPENAI_API_KEY). */
  apiKey: string;
  /** Model identifier (e.g. 'grok-4'). */
  model: string;
  /** Provider id (default 'openai-compatible'). */
  provider?: string;
  /** Number of council members (default: full tier = 6). */
  councilSize?: number;
  /** Whether to run oracle-debate (default false). */
  debateMode?: boolean;
  /** Override auto-detected council run mode. */
  runMode?: CouncilRunMode;
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
  tools?: ToolRegistry;
  maxToolCallsPerTurn?: number;
  /** Chairman-only (Lucifero) tool budget — raised in zelari-mode. */
  maxToolCallsChairman?: number;
  /** Soft tool-loop iterations per member (AgentHarness). */
  maxToolLoopIterations?: number;
  /** Hard tool-loop ceiling per member (AgentHarness). */
  maxToolLoopHardCap?: number;
  /**
   * Skip specialists — only Minosse + Lucifero run.
   * Used by Zelari mission implementation retries (2+).
   */
  skipSpecialists?: boolean;
  feedbackStore?: FeedbackStore;
  /** @internal */
  disableWorkspaceTools?: boolean;
  workspaceRoot?: string;
  /** Status lines (delivery retries, inline-js autofix) for the TUI. */
  onCouncilStatus?: PureCouncilCallbacks["onCouncilStatus"];
  /** v1.8.0: interactive clarifying-question pause (SelectList in CLI). */
  onClarification?: PureCouncilCallbacks["onClarification"];
}

export class CouncilDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilDispatchError";
  }
}

export async function* dispatchCouncil(
  userMessage: string,
  options: CouncilDispatchOptions,
): AsyncIterable<BrainEvent> {
  if (!options.apiKey || options.apiKey.trim().length === 0) {
    throw new CouncilDispatchError(
      "Missing apiKey — set OPENAI_API_KEY (or pass it via env) before invoking /council.",
    );
  }
  if (!userMessage || userMessage.trim().length === 0) {
    throw new CouncilDispatchError(
      "Empty userMessage — /council requires a non-empty input.",
    );
  }

  const projectRoot = options.workspaceRoot ?? process.cwd();
  const { councilSize } = resolveCouncilTier({
    explicitSize: options.councilSize,
  });
  const runMode =
    options.runMode ??
    resolveCouncilRunMode({
      userMessage,
      hasExistingPlan: hasWorkspacePlan(projectRoot),
      env: process.env,
    });

  const config: PureCouncilConfig = {
    apiKey: options.apiKey,
    provider: options.provider ?? "openai-compatible",
    model: options.model,
    councilSize,
    debateMode: options.debateMode ?? false,
    runMode,
    ragContext: options.ragContext ?? "",
    workspaceContext: options.workspaceContext ?? "",
    providerStream: options.providerStream,
    eventBus: options.eventBus,
    sessionId: options.sessionId,
    tools:
      options.tools ??
      (options.disableWorkspaceTools
        ? undefined
        : createWorkspaceToolRegistry(createWorkspaceContext(projectRoot))),
    maxToolCallsPerTurn: options.maxToolCallsPerTurn,
    maxToolCallsChairman: options.maxToolCallsChairman,
    maxToolLoopIterations: options.maxToolLoopIterations,
    maxToolLoopHardCap: options.maxToolLoopHardCap,
    skipSpecialists: options.skipSpecialists,
    feedbackStore: options.feedbackStore,
  };

  if (!options.disableWorkspaceTools) {
    const { setWorkspaceStubs } = await import("@zelari/core/skills");
    const {
      createWorkspaceContext: buildCtx,
      createWorkspaceStubs: buildStubs,
    } = await import("./workspace/stubs.js");
    const wsCtx = buildCtx(projectRoot);
    setWorkspaceStubs(buildStubs(wsCtx));
  }

  // v1.5.1: bridge CLI-only tools (browser_check, LSP navigation, AST outline,
  // semantic search) into the agents catalog so council members and the zelari
  // loop can actually call them. Without this, the executor has the tools (so
  // filterExecutable keeps their names) but getProviderTools silently drops
  // them because they're absent from getAllTools(). See toolRegistry.ts.
  if (config.tools) {
    const { registerCliToolsIntoCouncilCatalog } = await import("./toolRegistry.js");
    registerCliToolsIntoCouncilCatalog(config.tools);
  }

  const callbacks: PureCouncilCallbacks = {};
  if (options.onCouncilStatus) {
    callbacks.onCouncilStatus = options.onCouncilStatus;
  }
  if (options.onClarification) {
    callbacks.onClarification = options.onClarification;
  }
  yield* runCouncilPure(userMessage, config, callbacks);
}
