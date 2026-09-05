import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CouncilMessage, AgentRole } from '../types/index.js';
import { getAgent, getCouncilAgents, resolveRoleSystemPrompt, swapMembers } from './roles.js';
import { getProviderTools, type ParsedToolCall } from './toolSchemas.js';
import {
  buildSystemPromptSplit,
  computeAgentTools,
} from './systemPromptBuilder.js';
import { getAllTools } from './tools.js';
import { buildLanguagePolicyModuleFor } from './languagePolicy.js';
import { scrubProprietaryLeak } from './secrecyPolicy.js';
import type { SystemPromptConfig, SystemPromptModule } from '../types/systemTypes.js';
import type { BrainEvent, UsageBreakdown } from '../shared/events.js';
import { createBrainEvent } from '../shared/events.js';
import type {
  AgentMessage,
  AgentToolSpec,
  ProviderStreamFn,
} from '../core/AgentHarness.js';
import {
  AgentHarness,
  normalizeTextToolArgs,
  parseTextToolCalls,
} from '../core/AgentHarness.js';
import { ToolRegistry } from '../core/tools/registry.js';
import type { CouncilRunMode } from '../council/runMode.js';
import { councilModeBanner } from '../council/modeBanners.js';
import { councilTierFromSize } from '../council/runMode.js';
import {
  parseProjectRootFromWorkspaceContext,
  runChairmanMicroGate,
  type MicroGateWarning,
} from '../council/verification/microGate.js';
import {
  buildImplementationVerifyRetryPrompt,
  checkImplementationCompletion,
  resolveVerifyRetryTool,
} from '../council/verification/completion.js';
import { warnIfNfrSpecMissing } from '../council/scope/nfrSpecWarn.js';
import {
  loadNfrSpec,
  DEFAULT_NFR_SPEC,
  runImplementationVerification,
} from '../council/verification/runChecks.js';
import {
  buildDeliveryFixPrompt,
  buildImplementationWriteRetryPrompt,
  checkImplementationDelivery,
  countEmittedWriteTools,
  filterDeliveryBlockingFails,
} from '../council/verification/implementationDelivery.js';
import { applyInlineJsAutofix } from '../council/verification/inlineJsAutofix.js';


import { NON_RETRY_AGENTS } from './council/types.js';
import type { PureCouncilConfig, PureCouncilCallbacks } from './council/types.js';
export { NON_RETRY_AGENTS } from './council/types.js';
export type { FeedbackStoreLike, PureCouncilConfig, PureCouncilCallbacks } from './council/types.js';

export type { BrainEvent } from '../shared/events.js';
export type {
  AgentMessage,
  AgentToolSpec,
  ProviderStreamFn,
  ProviderDelta,
} from '../core/AgentHarness.js';



import { cleanAgentContent, parseClarificationRequest, parseThinking } from './council/outputCleaning.js';
import type { ClarificationRequest } from './council/outputCleaning.js';
export { cleanAgentContent, hasInteractiveClarification, parseClarificationRequest, parseThinking } from './council/outputCleaning.js';
export type { CleanAgentContentOptions, ClarificationRequest } from './council/outputCleaning.js';



import { buildAgentMessages, restrictImplementationWrites } from './council/memberMessages.js';
export { MUTATING_PROJECT_TOOLS, restrictImplementationWrites } from './council/memberMessages.js';


/**
 * PURE council orchestration. Loops through specialists, optionally runs
 * the oracle (debate mode), then runs the chairman synthesis.
 *
 * Each agent invocation creates an AgentHarness internally that consumes
 * the providerStream and emits BrainEvents. The orchestrator aggregates
 * text deltas into a single message per agent.
 *
 * Returns AsyncIterable<BrainEvent> for the full council run.
 */
export async function* runCouncilPure(
  userMessage: string,
  config: PureCouncilConfig,
  callbacks: PureCouncilCallbacks = {},
): AsyncIterable<BrainEvent> {
  const baseAgents = getCouncilAgents(config.councilSize);
  // Apply optional member swap (Task I.3 close-out). Throws UnknownMemberError
  // on typo in either side of the mapping — caller decides whether to catch
  // or surface. When `memberSwap` is undefined/empty, swapMembers returns a
  // shallow copy (no-op in effect).
  const agents = swapMembers(baseAgents, config.memberSwap ?? {});
  const messages: CouncilMessage[] = [];
  const completedIds = new Set(config.completedAgentIds ?? []);
  const agentOutputs: { name: string; role: string; content: string }[] = [
    ...(config.existingOutputs ?? []),
  ];
  const sessionId = config.sessionId ?? crypto.randomUUID();
  const runMode: CouncilRunMode = config.runMode ?? 'implementation';
  const isDesignPhase = runMode === 'design-phase';

  // v1.7.0 (agy audit M2): build the language module ONCE per run. Each
  // member then receives the SAME module reference — all 6 council
  // members agree on the response language without re-running detection.
  // Wrapped in try/catch so a malformed user message degrades to a
  // safe "Italian" stub instead of crashing the whole council run.
  let councilLanguageModule: SystemPromptModule;
  try {
    councilLanguageModule = buildLanguagePolicyModuleFor(userMessage);
  } catch {
    councilLanguageModule = {
      type: 'language-policy',
      title: 'Response Language',
      priority: 5,
      content: '# Response Language\nReply in the user\'s language when possible, otherwise Italian.',
    };
  }

  yield createBrainEvent('council_mode', sessionId, {
    tier: councilTierFromSize(config.councilSize),
    councilSize: config.councilSize,
    runMode,
  });

  // Emit council start
  yield {
    type: 'agent_start',
    id: crypto.randomUUID(),
    ts: Date.now(),
    sessionId,
    model: config.model,
    provider: config.provider ?? 'minimax',
  };

  /**
   * Build a MemberCost payload and dispatch it via the callback + the
   * event stream. Used by the I.1 per-member cost tracking — fires
   * once per member (specialist, oracle, chairman) at the end of its run.
   */
  const emitMemberCost = (input: {
    memberId: string;
    name: string;
    usage: UsageBreakdown | null;
    durationMs: number;
    toolCalls: number;
    errored: boolean;
  }): void => {
    const usage = input.usage;
    const prompt = usage?.promptTokens ?? 0;
    const completion = usage?.completionTokens ?? 0;
    const cost = {
      memberId: input.memberId,
      name: input.name,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: usage?.totalTokens ?? prompt + completion,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      toolCalls: input.toolCalls,
      errored: input.errored,
    };
    callbacks.onMemberCost?.(cost);
  };
  // Exposed to the harness loop below via closure — `yield` inside an
  // async generator can't happen from a non-async helper, so the actual
  // `member_cost` event is yielded inline at each call site (see the
  // specialist / oracle / chairman loops). The helper only owns the
  // callback dispatch to keep call sites short.

  // v0.7.3: only advertise tools the executor registry can actually run.
  // computeAgentTools unions role tools + skill requiredTools, which still
  // include Electron-era tools (searchRAG, buildMindMap, addNode, …) the CLI
  // registry does not implement. Advertising them makes the model call tools
  // that fail with `Tool "searchRAG" not found` (live-test 2026-07-02) and
  // burns its per-turn tool budget on guaranteed failures.
  //
  // v0.7.5 Bug B fix: union the role's tool list with the executor's tool
  // list BEFORE filtering. When the executor is a workspace-only registry
  // (e.g. createWorkspaceToolRegistry from dispatchCouncil), role.tools like
  // list_files/read_file/grep_content are NOT in the executor — without the
  // union, filterExecutable strips everything and the model sees an empty
  // AVAILABLE TOOLS block. The harness still gates execution via the
  // ToolRegistry.invoke call (AgentHarness.ts:539), so we never advertise
  // a tool that the executor can't actually run.
  const executorToolNames = config.tools ? config.tools.list() : [];
  const executableNames = config.tools ? new Set(executorToolNames) : null;
  const filterExecutable = (names: string[]): string[] => {
    if (!executableNames) return names;
    const merged = Array.from(new Set([...names, ...executorToolNames]));
    return merged.filter((n) => executableNames.has(n));
  };

  // Apply optional feedback-driven specialist ordering (Task I.2 close-out).
  // Minosse and chairman are extracted BEFORE ranking so their positions are
  // fixed (debate review + final synthesis roles are not reorderable).
  // Zelari implementer-retry: skipSpecialists → Minosse + Lucifero only.
  const allSpecialists = agents.filter((a) => a.id !== 'lucifer' && a.id !== 'minos');
  const specialists = config.skipSpecialists
    ? []
    : config.feedbackStore
      ? config.feedbackStore.ranked(allSpecialists)
      : allSpecialists;
  // On lite tier (size < 6) minos/lucifer may be absent from `agents` —
  // implementer-retry must still get critic + implementer.
  const oracle =
    agents.find((a) => a.id === 'minos') ??
    (config.skipSpecialists ? getAgent('minos') : undefined);
  const chairman =
    agents.find((a) => a.id === 'lucifer') ??
    (config.skipSpecialists ? getAgent('lucifer') : undefined);

  for (const agent of specialists) {
    if (completedIds.has(agent.id)) continue;
    callbacks.onAgentStart?.(agent);

    const override = config.agentModels?.[agent.id];
    const effectiveProvider = override?.providerId ?? config.provider ?? 'minimax';
    const effectiveModel = override?.model ?? config.model;

    // Specialists analyze and hand off; only the chairman (Lucifero) implements
    // in implementation mode. Strip write/edit so members don't all edit the
    // same files. (Design-phase and the chairman keep the full set.)
    const agentToolNames = filterExecutable(
      restrictImplementationWrites(computeAgentTools(agent, config.aiConfig), {
        runMode,
        isImplementer: false,
      }),
    );
    const agentTools: AgentToolSpec[] = agentToolNames.length > 0
      ? getProviderTools(agentToolNames).map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters as Record<string, unknown>,
        }))
      : [];

    const harness = new AgentHarness({
      model: effectiveModel,
      provider: effectiveProvider,
      sessionId,
      messages: buildAgentMessages(agent, userMessage, config.ragContext, config.workspaceContext, agentOutputs, config.aiConfig, executableNames, runMode, councilLanguageModule),
      tools: agentTools,
      eventBus: config.eventBus,
      toolRegistry: config.tools,
      // Task G.2 — enforce per-turn tool-call limit (carryover from v3-C C.1.5).
      // Council members can otherwise fire N tool calls in one turn and blow
      // the message context. Default to 5 if not set by caller.
      maxToolCallsPerTurn: config.maxToolCallsPerTurn ?? 5,
      ...(typeof config.maxToolLoopIterations === 'number'
        ? { maxToolLoopIterations: config.maxToolLoopIterations }
        : {}),
      ...(typeof config.maxToolLoopHardCap === 'number' && config.maxToolLoopHardCap > 0
        ? { maxToolLoopHardCap: config.maxToolLoopHardCap }
        : {}),
      // Visible-reasoning wiring (v0.5.0): stamp every event the
      // harness emits with the council-member identity so the UI can
      // render "Caronte: …" headers above the streamed text.
      memberId: agent.id,
      memberName: agent.name,
      providerStream: (params) => config.providerStream({
        ...params,
      } as never),
    });

    let fullText = '';
    let toolCalls = 0;
    let usage: UsageBreakdown | null = null;
    let errored = false;
    // v0.7.6: per-member tool emission tracking for the post-condition
    // check below. Each entry is the toolName of a tool_execution_start
    // event from this member's turn.
    const emittedToolNames: string[] = [];
    const memberStart = Date.now();
    try {
      for await (const event of harness.run()) {
        yield event;
        if (event.type === 'tool_execution_start') {
          toolCalls += 1;
          emittedToolNames.push(event.toolName);
        }
        if (event.type === 'message_end' && event.usage) {
          usage = event.usage;
        }
        if (event.type === 'message_delta') {
          fullText += event.delta;
          callbacks.onAgentChunk?.(agent, event.delta);
        }
        // AgentHarness catches provider errors internally and re-emits
        // them as BrainErrorEvent. Without this check, a streaming
        // failure would silently leave `errored=false` and the partial
        // output would be reported as a success. v0.6.0 audit HIGH-4.
        if (event.type === 'error' && event.severity !== 'cancelled') {
          errored = true;
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[council] agent "${agent.id}" failed:`, err);
      fullText = `Error: ${err instanceof Error ? err.message : 'Unknown'}`;
      errored = true;
    }
    // v0.7.6: post-condition check — verify this member emitted the
    // tools its role prompt requires. Logs a warning if any are missing.
    // Does not block the council run (Pass 3 may add retry).
    // v0.7.7 Pass 3: forced retry turn for the specialist. Same logic
    // as the chairman and oracle — extracted into applyRetryIfMissing
    // so the three loops share one implementation. Skipped when the
    // specialist errored (retry is for tool gaps, not LLM failures).
    // v0.7.7 Opzione B: skip the retry entirely for members in
    // NON_RETRY_AGENTS (composer-2.5 cannot satisfy the heavy
    // emission budget in the 240s window; the deterministic
    // post-processor fills the gaps from a template).
    if (isDesignPhase && !errored && !NON_RETRY_AGENTS.has(agent.id)) {
      const specialistCheck = enforceDesignPhaseToolEmissions(agent.id, emittedToolNames);
      yield* applyRetryIfMissing({
        agent,
        check: specialistCheck,
        requirements: DESIGN_PHASE_REQUIREMENTS[agent.id],
        emittedToolNames,
        executableNames,
        sessionId,
        userMessage,
        agentOutputs,
        config,
        effectiveProvider,
        effectiveModel,
        onToolCall: () => { toolCalls += 1; },
        languageModule: councilLanguageModule,
      });
    } else if (isDesignPhase) {
      enforceDesignPhaseToolEmissions(agent.id, emittedToolNames);
    }
    if (isDesignPhase) {
      warnIfNfrSpecMissing(agent.id, userMessage, emittedToolNames);
    }
    const memberDuration = Date.now() - memberStart;
    emitMemberCost({
      memberId: agent.id,
      name: agent.name,
      usage,
      durationMs: memberDuration,
      toolCalls,
      errored,
    });
    yield createBrainEvent('member_cost', sessionId, {
      cost: {
        memberId: agent.id,
        name: agent.name,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
        durationMs: memberDuration,
        toolCalls,
        errored,
      },
    });

    const thinking = parseThinking(fullText);
    const cleaned = cleanAgentContent(fullText);
    callbacks.onAgentDone?.(agent, cleaned, thinking || undefined);

    messages.push({
      id: crypto.randomUUID().slice(0, 12),
      role: 'assistant',
      content: cleaned,
      thinking: thinking || undefined,
      agentId: agent.id,
      agentName: agent.name,
      agentRole: agent.role,
      agentColor: agent.color,
      timestamp: Date.now(),
    });
    agentOutputs.push({ name: agent.name, role: agent.role, content: cleaned });

    const clarification = parseClarificationRequest(fullText);
    if (clarification) {
      agentOutputs.push({
        name: 'Clarification',
        role: 'system',
        content: `(Agent ${agent.name} asked: ${clarification.question})`,
      });
      // v1.8.0: optional interactive pause (CLI wires SelectList). When the
      // user answers, inject it so oracle/chairman see the choice.
      if (
        callbacks.onClarification &&
        clarification.choices &&
        clarification.choices.length >= 2
      ) {
        try {
          const answer = await callbacks.onClarification(clarification);
          if (answer && answer.trim()) {
            agentOutputs.push({
              name: 'User',
              role: 'user',
              content:
                `Answer to clarifying question "${clarification.question}": ${answer.trim()}`,
            });
          }
        } catch {
          // Clarification UI failure must never abort the council.
        }
      }
    }
  }

  // Minosse (critic) — runs once regardless of debateMode.
  // Fix v0.7.5 Bug C: previously gated on config.debateMode (default false),
  // so 6-member councils silently ran only 5 members. A critic pass is
  // always useful before final synthesis; multi-round debate loops remain
  // debateMode-gated (TODO: see plan 2026-07-03-council-3-bugs-fix.md).
  if (oracle && !completedIds.has(oracle.id)) {
    callbacks.onAgentStart?.(oracle);

    const override = config.agentModels?.[oracle.id];
    const effectiveProvider = override?.providerId ?? config.provider ?? 'minimax';
    const effectiveModel = override?.model ?? config.model;

    const anonymized = agentOutputs.map((o, i) => ({
      ...o,
      name: `Agent ${i + 1}`,
      role: 'Specialist',
    }));

    const harness = new AgentHarness({
      model: effectiveModel,
      provider: effectiveProvider,
      sessionId,
      messages: buildAgentMessages(
        oracle,
        `Review these proposals for: "${userMessage}"`,
        '',
        '',
        anonymized,
        config.aiConfig,
        executableNames,
        runMode,
        councilLanguageModule,
      ),
      tools: (() => {
        const oracleToolNames = filterExecutable(
          restrictImplementationWrites(
            Array.from(new Set([
              'createDocument',
              'searchDocuments',
              ...computeAgentTools(oracle, config.aiConfig),
            ])),
            { runMode, isImplementer: false },
          ),
        );
        return oracleToolNames.length > 0
          ? getProviderTools(oracleToolNames).map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters as Record<string, unknown>,
            }))
          : [];
      })(),
      eventBus: config.eventBus,
      toolRegistry: config.tools,
      // Task G.2 — same per-turn limit applies to oracle.
      maxToolCallsPerTurn: config.maxToolCallsPerTurn ?? 5,
      ...(typeof config.maxToolLoopIterations === 'number'
        ? { maxToolLoopIterations: config.maxToolLoopIterations }
        : {}),
      ...(typeof config.maxToolLoopHardCap === 'number' && config.maxToolLoopHardCap > 0
        ? { maxToolLoopHardCap: config.maxToolLoopHardCap }
        : {}),
      // Visible-reasoning (v0.5.0): same member-stamping as the
      // specialist loop above. Minosse's events are marked as
      // belonging to the oracle / debate round.
      memberId: oracle.id,
      memberName: oracle.name,
      providerStream: (params) => config.providerStream({
        ...params,
      } as never),
    });

    let fullText = '';
    let toolCalls = 0;
    let usage: UsageBreakdown | null = null;
    let errored = false;
    // v0.7.6: per-member tool emission tracking (Minosse MUST emit at
    // least one createDocument for risks.md).
    const emittedToolNames: string[] = [];
    const memberStart = Date.now();
    try {
      for await (const event of harness.run()) {
        yield event;
        if (event.type === 'tool_execution_start') {
          toolCalls += 1;
          emittedToolNames.push(event.toolName);
        }
        if (event.type === 'message_end' && event.usage) {
          usage = event.usage;
        }
        if (event.type === 'message_delta') {
          fullText += event.delta;
          callbacks.onAgentChunk?.(oracle, event.delta);
        }
        // v0.6.0 audit HIGH-4 — detect AgentHarness-emitted error
        // events so the oracle's `member_cost.errored` reflects reality.
        if (event.type === 'error' && event.severity !== 'cancelled') {
          errored = true;
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[council] oracle failed:', err);
      fullText = `Review error: ${err instanceof Error ? err.message : 'Unknown'}`;
      errored = true;
    }
    // v0.7.6: post-condition check on Minosse's tool emission. The role
    // prompt requires at least one createDocument (for risks.md).
    // v0.7.7 Pass 3: forced retry if missing. Skipped on error.
    if (isDesignPhase && !errored) {
      const oracleCheck = enforceDesignPhaseToolEmissions(oracle.id, emittedToolNames);
      yield* applyRetryIfMissing({
        agent: oracle,
        check: oracleCheck,
        requirements: DESIGN_PHASE_REQUIREMENTS[oracle.id],
        emittedToolNames,
        executableNames,
        sessionId,
        userMessage: `Review these proposals for: "${userMessage}"`,
        agentOutputs,
        config,
        effectiveProvider,
        effectiveModel,
        onToolCall: () => { toolCalls += 1; },
        languageModule: councilLanguageModule,
      });
    } else if (isDesignPhase) {
      enforceDesignPhaseToolEmissions(oracle.id, emittedToolNames);
    }
    const memberDuration = Date.now() - memberStart;
    emitMemberCost({
      memberId: oracle.id,
      name: oracle.name,
      usage,
      durationMs: memberDuration,
      toolCalls,
      errored,
    });
    yield createBrainEvent('member_cost', sessionId, {
      cost: {
        memberId: oracle.id,
        name: oracle.name,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
        durationMs: memberDuration,
        toolCalls,
        errored,
      },
    });

    const thinking = parseThinking(fullText);
    const cleaned = cleanAgentContent(fullText);
    callbacks.onAgentDone?.(oracle, cleaned, thinking || undefined);

    messages.push({
      id: crypto.randomUUID().slice(0, 12),
      role: 'assistant',
      content: cleaned,
      thinking: thinking || undefined,
      agentId: oracle.id,
      agentName: oracle.name,
      agentRole: oracle.role,
      agentColor: oracle.color,
      isReview: true,
      timestamp: Date.now(),
    });
    agentOutputs.push({ name: oracle.name, role: oracle.role, content: cleaned });
  }

  // Lucifero synthesis — v0.6.0: real chairman integration.
  // Previously this was a stub ("Phase 13 will add full chairman
  // integration"). v0.6.0 promotes Lucifero to a real AgentHarness
  // run that streams message_delta events just like the 5
  // specialists and Minosse. The chairman:
  //   1. Receives the same systemPrompt defined in roles.ts (via
  //      buildAgentMessages with priorOutputs = all agent outputs).
  //   2. Runs the same AgentHarness pipeline (tool calls allowed,
  //      per-turn cap honoured).
  //   3. Emits agent_start / message_start / message_delta /
  //      message_end / agent_end / member_cost with memberId='lucifer'
  //      and memberName='Lucifero', so the TUI renders
  //      `· Lucifero` (purple #8b5cf6) just like the other roles.
  //   4. Streams deltas through callbacks.onSynthesisChunk so the
  //      chat panel can do typewriter effect during synthesis.
  // Robustness: if the chairman's LLM call fails, the council run
  // does NOT abort — the 5 specialist outputs remain available,
  // and we surface the error reason in agent_end.
  if (chairman && !completedIds.has(chairman.id)) {
    callbacks.onSynthesisStart?.();
    callbacks.onAgentStart?.(chairman);

    const override = config.agentModels?.[chairman.id];
    const effectiveProvider = override?.providerId ?? config.provider ?? 'minimax';
    const effectiveModel = override?.model ?? config.model;

    const chairmanToolNames = filterExecutable(computeAgentTools(chairman, config.aiConfig));
    const chairmanTools: AgentToolSpec[] = chairmanToolNames.length > 0
      ? getProviderTools(chairmanToolNames).map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters as Record<string, unknown>,
        }))
      : [];

    const chairmanHarness = new AgentHarness({
      model: effectiveModel,
      provider: effectiveProvider,
      sessionId,
      messages: buildAgentMessages(
        chairman,
        userMessage,
        config.ragContext,
        config.workspaceContext,
        agentOutputs,
        config.aiConfig,
        executableNames,
        runMode,
        councilLanguageModule,
      ),
      tools: chairmanTools,
      eventBus: config.eventBus,
      toolRegistry: config.tools,
      // Chairman-only budget (zelari-mode raises this); specialists/oracle
      // keep the shared default.
      maxToolCallsPerTurn:
        config.maxToolCallsChairman ?? config.maxToolCallsPerTurn ?? 5,
      ...(typeof config.maxToolLoopIterations === 'number'
        ? { maxToolLoopIterations: config.maxToolLoopIterations }
        : {}),
      ...(typeof config.maxToolLoopHardCap === 'number' && config.maxToolLoopHardCap > 0
        ? { maxToolLoopHardCap: config.maxToolLoopHardCap }
        : {}),
      // v0.5.0 visible-reasoning wiring: stamp every event with
      // the chairman identity so the UI renders `· Lucifero` in
      // purple. Same pattern as the specialist loop above.
      memberId: chairman.id,
      memberName: chairman.name,
      providerStream: (params) => config.providerStream({
        ...params,
      } as never),
    });

    let fullText = '';
    let toolCalls = 0;
    let usage: UsageBreakdown | null = null;
    let errored = false;
    let lastErrorMessage = '';
    // v0.7.6: per-member tool emission tracking for the post-condition
    // check below (Lucifero MUST emit at least one createDocument for
    // the synthesis; see enforceDesignPhaseToolEmissions).
    const emittedToolNames: string[] = [];
    const pendingChairmanWrites = new Map<string, { path: string; toolName: string }>();
    let successfulWriteCount = 0;
    // Increment 3: accumulate deduped motion violations across the whole turn
    // (keyed by id|file|line) and remember the target files written, so we can
    // run ONE post-turn fix pass instead of emitting a repeated per-write flood.
    const chairmanViolations = new Map<string, MicroGateWarning>();
    const changedTargetFiles = new Set<string>();
    let chairmanProjectRoot: string | null = parseProjectRootFromWorkspaceContext(
      config.workspaceContext ?? '',
    );
    const memberStart = Date.now();
    try {
      for await (const event of chairmanHarness.run()) {
        yield event;
        if (event.type === 'tool_execution_start') {
          toolCalls += 1;
          emittedToolNames.push(event.toolName);
          if (
            !isDesignPhase &&
            (event.toolName === 'write_file' || event.toolName === 'edit_file') &&
            typeof event.args.path === 'string'
          ) {
            pendingChairmanWrites.set(event.toolCallId, {
              path: event.args.path,
              toolName: event.toolName,
            });
          }
        }
        if (!isDesignPhase && event.type === 'tool_execution_end') {
          const pending = pendingChairmanWrites.get(event.toolCallId);
          if (pending) {
            pendingChairmanWrites.delete(event.toolCallId);
            if (!event.isError) {
              let wrote = pending.toolName === 'write_file';
              if (pending.toolName === 'edit_file' && typeof event.result === 'string') {
                try {
                  const parsed = JSON.parse(event.result) as { occurrencesReplaced?: number };
                  wrote = (parsed.occurrencesReplaced ?? 0) > 0;
                } catch {
                  wrote = false;
                }
              }
              if (wrote) {
                successfulWriteCount += 1;
                const projectRoot = parseProjectRootFromWorkspaceContext(config.workspaceContext);
                if (projectRoot) {
                  chairmanProjectRoot = projectRoot;
                  changedTargetFiles.add(pending.path);
                  for (const w of runChairmanMicroGate({
                    projectRoot,
                    relPath: pending.path,
                    zelariRoot: `${projectRoot}/.zelari`,
                  })) {
                    chairmanViolations.set(`${w.id}|${w.file}|${w.line ?? ''}`, w);
                  }
                }
              }
            }
          }
        }
        if (event.type === 'message_end' && event.usage) {
          usage = event.usage;
        }
        if (event.type === 'message_delta') {
          fullText += event.delta;
          callbacks.onSynthesisChunk?.(event.delta);
          callbacks.onAgentChunk?.(chairman, event.delta);
        }
        if (event.type === 'error') {
          // AgentHarness catches provider-level errors and re-emits them
          // as BrainErrorEvent (severity 'recoverable' | 'fatal' | 'cancelled').
          // We must detect this and mark the chairman as errored so the
          // member_cost reflects reality, otherwise the synthesis appears
          // successful when in fact the model never produced text.
          // text_tools_parse_failed is advisory — the post-turn fix loop still runs.
          if (event.severity !== 'cancelled' && event.code !== 'text_tools_parse_failed') {
            errored = true;
            lastErrorMessage = event.message;
          }
        }
      }
    } catch (err) {
      // Defensive: any escape from the harness (e.g. an AbortError that
      // AgentHarness did not wrap) is also marked as errored.
      // IMPORTANT: do NOT overwrite `fullText` here — the partial
      // synthesis is more useful than the error string, and overwriting
      // it would also break the `errored && fullText.length === 0` check
      // that selects the fallback message below. (v0.6.0 audit HIGH-1)
      // eslint-disable-next-line no-console
      console.error(`[council] chairman "${chairman.id}" failed:`, err);
      errored = true;
      lastErrorMessage = err instanceof Error ? err.message : String(err);
    }
    // v0.7.6: post-condition check on Lucifero's tool emission. The
    // role prompt requires at least one createDocument (for synthesis.md).
    // v0.7.7 Pass 3: forced retry if missing — extracted into the shared
    // helper applyRetryIfMissing. Skipped when the chairman errored (the
    // retry is for tool-emission gaps, not for LLM-level failures).
    if (isDesignPhase && !errored) {
      const chairmanCheck = enforceDesignPhaseToolEmissions(chairman.id, emittedToolNames);
      yield* applyRetryIfMissing({
        agent: chairman,
        check: chairmanCheck,
        requirements: DESIGN_PHASE_REQUIREMENTS[chairman.id],
        emittedToolNames,
        executableNames,
        sessionId,
        userMessage,
        agentOutputs,
        config,
        effectiveProvider,
        effectiveModel,
        onToolCall: () => { toolCalls += 1; },
        languageModule: councilLanguageModule,
      });
    } else if (isDesignPhase) {
      enforceDesignPhaseToolEmissions(chairman.id, emittedToolNames);
    } else if (!errored) {
      // Increment 5: implementation delivery — force writes when prose-only,
      // replay ---TOOLS---, motion fix, then verify-driven delivery loop.
      if (chairmanProjectRoot) {
        const zelariRoot = `${chairmanProjectRoot}/.zelari`;
        const spec = loadNfrSpec(zelariRoot) ?? DEFAULT_NFR_SPEC;
        for (const rel of spec.targets) {
          if (!existsSync(join(chairmanProjectRoot, rel))) continue;
          changedTargetFiles.add(rel);
          for (const w of runChairmanMicroGate({ projectRoot: chairmanProjectRoot, relPath: rel, zelariRoot })) {
            chairmanViolations.set(`${w.id}|${w.file}|${w.line ?? ''}`, w);
          }
        }
      }
      if (
        fullText.includes('---TOOLS---') &&
        chairmanProjectRoot &&
        config.tools
      ) {
        const replayed = yield* replayChairmanTextTools({
          synthesisText: fullText,
          projectRoot: chairmanProjectRoot,
          toolRegistry: config.tools,
          sessionId,
          memberId: chairman.id,
        });
        successfulWriteCount += replayed;
        const zelariRootReplay = `${chairmanProjectRoot}/.zelari`;
        const specReplay = loadNfrSpec(zelariRootReplay) ?? DEFAULT_NFR_SPEC;
        for (const rel of specReplay.targets) {
          if (!existsSync(join(chairmanProjectRoot, rel))) continue;
          changedTargetFiles.add(rel);
          for (const w of runChairmanMicroGate({
            projectRoot: chairmanProjectRoot,
            relPath: rel,
            zelariRoot: zelariRootReplay,
          })) {
            chairmanViolations.set(`${w.id}|${w.file}|${w.line ?? ''}`, w);
          }
        }
      }
      if (chairmanProjectRoot) {
        const deliveryCheck = checkImplementationDelivery(
          successfulWriteCount,
          countEmittedWriteTools(emittedToolNames),
        );
        if (!deliveryCheck.ok) {
          yield* applyImplementationWriteRetry({
            chairman,
            check: deliveryCheck,
            sessionId,
            userMessage,
            agentOutputs,
            config,
            effectiveProvider,
            effectiveModel,
            executableNames,
            onToolCall: () => { toolCalls += 1; },
            onSuccessfulWrite: () => { successfulWriteCount += 1; },
            onCouncilStatus: callbacks.onCouncilStatus,
            languageModule: councilLanguageModule,
          });
        }
      }
      if (chairmanViolations.size > 0 && chairmanProjectRoot) {
        yield* runChairmanFixLoop({
          chairman,
          violations: chairmanViolations,
          changedFiles: changedTargetFiles,
          projectRoot: chairmanProjectRoot,
          executableNames,
          sessionId,
          userMessage,
          agentOutputs,
          config,
          effectiveProvider,
          effectiveModel,
          onToolCall: () => { toolCalls += 1; },
          languageModule: councilLanguageModule,
        });
      }
      if (chairmanProjectRoot) {
        yield* runChairmanDeliveryLoop({
          chairman,
          projectRoot: chairmanProjectRoot,
          changedFiles: changedTargetFiles,
          executableNames,
          sessionId,
          userMessage,
          agentOutputs,
          config,
          effectiveProvider,
          effectiveModel,
          onToolCall: () => { toolCalls += 1; },
          onCouncilStatus: callbacks.onCouncilStatus,
          languageModule: councilLanguageModule,
        });
      }
    }
    const memberDuration = Date.now() - memberStart;
    // If the chairman errored mid-flight but produced some text, keep it
    // (don't lose partial synthesis) but mark the run as errored.
    const finalSynthesis = errored && fullText.length === 0
      ? `[Chairman synthesis failed: ${lastErrorMessage || 'unknown error'}]`
      : fullText;
    callbacks.onSynthesisDone?.(finalSynthesis, undefined, undefined);
    emitMemberCost({
      memberId: chairman.id,
      name: chairman.name,
      usage,
      durationMs: memberDuration,
      toolCalls,
      errored,
    });
    yield createBrainEvent('member_cost', sessionId, {
      cost: {
        memberId: chairman.id,
        name: chairman.name,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
        durationMs: memberDuration,
        toolCalls,
        errored,
      },
    });
  }

  yield {
    type: 'agent_end',
    id: crypto.randomUUID(),
    ts: Date.now(),
    sessionId,
    reason: 'completed',
    durationMs: 0,
  };
}



import { buildMotionFixPrompt } from './council/chairmanDelivery.js';
import { applyImplementationWriteRetry, runChairmanDeliveryLoop } from './council/chairmanDelivery.js';
export { applyCompletionRetry, applyImplementationWriteRetry, buildMotionFixPrompt, MAX_DELIVERY_ATTEMPTS, runChairmanDeliveryLoop } from './council/chairmanDelivery.js';



import { replayChairmanTextTools, runChairmanFixLoop } from './council/chairmanFixLoop.js';
export { replayChairmanTextTools, runChairmanFixLoop } from './council/chairmanFixLoop.js';


import { DESIGN_PHASE_REQUIREMENTS, enforceDesignPhaseToolEmissions } from './council/toolEmission.js';
import type { ToolEmissionCheckResult, ToolEmissionRequirement } from './council/toolEmission.js';
export { checkMemberToolEmissionSets, checkMemberToolEmissions, DESIGN_PHASE_REQUIREMENTS, DESIGN_PHASE_REQUIREMENT_SETS, enforceDesignPhaseToolEmissions } from './council/toolEmission.js';
export type { ToolEmissionCheckResult, ToolEmissionRequirement } from './council/toolEmission.js';



import { applyRetryIfMissing, runRetryTurnForMember, shouldRetryMember } from './council/retryTurn.js';
export { applyRetryIfMissing, buildRetryPrompt, MAX_RETRY_PER_MEMBER, runRetryTurnForMember, shouldRetryMember } from './council/retryTurn.js';

