import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CouncilMessage, AgentRole } from '../types/index.js';
import { getCouncilAgents, swapMembers } from './roles.js';
import { getProviderTools, type ParsedToolCall } from './toolSchemas.js';
import { buildSystemPrompt, computeAgentTools } from './systemPromptBuilder.js';
import { getAllTools } from './tools.js';
import { buildLanguagePolicyModuleFor } from './languagePolicy.js';
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

export type { BrainEvent } from '../shared/events.js';
export type {
  AgentMessage,
  AgentToolSpec,
  ProviderStreamFn,
  ProviderDelta,
} from '../core/AgentHarness.js';

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
  eventBus?: import('../shared/eventBus.js').EventBus;
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

const QUESTION_MARKER = '---QUESTION---';
const QUESTION_END_MARKER = '---END---';

export interface ClarificationRequest {
  question: string;
  choices?: string[];
  context?: string;
}

export function parseClarificationRequest(text: string): ClarificationRequest | null {
  const start = text.indexOf(QUESTION_MARKER);
  if (start < 0) return null;
  const rest = text.slice(start + QUESTION_MARKER.length);
  const end = rest.indexOf(QUESTION_END_MARKER);
  const block = end >= 0 ? rest.slice(0, end) : rest;
  const cleaned = block.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  const jsonText = objStart >= 0 && objEnd > objStart ? cleaned.slice(objStart, objEnd + 1) : cleaned;
  try {
    const parsed = JSON.parse(jsonText) as Partial<ClarificationRequest>;
    if (typeof parsed.question !== 'string' || !parsed.question.trim()) return null;
    return {
      question: parsed.question.trim(),
      choices: Array.isArray(parsed.choices)
        ? parsed.choices.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
        : undefined,
      context: typeof parsed.context === 'string' ? parsed.context.trim() : undefined,
    };
  } catch {
    return null;
  }
}

export function parseThinking(text: string): string {
  // Prefer complete blocks; fall back to unclosed trailing block (common mid-stream).
  const complete = text.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
  if (complete) return complete[1].trim();
  const open = text.match(/<think(?:ing)?>([\s\S]*)$/i);
  return open ? open[1].trim() : '';
}

/**
 * Strip model "private" channels from text shown to the user / re-fed as
 * history. Covers:
 *   - complete + unclosed `<think>` / `<thinking>` (GLM/MiniMax style)
 *   - MiniMax XML tool-call wrappers
 *   - clarifying-question JSON blocks
 *
 * Without unclosed-tag stripping, streamed thinking that never got a closing
 * tag leaked into the TUI as visible assistant prose (v1.8.1).
 */
export function cleanAgentContent(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
    .replace(/<\/think(?:ing)?>/gi, '')
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '')
    .replace(/---QUESTION---[\s\S]*?---END---/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Tools that mutate project files. In implementation-mode council runs only the
 * chairman (Lucifero) implements; specialists + Minosse analyze and hand off.
 * We strip these from every non-implementer so multiple agents never edit the
 * same files (multi-writer chaos) and "who implemented" stays unambiguous.
 * Note: specialists inherit write tools via skill `requiredTools`, so this must
 * filter the RESULT of computeAgentTools, not just the declared role tools.
 */
export const MUTATING_PROJECT_TOOLS: readonly string[] = ['write_file', 'edit_file'];

/**
 * Remove file-mutating tools for non-implementer members in implementation mode.
 * Design-phase and the implementer (chairman) keep the full set unchanged.
 */
export function restrictImplementationWrites(
  toolNames: string[],
  opts: { runMode: CouncilRunMode; isImplementer: boolean },
): string[] {
  if (opts.runMode !== 'implementation' || opts.isImplementer) return toolNames;
  return toolNames.filter((t) => !MUTATING_PROJECT_TOOLS.includes(t));
}

function buildAgentMessages(
  agent: AgentRole,
  userMessage: string,
  ragContext: string,
  workspaceContext: string,
  priorOutputs: { name: string; role: string; content: string }[],
  aiConfig?: SystemPromptConfig,
  executableTools?: ReadonlySet<string> | null,
  runMode: CouncilRunMode = 'implementation',
): AgentMessage[] {
  // v0.7.5: the AVAILABLE TOOLS prompt block must match the schemas the
  // harness actually advertises. The v0.7.3 fix filtered the schemas
  // (filterExecutable) but NOT this prompt text, so members still read
  // "searchRAG: search the knowledge base…" in their system prompt and
  // called it — every call a guaranteed "Tool not found" (live test
  // 2026-07-03, /council in Z:\EasyPeasy\test).
  const allToolNames = computeAgentTools(agent, aiConfig);
  const toolNames = executableTools
    ? allToolNames.filter((n) => executableTools.has(n))
    : allToolNames;
  const enhancedSystemPrompt = buildSystemPrompt(agent, {
    tools: getAllTools(),
    toolNames,
    aiConfig,
    workspaceContext,
    ragContext,
  });
  const messages: AgentMessage[] = [
    { role: 'system', content: enhancedSystemPrompt },
    { role: 'system', content: councilModeBanner(runMode, { isImplementer: agent.id === 'lucifer' }) },
    { role: 'system', content: 'IMPORTANT: Before making any tool calls or expensive operations, check if the information already exists in the shared context from previous agents. Avoid redundant work.' },
  ];
  if (ragContext) {
    messages.push({ role: 'system', content: `Relevant workspace context (from RAG retrieval):\n${ragContext}` });
  }
  if (workspaceContext) {
    messages.push({ role: 'system', content: `Current workspace state:\n${workspaceContext}` });
  }
  if (priorOutputs.length > 0) {
    const summary = priorOutputs.map((o) => `[${o.name} - ${o.role}]: ${o.content}`).join('\n\n');
    messages.push({ role: 'user', content: `Previous council members have said:\n${summary}\n\nOriginal user request: ${userMessage}` });
  } else {
    messages.push({ role: 'user', content: userMessage });
  }
  return messages;
}

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
  const allSpecialists = agents.filter((a) => a.id !== 'lucifer' && a.id !== 'minos');
  const specialists = config.feedbackStore
    ? config.feedbackStore.ranked(allSpecialists)
    : allSpecialists;
  const oracle = agents.find((a) => a.id === 'minos');
  const chairman = agents.find((a) => a.id === 'lucifer');

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
      messages: buildAgentMessages(agent, userMessage, config.ragContext, config.workspaceContext, agentOutputs, config.aiConfig, executableNames, runMode),
      tools: agentTools,
      eventBus: config.eventBus,
      toolRegistry: config.tools,
      // Task G.2 — enforce per-turn tool-call limit (carryover from v3-C C.1.5).
      // Council members can otherwise fire N tool calls in one turn and blow
      // the message context. Default to 5 if not set by caller.
      maxToolCallsPerTurn: config.maxToolCallsPerTurn ?? 5,
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
        executableNames, runMode,
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
        executableNames, runMode,
      ),
      tools: chairmanTools,
      eventBus: config.eventBus,
      toolRegistry: config.tools,
      // Chairman-only budget (zelari-mode raises this); specialists/oracle
      // keep the shared default.
      maxToolCallsPerTurn:
        config.maxToolCallsChairman ?? config.maxToolCallsPerTurn ?? 5,
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


/**
 * Implementation-mode anti-resa retry: force grep/bash after writes.
 */
export async function* applyCompletionRetry(args: {
  agent: AgentRole;
  emittedToolNames: string[];
  executableNames: ReadonlySet<string> | null;
  sessionId: string;
  userMessage: string;
  agentOutputs: { name: string; role: string; content: string }[];
  config: PureCouncilConfig;
  effectiveProvider: string;
  effectiveModel: string;
  onToolCall: () => void;
  /** v1.7.0 (Pass-2 agy finding): pre-built language module so the retry
   * turn's response language matches the rest of the council. Optional. */
  languageModule?: SystemPromptModule;
}): AsyncGenerator<BrainEvent, void, void> {
  const check = checkImplementationCompletion(args.emittedToolNames);
  if (check.ok) return;
  const retryTool = resolveVerifyRetryTool(args.executableNames);
  if (!retryTool) {
    // eslint-disable-next-line no-console
    console.warn('[council] implementation verify retry skipped — no grep_content/bash in registry');
    return;
  }
  if (!shouldRetryMember([retryTool], 0)) return;
  // eslint-disable-next-line no-console
  console.warn(`[council] ${args.agent.id} retrying missing verify tool: ${retryTool}`);
  try {
    const retryGenerator = runRetryTurnForMember({
      agent: args.agent,
      missingToolNames: [retryTool],
      executableTools: args.executableNames,
      userMessage: args.userMessage,
      ragContext: args.config.ragContext,
      workspaceContext: args.config.workspaceContext,
      priorOutputs: args.agentOutputs,
      aiConfig: args.config.aiConfig,
      sessionId: args.sessionId,
      effectiveModel: args.effectiveModel,
      effectiveProvider: args.effectiveProvider,
      eventBus: args.config.eventBus,
      toolRegistry: args.config.tools,
      providerStream: args.config.providerStream,
      runMode: args.config.runMode,
      retryPrompt: buildImplementationVerifyRetryPrompt(retryTool),
      languageModule: args.languageModule,
    });
    for await (const event of retryGenerator) {
      if (event.type === 'tool_execution_start') {
        args.onToolCall();
        args.emittedToolNames.push(event.toolName);
      }
      yield event;
    }
  } catch (retryErr) {
    // eslint-disable-next-line no-console
    console.error(`[council] ${args.agent.id} verify retry failed:`, retryErr);
  }
  const after = checkImplementationCompletion(args.emittedToolNames);
  if (!after.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[council] ${args.agent.id} still missing verify after retry: ${after.reason}`);
  }
}

/**
 * Build the scoped fix instruction for the chairman from deterministic motion
 * violations. Groups by file, lists file:line + rule, and constrains the model
 * to fix ONLY these (no new features, no rewrites). Exported for testing.
 */
export function buildMotionFixPrompt(violations: MicroGateWarning[]): string {
  const byFile = new Map<string, string[]>();
  for (const v of violations) {
    const file = v.file || 'index.html';
    const loc = v.line ? `${file}:L${v.line}` : file;
    const list = byFile.get(file) ?? [];
    list.push(`  - ${loc}: ${v.message}`);
    byFile.set(file, list);
  }
  const blocks = Array.from(byFile.values()).map((lines) => lines.join('\n')).join('\n');
  return (
    `Deterministic verification found ${violations.length} motion violation(s) in the file(s) you just edited. ` +
    `Fix ONLY these — do not add features, do not rewrite sections, do not touch anything else:\n${blocks}\n\n` +
    `Rules: animate ONLY transform and opacity. Replace any box-shadow / background / background-position / ` +
    `filter / color / border-color / width / height / grid-template-rows used in @keyframes or transitions with ` +
    `transform/opacity equivalents (e.g. render a glow via a pseudo-element that scales and fades). For every ` +
    `classList.add('x') in the script, add a matching '.x' CSS rule. Use read_file to see the exact lines, then ` +
    `edit_file. When the listed items are fixed, stop — no summary.`
  );
}

/**
 * Forced retry when Lucifero finished without a successful write_file/edit_file.
 */
export async function* applyImplementationWriteRetry(args: {
  chairman: AgentRole;
  check: { ok: boolean; missing: string[] };
  sessionId: string;
  userMessage: string;
  agentOutputs: { name: string; role: string; content: string }[];
  config: PureCouncilConfig;
  effectiveProvider: string;
  effectiveModel: string;
  executableNames: ReadonlySet<string> | null;
  onToolCall?: () => void;
  onSuccessfulWrite?: () => void;
  onCouncilStatus?: (message: string) => void;
  /** v1.7.0 (Pass-2 agy finding): see applyCompletionRetry. */
  languageModule?: SystemPromptModule;
}): AsyncGenerator<BrainEvent, void, void> {
  if (args.check.ok) return;
  if (!shouldRetryMember(['write_file'], 0)) return;
  const statusMsg = `[council] ${args.chairman.id} implementation write retry: ${args.check.missing.join(', ')}`;
  args.onCouncilStatus?.(statusMsg);
  // eslint-disable-next-line no-console
  console.warn(statusMsg);
  try {
    const retryGenerator = runRetryTurnForMember({
      agent: args.chairman,
      missingToolNames: ['read_file', 'write_file', 'edit_file'],
      minPerTool: { read_file: 3, edit_file: 8, write_file: 1 },
      executableTools: args.executableNames,
      userMessage: args.userMessage,
      ragContext: args.config.ragContext,
      workspaceContext: args.config.workspaceContext,
      priorOutputs: args.agentOutputs,
      aiConfig: args.config.aiConfig,
      sessionId: args.sessionId,
      effectiveModel: args.effectiveModel,
      effectiveProvider: args.effectiveProvider,
      eventBus: args.config.eventBus,
      toolRegistry: args.config.tools,
      providerStream: args.config.providerStream,
      runMode: 'implementation',
      retryPrompt: buildImplementationWriteRetryPrompt(args.userMessage),
      languageModule: args.languageModule,
    });
    for await (const event of retryGenerator) {
      if (event.type === 'tool_execution_start') args.onToolCall?.();
      if (
        event.type === 'tool_execution_end' &&
        !event.isError &&
        typeof event.result === 'string'
      ) {
        try {
          const parsed = JSON.parse(event.result) as {
            bytesWritten?: number;
            occurrencesReplaced?: number;
          };
          if (
            (parsed.bytesWritten ?? 0) > 0 ||
            (parsed.occurrencesReplaced ?? 0) > 0
          ) {
            args.onSuccessfulWrite?.();
          }
        } catch {
          if (event.result.includes('bytesWritten') || event.result.includes('occurrencesReplaced')) {
            args.onSuccessfulWrite?.();
          }
        }
      }
      yield event;
    }
  } catch (retryErr) {
    // eslint-disable-next-line no-console
    console.error(`[council] ${args.chairman.id} implementation write retry failed:`, retryErr);
  }
}

/** Max verify-driven delivery passes after the chairman turn (inline-js, motion, etc.). */
export const MAX_DELIVERY_ATTEMPTS = 2;

/**
 * Increment 5 — verify-driven delivery loop. Re-runs deterministic verification
 * and forces scoped chairman fix turns until blocking technical issues clear
 * or the attempt cap is hit.
 */
export async function* runChairmanDeliveryLoop(args: {
  chairman: AgentRole;
  projectRoot: string;
  changedFiles: Set<string>;
  executableNames: ReadonlySet<string> | null;
  sessionId: string;
  userMessage: string;
  agentOutputs: { name: string; role: string; content: string }[];
  config: PureCouncilConfig;
  effectiveProvider: string;
  effectiveModel: string;
  onToolCall?: () => void;
  maxAttempts?: number;
  onCouncilStatus?: (message: string) => void;
  /** v1.7.0 (Pass-2 agy finding): see applyCompletionRetry. */
  languageModule?: SystemPromptModule;
}): AsyncGenerator<BrainEvent, boolean, void> {
  const maxAttempts = args.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
  const zelariRoot = `${args.projectRoot}/.zelari`;
  let attempt = 0;
  while (attempt < maxAttempts) {
    const report = runImplementationVerification({
      projectRoot: args.projectRoot,
      zelariRoot,
    });
    const blocking = filterDeliveryBlockingFails(report.results);
    if (blocking.length === 0) return true;
    if (blocking.some((b) => b.id === 'inline-js.budget')) {
      const jsFix = applyInlineJsAutofix(args.projectRoot, report);
      if (jsFix.applied) {
        args.onCouncilStatus?.(
          `[council] ${args.chairman.id} inline-js autofix: ${jsFix.fixes.join('; ')}`,
        );
        const afterJs = runImplementationVerification({
          projectRoot: args.projectRoot,
          zelariRoot,
        });
        if (filterDeliveryBlockingFails(afterJs.results).length === 0) return true;
      }
    }
    attempt++;
    const statusMsg = `[council] ${args.chairman.id} delivery pass ${attempt}/${maxAttempts}: ${blocking.map((b) => b.id).join(', ')}`;
    args.onCouncilStatus?.(statusMsg);
    // eslint-disable-next-line no-console
    console.warn(statusMsg);
    try {
      const fixGenerator = runRetryTurnForMember({
        agent: args.chairman,
        missingToolNames: ['read_file', 'edit_file'],
        minPerTool: { read_file: 3, edit_file: 10 },
        executableTools: args.executableNames,
        userMessage: args.userMessage,
        ragContext: args.config.ragContext,
        workspaceContext: args.config.workspaceContext,
        priorOutputs: args.agentOutputs,
        aiConfig: args.config.aiConfig,
        sessionId: args.sessionId,
        effectiveModel: args.effectiveModel,
        effectiveProvider: args.effectiveProvider,
        eventBus: args.config.eventBus,
        toolRegistry: args.config.tools,
        providerStream: args.config.providerStream,
        runMode: 'implementation',
        retryPrompt: buildDeliveryFixPrompt(blocking, args.userMessage),
        languageModule: args.languageModule,
      });
      for await (const event of fixGenerator) {
        if (event.type === 'tool_execution_start') args.onToolCall?.();
        yield event;
      }
    } catch (deliveryErr) {
      // eslint-disable-next-line no-console
      console.error(`[council] ${args.chairman.id} delivery pass ${attempt} failed:`, deliveryErr);
      break;
    }
    for (const rel of args.changedFiles) {
      for (const w of runChairmanMicroGate({ projectRoot: args.projectRoot, relPath: rel, zelariRoot })) {
        // refresh changed set — delivery may touch same targets
        args.changedFiles.add(w.file ?? rel);
      }
    }
  }
  const finalReport = runImplementationVerification({
    projectRoot: args.projectRoot,
    zelariRoot,
  });
  return filterDeliveryBlockingFails(finalReport.results).length === 0;
}

/**
 * Re-execute edit_file/write_file calls from a `---TOOLS---` block after the
 * chairman turn. Safety net when the harness path parsed the block but edits
 * failed (oldString drift) or the block was not fully executed.
 */
export async function* replayChairmanTextTools(args: {
  synthesisText: string;
  projectRoot: string;
  toolRegistry: ToolRegistry;
  sessionId: string;
  memberId?: string;
}): AsyncGenerator<BrainEvent, number, void> {
  const tools = parseTextToolCalls(args.synthesisText);
  if (tools.length === 0) return 0;
  let applied = 0;
  for (const tt of tools) {
    if (tt.name !== 'edit_file' && tt.name !== 'write_file') continue;
    const normalized = normalizeTextToolArgs(tt.name, tt.args);
    const toolCallId = `replay-${crypto.randomUUID().slice(0, 8)}`;
    yield createBrainEvent('tool_execution_start', args.sessionId, {
      toolCallId,
      toolName: tt.name,
      args: normalized,
      ...(args.memberId ? { memberId: args.memberId } : {}),
    });
    const startMs = Date.now();
    let resultStr = '';
    let isError = false;
    try {
      const result = await args.toolRegistry.invoke<unknown>(tt.name, normalized, {
        cwd: args.projectRoot,
        sessionId: args.sessionId,
      });
      if (result.ok) {
        const val = result.value as { occurrencesReplaced?: number };
        if (tt.name === 'edit_file' && val.occurrencesReplaced === 0) {
          resultStr = `edit_file: no match for oldString (replay)`;
          isError = true;
        } else {
          resultStr =
            typeof result.value === 'string'
              ? result.value
              : JSON.stringify(result.value, null, 2);
          applied += 1;
        }
      } else {
        resultStr = result.error;
        isError = true;
      }
    } catch (err) {
      resultStr = err instanceof Error ? err.message : String(err);
      isError = true;
    }
    yield createBrainEvent('tool_execution_end', args.sessionId, {
      toolCallId,
      result: resultStr,
      isError,
      durationMs: Date.now() - startMs,
    });
  }
  return applied;
}

/**
 * Increment 4 — bounded deterministic fix loop for the chairman. When the
 * micro-gate flagged motion violations in Lucifero's writes, force a scoped
 * fix turn (read_file + edit_file only), re-scan the changed files, and repeat
 * until clean or the attempt cap. Emits only the fix turn's own events; the
 * post-council verification reports the final PASS/FAIL to the user.
 */
export async function* runChairmanFixLoop(args: {
  chairman: AgentRole;
  violations: Map<string, MicroGateWarning>;
  changedFiles: Set<string>;
  projectRoot: string;
  executableNames: ReadonlySet<string> | null;
  sessionId: string;
  userMessage: string;
  agentOutputs: { name: string; role: string; content: string }[];
  config: PureCouncilConfig;
  effectiveProvider: string;
  effectiveModel: string;
  onToolCall?: () => void;
  maxAttempts?: number;
  /** v1.7.0 (Pass-2 agy finding): see applyCompletionRetry. */
  languageModule?: SystemPromptModule;
}): AsyncGenerator<BrainEvent, void, void> {
  const maxAttempts = args.maxAttempts ?? 3;
  const zelariRoot = `${args.projectRoot}/.zelari`;
  let current = Array.from(args.violations.values());
  let attempt = 0;
  while (current.length > 0 && attempt < maxAttempts) {
    attempt++;
    try {
      const fixGenerator = runRetryTurnForMember({
        agent: args.chairman,
        missingToolNames: ['read_file', 'edit_file'],
        minPerTool: { read_file: 2, edit_file: 8 },
        executableTools: args.executableNames,
        userMessage: args.userMessage,
        ragContext: args.config.ragContext,
        workspaceContext: args.config.workspaceContext,
        priorOutputs: args.agentOutputs,
        aiConfig: args.config.aiConfig,
        sessionId: args.sessionId,
        effectiveModel: args.effectiveModel,
        effectiveProvider: args.effectiveProvider,
        eventBus: args.config.eventBus,
        toolRegistry: args.config.tools,
        providerStream: args.config.providerStream,
        runMode: 'implementation',
        retryPrompt: buildMotionFixPrompt(current),
        languageModule: args.languageModule,
      });
      for await (const event of fixGenerator) {
        if (event.type === 'tool_execution_start') args.onToolCall?.();
        yield event;
      }
    } catch (fixErr) {
      // eslint-disable-next-line no-console
      console.error(`[council] chairman fix pass ${attempt} failed:`, fixErr);
      break;
    }
    // Re-scan the changed target files for the next iteration / termination.
    const rescanned = new Map<string, MicroGateWarning>();
    for (const relPath of args.changedFiles) {
      for (const w of runChairmanMicroGate({ projectRoot: args.projectRoot, relPath, zelariRoot })) {
        rescanned.set(`${w.id}|${w.file}|${w.line ?? ''}`, w);
      }
    }
    current = Array.from(rescanned.values());
  }
}
// ── Post-condition tool emission check (v0.7.6) ────────────────────────────
//
// After each council member's turn, verify that the tools the role was
// REQUIRED to call were actually emitted. If the model skipped them, the
// downstream deliverable is incomplete (e.g. Minosse's risks.md missing,
// Lucifero's synthesis.md missing, Nettuno's tasks missing).
//
// This is a runtime guard, not a prompt-only fix: the role prompts in
// roles.ts (Fix e987284) already enumerate the required tools, but a
// non-deterministic model can still skip them. The check turns silent
// gaps into observable warnings without blocking the council run.
//
// Pure function — exported so it can be unit-tested without spinning up a
// full AgentHarness. See tests/unit/cli-councilToolEmission.test.ts.

export interface ToolEmissionRequirement {
  /** Tool name, e.g. 'createDocument'. */
  name: string;
  /** Minimum number of times this tool must have been emitted. */
  min: number;
}

export interface ToolEmissionCheckResult {
  /** True when every requirement is satisfied. */
  ok: boolean;
  /** Human-readable list of unmet requirements (empty when ok=true). */
  missing: string[];
}

/**
 * Pure helper: given the list of tool names a member emitted during its
 * turn, and a list of requirements, return whether all requirements are
 * met.
 */
export function checkMemberToolEmissions(
  _memberId: string,
  emittedToolNames: string[],
  requirements: ToolEmissionRequirement[],
): ToolEmissionCheckResult {
  if (requirements.length === 0) {
    return { ok: true, missing: [] };
  }
  // Tally emitted counts once for all requirements.
  const counts = new Map<string, number>();
  for (const name of emittedToolNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const req of requirements) {
    const got = counts.get(req.name) ?? 0;
    if (got < req.min) {
      missing.push(`${req.name} (got ${got}, need >= ${req.min})`);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * v0.7.8 — Per-member tool-emission requirement SETS for the design-phase
 * council run. The outer array is an OR of alternatives: the member's turn
 * is complete when ANY one set is fully satisfied. The FIRST set is the
 * preferred contract — its unmet requirements drive the warning message
 * and the forced-retry tool list.
 *
 * Nettuno has two ways to satisfy its contract:
 *   1. (preferred) ONE `createPlan` batch call — phases + nested tasks +
 *      milestone in a single emission. Retry budget: 1 call, which
 *      composer-2.5 handles reliably (same shape as the Minosse/Lucifero
 *      retries that already work).
 *   2. (legacy) the itemized trio — kept so stronger models (e.g. Opus)
 *      that emit createPhase/createTask/createMilestone directly are not
 *      flagged or retried.
 */
export const DESIGN_PHASE_REQUIREMENT_SETS: Record<string, ToolEmissionRequirement[][]> = {
  nettun: [
    [{ name: 'createPlan', min: 1 }],
    [
      { name: 'createPhase', min: 3 },
      { name: 'createTask', min: 6 },
      { name: 'createMilestone', min: 1 },
    ],
  ],
  geryon: [
    [{ name: 'createDocument', min: 3 }],
  ],
  pluton: [
    [{ name: 'createDocument', min: 1 }],
  ],
  minos: [
    [{ name: 'createDocument', min: 1 }],
  ],
  lucifer: [
    [{ name: 'createDocument', min: 1 }],
  ],
};

/**
 * Preferred (first) requirement set per member — kept as the flat map the
 * council loops pass to `applyRetryIfMissing` for the retry budget. For
 * Nettuno this is `createPlan min 1`, so the forced retry advertises ONE
 * tool with a 1-call budget instead of the old 13+-call itemized contract.
 */
export const DESIGN_PHASE_REQUIREMENTS: Record<string, ToolEmissionRequirement[]> =
  Object.fromEntries(
    Object.entries(DESIGN_PHASE_REQUIREMENT_SETS).map(([id, sets]) => [id, sets[0]!]),
  );

/**
 * Pure helper: OR-of-sets variant of {@link checkMemberToolEmissions}.
 * Returns ok when ANY set is fully satisfied. When none is, the missing
 * list reflects the FIRST (preferred) set so the warning and the retry
 * point the model at the cheapest way to comply.
 */
export function checkMemberToolEmissionSets(
  memberId: string,
  emittedToolNames: string[],
  sets: ToolEmissionRequirement[][],
): ToolEmissionCheckResult {
  if (sets.length === 0) {
    return { ok: true, missing: [] };
  }
  const results = sets.map((set) => checkMemberToolEmissions(memberId, emittedToolNames, set));
  if (results.some((r) => r.ok)) {
    return { ok: true, missing: [] };
  }
  return results[0]!;
}

/**
 * Run the post-condition check for a member and emit a console.warn when
 * any required tool was not emitted the minimum number of times. Returns
 * the check result so callers can act on it (Pass 3 may add automatic
 * retry; for now we only warn).
 */
export function enforceDesignPhaseToolEmissions(
  memberId: string,
  emittedToolNames: string[],
): ToolEmissionCheckResult {
  const sets = DESIGN_PHASE_REQUIREMENT_SETS[memberId];
  if (!sets || sets.length === 0) {
    return { ok: true, missing: [] };
  }
  const result = checkMemberToolEmissionSets(memberId, emittedToolNames, sets);
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `[council] member "${memberId}" did not emit required tools: ${result.missing.join(', ')}. ` +
        `The downstream .zelari/ deliverable may be incomplete. ` +
        `(A forced retry turn scoped to the missing tools follows; the deterministic ` +
        `complete-design fallback covers any remaining gap.)`,
    );
  }
  return result;
}

/**
 * Maximum number of forced retry turns per council member. Cap of 1
 * keeps the worst-case council latency bounded (a single extra turn per
 * member × 4 design-phase members ≈ 30-60 s on top of the base run).
 * Going above 1 tends to produce hallucinated tool arguments because
 * the model has already spent its "tool budget" on exploration.
 */
export const MAX_RETRY_PER_MEMBER = 1;

/**
 * Pure helper: should the council loop spin up one more forced turn for
 * this member to recover the missing tool emissions?
 *
 * Returns true when:
 *   - at least one tool is still missing after the post-condition check, AND
 *   - the retry budget for this member has not been exhausted.
 *
 * Returns false otherwise. Tested as a pure function so the council
 * loop can branch on the answer without coupling to AgentHarness.
 */
export function shouldRetryMember(
  missingToolNames: string[],
  attemptsSoFar: number,
): boolean {
  if (missingToolNames.length === 0) return false;
  if (attemptsSoFar >= MAX_RETRY_PER_MEMBER) return false;
  return true;
}

/**
 * Build the one-line prompt that the retry turn sends to the model.
 * The shape matters: the model is primed by its role prompt to produce
 * prose, so the retry prompt must be unambiguous, imperative, and
 * scoped to ONLY the missing tools.
 *
 * Format: "You did not emit: <names>. Call <names> NOW with concrete
 * arguments. No prose."
 *
 * Multiple tools are listed comma-separated in the same call so the
 * model can satisfy them in a single tool_calls turn (which is the
 * cheapest path through AgentHarness).
 */
export function buildRetryPrompt(missingToolNames: string[]): string {
  const names = missingToolNames.join(', ');
  return `You did not emit the required workspace tools: ${names}. Call ${names} NOW with concrete arguments. No prose. No search.`;
}

// ── Forced retry turn (v0.7.7 Pass 3) ──────────────────────────────────────
//
// When the post-condition check fails for a member, the council loop can
// spin up ONE more AgentHarness turn whose ONLY purpose is to force the
// missing tool emissions. This is a structural fix for the failure mode
// where the model terminates after exploration (`searchDocuments` × 2)
// without persisting the required artifacts.
//
// The retry turn is intentionally minimal:
//   - System prompt: same as the original (via buildAgentMessages) so
//     the model still has its role contract.
//   - User message: the retry prompt (one line, imperative).
//   - Tools: ONLY the missing tools (filtered through filterExecutable
//     so we never advertise a tool the runtime cannot execute).
//   - maxToolCallsPerTurn: exactly the number of missing tools — the
//     model cannot explore again, it can only call what's missing.
//
// Returns the additional tool names emitted during the retry. The caller
// is responsible for re-running checkMemberToolEmissions with the
// union of original + retry emissions.

export async function* runRetryTurnForMember(args: {
  agent: AgentRole;
  missingToolNames: string[];
  /**
   * Per-tool minimum emission count. The retry budget is the SUM of these
   * values (not just the number of distinct missing tools), because
   * requirements like `createTask min: 12` need 12 separate calls even
   * though only 1 distinct tool is missing. If omitted, the budget
   * defaults to `missingToolNames.length` (suitable for tools like
   * createDocument that need only one call).
   */
  minPerTool?: Record<string, number>;
  executableTools: ReadonlySet<string> | null;
  userMessage: string;
  ragContext: string;
  workspaceContext: string;
  priorOutputs: { name: string; role: string; content: string }[];
  aiConfig?: SystemPromptConfig;
  sessionId: string;
  effectiveModel: string;
  effectiveProvider: string;
  eventBus?: BrainEvent['sessionId'] extends string ? unknown : never;
  toolRegistry?: unknown;
  providerStream: ProviderStreamFn;
  runMode?: CouncilRunMode;
  /** Override the default buildRetryPrompt message. */
  retryPrompt?: string;
  /**
   * v1.7.0 (agy audit M2): pre-built language module. Optional — when
   * omitted, no language-policy system message is added (preserves the
   * pre-1.7 retry behavior for tests and callers that don't track it).
   * `runCouncilPure` threads the module it built once per run.
   */
  languageModule?: SystemPromptModule;
}): AsyncGenerator<BrainEvent, string[], void> {
  // Filter the missing tools against what's actually executable in this
  // runtime. If a tool is missing from executableTools, the retry can't
  // emit it — log and skip.
  const executableMissing = args.executableTools
    ? args.missingToolNames.filter((n) => args.executableTools!.has(n))
    : args.missingToolNames;
  if (executableMissing.length === 0) {
    return [];
  }
  // Build the minimal tool set — only the missing tools.
  const retryToolNames = executableMissing;
  const retryToolSpecs: AgentToolSpec[] = getProviderTools(retryToolNames).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters as Record<string, unknown>,
  }));
  // Build the messages: same system + role context as the original turn,
  // then the retry prompt as a user message appended at the end.
  const baseMessages = buildAgentMessages(
    args.agent,
    args.userMessage,
    args.ragContext,
    args.workspaceContext,
    args.priorOutputs,
    args.aiConfig,
    args.executableTools,
    args.runMode ?? 'implementation',
  );
  const retryMessages = [
    ...baseMessages,
    {
      role: 'user' as const,
      content: args.retryPrompt ?? buildRetryPrompt(executableMissing),
    },
  ];
  // Budget the retry turn so the model can satisfy ALL minimums in a
    // single tool_calls turn. For createDocument min:1 this is 1; for
    // createTask min:12 this is 12. Falls back to `missingToolNames.length`
    // when no per-tool min map is provided.
    const maxToolCalls =
      args.minPerTool !== undefined
        ? Object.entries(args.minPerTool)
            .filter(([name]) => executableMissing.includes(name))
            .reduce((sum, [, min]) => sum + min, 0)
        : retryToolNames.length;
    const retryHarness = new AgentHarness({
    model: args.effectiveModel,
    provider: args.effectiveProvider,
    sessionId: args.sessionId,
    messages: retryMessages,
    tools: retryToolSpecs,
    eventBus: args.eventBus as never,
    toolRegistry: args.toolRegistry as never,
    // Budget the retry so the model can satisfy every requirement in
    // ONE tool_calls turn. For createTask min:12 this needs 12 calls.
    maxToolCallsPerTurn: maxToolCalls,
    memberId: args.agent.id,
    memberName: args.agent.name,
    providerStream: (params) => args.providerStream(params),
  });
  const retryEmitted: string[] = [];
  for await (const event of retryHarness.run()) {
    if (event.type === 'tool_execution_start') {
      retryEmitted.push(event.toolName);
    }
    yield event;
  }
  return retryEmitted;
}

/**
 * Shared retry orchestrator used by specialist, oracle, and chairman
 * loops. Given the post-condition check result, decides whether to
 * spin up a forced retry turn, and if so yields the events from that
 * turn back to the caller (so the UI sees them) while mutating the
 * shared `emittedToolNames` array (so the next post-condition check
 * sees the union of original + retry emissions).
 *
 * The retry turn is skipped when:
 *   - the check passed (no missing tools), OR
 *   - the retry budget for this member is exhausted (shouldRetryMember).
 *
 * On retry failure (network error, model error, etc.) the function logs
 * the error and continues — it never throws. The next post-condition
 * check will simply re-warn.
 */
export async function* applyRetryIfMissing(args: {
  agent: AgentRole;
  check: ToolEmissionCheckResult;
  /**
   * Original per-member requirements. Used to compute the retry budget
   * (sum of `min` for each missing tool) so the model can satisfy all
   * minimums in one tool_calls turn. If omitted, defaults to 1 per
   * distinct missing tool.
   */
  requirements?: ToolEmissionRequirement[];
  emittedToolNames: string[];
  executableNames: ReadonlySet<string> | null;
  sessionId: string;
  userMessage: string;
  agentOutputs: { name: string; role: string; content: string }[];
  config: PureCouncilConfig;
  effectiveProvider: string;
  effectiveModel: string;
  /** Callback to bump the per-member tool-call counter on each retry emission. */
  onToolCall: () => void;
  /** v1.7.0 (Pass-2 agy finding): see applyCompletionRetry. */
  languageModule?: SystemPromptModule;
}): AsyncGenerator<BrainEvent, void, void> {
  if (args.check.ok) return;
  const missingToolNames = args.check.missing.map((m) => m.split(' ')[0]);
  if (!shouldRetryMember(missingToolNames, 0)) return;
  // eslint-disable-next-line no-console
  console.warn(`[council] ${args.agent.id} retrying missing tools: ${missingToolNames.join(', ')}`);
  // Build the minPerTool map from the original requirements so the
  // retry turn budgets enough tool calls to satisfy every minimum.
  // Without this, a createTask min:12 requirement would be capped at
  // 1 call (the number of distinct missing tools).
  const minPerTool: Record<string, number> = {};
  if (args.requirements) {
    for (const req of args.requirements) {
      if (missingToolNames.includes(req.name)) {
        minPerTool[req.name] = req.min;
      }
    }
  }
  try {
    const retryGenerator = runRetryTurnForMember({
      agent: args.agent,
      missingToolNames,
      minPerTool,
      executableTools: args.executableNames,
      userMessage: args.userMessage,
      ragContext: args.config.ragContext,
      workspaceContext: args.config.workspaceContext,
      priorOutputs: args.agentOutputs,
      aiConfig: args.config.aiConfig,
      sessionId: args.sessionId,
      effectiveModel: args.effectiveModel,
      effectiveProvider: args.effectiveProvider,
      eventBus: args.config.eventBus,
      toolRegistry: args.config.tools,
      providerStream: args.config.providerStream,
      runMode: args.config.runMode,
      languageModule: args.languageModule,
    });
    for await (const event of retryGenerator) {
      if (event.type === 'tool_execution_start') {
        args.onToolCall();
        args.emittedToolNames.push(event.toolName);
      }
      yield event;
    }
  } catch (retryErr) {
    // eslint-disable-next-line no-console
    console.error(`[council] ${args.agent.id} retry failed:`, retryErr);
  }
  // Re-run the check so the final warning reflects the union of
  // original + retry emissions.
  enforceDesignPhaseToolEmissions(args.agent.id, args.emittedToolNames);
}
