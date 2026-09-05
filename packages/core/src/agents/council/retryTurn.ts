/**
 * retryTurn — forced tool-emission retry turns (v0.7.7 Pass 3), extracted
 * verbatim from agents/councilApi.ts.
 */
import type { BrainEvent } from '../../shared/events.js';
import { AgentHarness } from '../../core/AgentHarness.js';
import type { AgentToolSpec, ProviderStreamFn } from '../../core/AgentHarness.js';
import type { AgentRole } from '../../types/index.js';
import type { SystemPromptConfig, SystemPromptModule } from '../../types/systemTypes.js';
import type { CouncilRunMode } from '../../council/runMode.js';
import { getProviderTools } from '../toolSchemas.js';
import { buildAgentMessages } from './memberMessages.js';
import { enforceDesignPhaseToolEmissions } from './toolEmission.js';
import type { ToolEmissionCheckResult, ToolEmissionRequirement } from './toolEmission.js';
import type { PureCouncilConfig } from './types.js';

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
    args.languageModule,
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
