// @ts-nocheck — pre-existing strict-mode type narrowing issues carried over
// from app.tsx. Runtime is correct; tighten signatures in a follow-up.
import { useState, useRef, useCallback } from "react";
import type { ChatMessage } from "../components/ChatStream.js";
import { AgentHarness } from "@zelari/core/harness";
import type { AgentMessage } from "@zelari/core/harness";
import { SessionJsonlWriter } from "@zelari/core/harness";
import { MetricsLogger, getMetricsLogger } from "../metrics.js";
import { calculateCost } from "../modelPricing.js";
import {
  openaiCompatibleProvider,
  providerFromEnv,
  providerConfigFor,
  resolveActiveProvider,
} from "../provider/openai-compatible.js";
import { providerFailover } from "../providerFailover.js";
import { resolveFailoverStream } from "../crossProviderFailover.js";
import { resolveShell } from "@zelari/core/harness/tools/builtin/shellResolver";
import { PROVIDERS } from "../keyStore.js";
import { createBuiltinToolRegistry } from "../toolRegistry.js";
import {
  buildSystemPrompt,
  getAllTools,
  SINGLE_AGENT_IDENTITY_MODULE,
  buildLanguagePolicyModuleFor,
} from "@zelari/core/skills";
import {
  parseClarificationRequest,
  cleanAgentContent,
} from "@zelari/core";
import {
  appendOrExtendStreamingAssistant,
  appendSystem,
  appendToolStart,
  finalizeStreamingAssistant,
  updateToolMessageEnd,
} from "./messageHelpers.js";
import {
  setStreaming,
  finalizeStreaming,
  startTool,
  completeTool,
  type LiveState,
} from "./chatState.js";
import {
  getHistory,
  compactInPlace,
  appendMessages,
  clearHistory,
  setLastClarification,
  maybeAnchorShortAnswer,
  formatHistoryForCouncil,
  setHistory,
} from "./conversationContext.js";
import type { ProviderName } from "../keyStore.js";
import { computeSessionStatsDelta } from "./chatStats.js";
import { envNumber } from "../utils/envNumber.js";
import { getPhase } from "../phaseState.js";
import { describePhase } from "../phase.js";
import { applyBudgetPolicy } from "../budget/tokenBudget.js";

/**
 * useChatTurn — owns the chat-turn lifecycle (single prompt dispatch +
 * council dispatch + queue management).
 *
 * v0.7.0 static-scrollback refactor: streaming + tool-start/end now route
 * through the `live` region (`setStreaming`/`startTool`/`completeTool`/
 * `finalizeStreaming` from chatState.ts). System/user/sealed-assistant
 * messages still go to `setMessages` (= finalized). When `live`-related
 * params are omitted (legacy tests, single-array model), the hook falls
 * back to the v0.6 streaming-into-`messages` behavior so existing tests
 * keep passing unchanged.
 *
 * Extracted from app.tsx (Task v0.4.2 audit split). The hook is purely
 * state + side effects: callers pass the shared chat state setters and
 * the writerRef + sessionId, and receive back the dispatch callbacks,
 * the harnessRef (for /steer interrupt), and the queue counter.
 *
 * Two dispatch paths:
 *   - dispatchPrompt(userText) — single LLM call via AgentHarness. Used for
 *     normal user prompts and /skill invocations.
 *   - dispatchCouncilPrompt(text) — multi-agent council dispatch via
 *     dispatchCouncil. Surfaces tool_execution_start/end as 'tool' role
 *     messages so the LiveRegion renders them.
 */
export interface UseChatTurnParams {
  sessionId: string;
  writerRef: React.MutableRefObject<SessionJsonlWriter | null>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /**
   * Throttled setter for the streaming hot-path. In the v0.7.0 live-region
   * model this throttles `live`; in the legacy single-array model it
   * throttles `messages`. Coalesces ~50-200/sec calls into ≤60/sec renders.
   */
  commitStreaming: React.Dispatch<React.SetStateAction<any>>;
  /** Drain pending streamed updates synchronously. Called on stream/turn end. */
  flushStreaming: () => void;
  setBusy: (v: boolean) => void;
  setSessionActive: (v: boolean) => void;
  setSessionStats: React.Dispatch<
    React.SetStateAction<{ totalTokens: number; totalCostUsd: number; cachedTokens?: number }>
  >;
  // ── v0.7.0 live-region wiring (optional; legacy fallback when omitted) ──
  /** The live region setter (streaming bubble + pending tools). */
  setLive?: React.Dispatch<React.SetStateAction<LiveState>>;
  /** Always-current live snapshot for non-reactive event-loop reads. */
  liveRef?: React.MutableRefObject<LiveState>;
  /**
   * v1.6.0: opens an interactive picker when the agent poses a clarifying
   * question (---QUESTION--- block). Optional — when omitted (tests), the
   * question is still visible as text and rolling history alone ensures the
   * user's typed answer binds to the question on the next turn.
   */
  setPicker?: (
    req: import("../slashHandlers/provider.js").PickerRequest | null,
  ) => void;
}

export interface UseChatTurnResult {
  dispatchPrompt: (
    userText: string,
    opts?: { requiredTools?: readonly string[] },
  ) => Promise<void>;
  dispatchCouncilPrompt: (input: string) => Promise<void>;
  harnessRef: React.MutableRefObject<AgentHarness | null>;
  queueCount: number;
  setQueueCount: (n: number) => void;
  /** Reset provider rolling history (call from /clear and /new). */
  clearConversationHistory: () => void;
}

export function useChatTurn(params: UseChatTurnParams): UseChatTurnResult {
  const {
    sessionId,
    writerRef,
    setMessages,
    commitStreaming,
    flushStreaming,
    setBusy,
    setSessionActive,
    setSessionStats,
    setLive,
    liveRef,
    setPicker,
  } = params;
  const harnessRef = useRef<AgentHarness | null>(null);
  const [queueCount, setQueueCount] = useState<number>(0);
  // v1.8.0: rolling history lives in conversationContext (shared by agent,
  // council, zelari) so /clear|/new can reset it and short answers bind
  // across all modes. Seed for turn N is [system, ...history, user_N].

  // v0.7.0: when the live region is wired, streaming + tool events route
  // there; otherwise we fall back to the v0.6 single-array behavior so the
  // existing unit tests (which pass only setMessages/commitStreaming) keep
  // asserting on `messages` directly.
  const useLiveModel = !!(setLive && liveRef);

  const clearConversationHistory = useCallback(() => {
    clearHistory();
  }, []);

  const dispatchPrompt = useCallback(
    async (
      userText: string,
      opts?: {
        /**
         * v0.7.5: tool names a /skill invocation requires. Workspace stubs
         * in this list (createTask, createDocument, searchDocuments, …) are
         * registered for THIS turn so the skill's instructions are actually
         * executable — previously /skill architect-feature told the model to
         * create tasks with tools that were not in its registry.
         */
        requiredTools?: readonly string[];
      },
    ) => {
      // v0.4.3 audit fix: provider resolution + harness construction now
      // live INSIDE the try block. Previously, throws from providerFromEnv,
      // resolveFailoverStream, or createBuiltinToolRegistry happened
      // BEFORE the try (which only wrapped the stream loop), so the
      // rejected promise escaped unhandled (useSlashDispatch doesn't
      // try/catch its await either). The user saw a hang with no
      // feedback instead of an actionable error message.
      let envConfig: Awaited<ReturnType<typeof providerFromEnv>>;
      let harness: AgentHarness;
      // v1.6.0: length of the history seed actually passed to the harness.
      // Captured here (after compaction) so the finally block can slice off
      // exactly the seed and keep only this turn's newly-appended tail.
      let historySeedLen = 0;
      // v1.6.0: set true only after the stream loop completes without
      // throwing, so the finally snapshot is skipped on error (a failed
      // turn — provider 500, abort — must not pollute rolling history
      // with a partial assistant tail).
      let turnSucceeded = false;
      try {
        // v1.8.0: budget-aware compact (phase plan/build + occupancy thresholds).
        compactInPlace();
        const budget = applyBudgetPolicy(getHistory(), getPhase());
        setHistory(budget.history);
        for (const w of budget.warnings) {
          appendSystem(setMessages, w, Date.now());
        }
        historySeedLen = getHistory().length;
        // Short-answer anchor: if the user is replying to a ---QUESTION---,
        // rewrite the user message so the model cannot treat "full"/"2" as
        // a brand-new request even if compaction dropped the prior turn.
        const anchored = maybeAnchorShortAnswer(userText);
        const effectiveUserText = anchored ?? userText;
        envConfig = await providerFromEnv();
        if (!envConfig) {
          // Name the ACTIVE provider — the old hardcoded "OPENAI_API_KEY not
          // set" message told grok/glm/minimax users to export the wrong var.
          const active = resolveActiveProvider();
          const spec = PROVIDERS.find((p) => p.id === active);
          appendSystem(
            setMessages,
            `No API key for the active provider "${active}". Set ${spec?.envVar ?? "the provider API key env var"} or run /login ${active}.`,
          );
          return;
        }
        setBusy(true);
        const workPhase = getPhase();
        const { registry: toolRegistry } = createBuiltinToolRegistry({
          planMode: workPhase === "plan",
        });
        const baseProviderStream = openaiCompatibleProvider(envConfig);
        const failoverResolution = await resolveFailoverStream({
          failoverEnabled: process.env.ANATHEMA_FAILOVER !== "0",
          envValue: process.env.ANATHEMA_FAILOVER_PROVIDER,
          primaryProviderId: envConfig.providerId,
          primary: baseProviderStream,
          validProviderIds: PROVIDERS.map((p) => p.id),
          lookupFallbackConfig: async (id) =>
            providerConfigFor(id as ProviderName),
          buildStream: (config) =>
            openaiCompatibleProvider(
              config as Parameters<typeof openaiCompatibleProvider>[0],
            ),
        });
        if (failoverResolution.warning) {
          // Surface in the chat instead of console.warn: writes that bypass
          // Ink force a full repaint of the TUI frame (visible flicker).
          appendSystem(setMessages, `[failover] ${failoverResolution.warning}`);
        }
        const providerStream: import("@zelari/core/harness").ProviderStreamFn =
          failoverResolution.fallbackLabel
            ? providerFailover({
                primary: baseProviderStream,
                fallback: failoverResolution.fallback,
                fallbackLabel: failoverResolution.fallbackLabel,
              })
            : providerFailover({
                primary: baseProviderStream,
                fallback: failoverResolution.fallback,
              });
        const cwd = process.cwd();
        // v0.7.3: surface the council plan (if any) to the single agent too.
        // The plan lives in .zelari/plan.json but the agent had no idea it
        // existed — users had to paste task-file paths by hand. Best-effort:
        // no plan → null → zero prompt-token cost.
        let planSummary: string | null = null;
        // v0.7.4: give the single agent the same project awareness the council
        // has (tech stack, file layout, scripts) plus a pointer to the council
        // workspace so it reads .zelari/plan.json with its own tools.
        let workspaceSummary: string | null = null;
        let zelariReadHint = "";
        try {
          const {
            buildPlanSummary,
            buildWorkspaceSummary,
            buildZelariReadHint,
          } = await import("../workspace/workspaceSummary.js");
          planSummary = buildPlanSummary(cwd);
          workspaceSummary = buildWorkspaceSummary(cwd);
          zelariReadHint = buildZelariReadHint(cwd);
          // v0.7.4: close the plan loop. The single agent implements the tasks
          // the council planned, but had no official way to advance their
          // status — it would have to hand-edit plan.json with write_file
          // (racy, no validation). Register the workspace `updateTask` stub so
          // status changes go through the same mutex + atomic plan.json write
          // the council uses. Only when a plan exists: fresh projects don't pay
          // the extra tool-schema prompt tokens.
          // v0.7.5: also register any workspace stubs a /skill invocation
          // requires (opts.requiredTools), mapping the Electron-era `searchRAG`
          // to the CLI's `searchDocuments`.
          const wantedWorkspaceTools = new Set<string>();
          if (planSummary) wantedWorkspaceTools.add("updateTask");
          const WORKSPACE_STUB_NAMES = new Set([
            "createPhase",
            "createTask",
            "updateTask",
            "addIdea",
            "createMilestone",
            "createDocument",
            "searchDocuments",
            "linkDocuments",
            "getDocumentBacklinks",
          ]);
          for (const raw of opts?.requiredTools ?? []) {
            const name = raw === "searchRAG" ? "searchDocuments" : raw;
            if (WORKSPACE_STUB_NAMES.has(name)) wantedWorkspaceTools.add(name);
          }
          if (wantedWorkspaceTools.size > 0) {
            const { createWorkspaceContext } =
              await import("../workspace/stubs.js");
            const { createWorkspaceToolRegistry } =
              await import("../workspace/toolRegistry.js");
            const wsRegistry = createWorkspaceToolRegistry(
              createWorkspaceContext(cwd),
            );
            for (const name of wantedWorkspaceTools) {
              const td = wsRegistry.get(name);
              if (td) toolRegistry.register(td);
            }
          }
          // v0.7.5: MCP tools. Discovery runs once per process (lazy singleton);
          // per-turn cost after that is just re-registering into the fresh
          // registry. Disabled with ZELARI_MCP=0. Best-effort like the rest.
          try {
            const { registerMcpTools } = await import("../mcp/mcpManager.js");
            const mcp = await registerMcpTools(toolRegistry, cwd);
            for (const w of mcp.warnings) appendSystem(setMessages, w);
          } catch {
            // MCP is an enhancement — a broken server config must not block prompts.
          }
        } catch {
          // Plan summary is a nice-to-have — never block a prompt on it.
        }
        // NOTE: computed AFTER the workspace wiring so updateTask (when
        // registered) is advertised in the # Available Tools section too.
        const openAiTools = toolRegistry.toOpenAITools();
        const toolListNames = openAiTools.map((t) => t.function.name);
        const toolList = openAiTools
          .map((t) => `- ${t.function.name}: ${t.function.description}`)
          .join("\n");
        // v0.7.2 (C3): platform-aware shell guidance. The model must know which
        // shell the `bash` tool actually runs in so it writes the right commands
        // (POSIX for Git Bash, Windows-native for cmd.exe fallback).
        const resolvedShell = resolveShell();
        const isWindows = process.platform === "win32";
        const shellGuidance = resolvedShell.isBash
          ? `The bash tool runs commands via Git Bash / MSYS2 (${resolvedShell.shell}). Write POSIX commands: ls, grep, $VAR, &&, /c/Users/... all work.`
          : isWindows
            ? `The bash tool runs commands via cmd.exe (Git Bash not found). Write Windows-native commands: use dir (not ls), %VAR% (not $VAR), avoid POSIX-only syntax.`
            : `The bash tool runs commands via /bin/sh.`;
        // v0.7.3: the shell has NO interactive stdin. Without this warning the
        // model retried `npm create vite` four times against the interactive
        // prompt ("Operation cancelled") and then gave up asking the user.
        const nonInteractiveGuidance =
          "The shell is NON-INTERACTIVE (stdin closed): commands that prompt for input fail immediately. " +
          "Always pass non-interactive flags (--yes, -y, --template, --force). " +
          "If a scaffolder still insists on prompting (e.g. `npm create vite` in a non-empty directory), do NOT retry it — " +
          "scaffold into a fresh empty subdirectory and move the files, or write package.json/configs/sources yourself with write_file, then run `npm install`.";
        // v1.5.3: build the single-agent system prompt through buildSystemPrompt(),
        // the same builder the council uses. This routes the 7 behavioral
        // directives (anti-confabulation, act-don't-describe, output self-check,
        // clarification protocol, safety, formatting, tool-usage) to the 90%
        // path that previously got an inline array and missed them all. The
        // SINGLE_AGENT_IDENTITY_MODULE overrides the council-flavored
        // 'base-identity' module so the persona is "Zelari Code in the terminal",
        // not "member of an AI Council".
        const planPhaseBlock =
          workPhase === "plan"
            ? [
                "",
                "# Work Phase: PLAN",
                "You are in PLAN mode. Explore and design only.",
                "- Do NOT implement production code or run destructive shell commands.",
                "- write_file / edit_file / bash / apply_diff are unavailable.",
                "- Produce a clear plan, ask clarifying questions (---QUESTION---), use workspace plan tools when relevant.",
                "- When the plan is ready, tell the user to run /build to implement.",
              ].join("\n")
            : workPhase === "build"
              ? [
                  "",
                  "# Work Phase: BUILD",
                  "Implement on disk. Prefer acting over describing.",
                  "- Prior plan/synthesis text is a SPEC to apply — not proof files already changed.",
                  "- You MUST use write_file/edit_file for every file you change before claiming done.",
                  "- After read_file: if the planned change is missing, WRITE it — do not stop at analysis.",
                  "- Never claim already-implemented based only on reading a plan or skimming code.",
                  planSummary
                    ? "- An approved plan exists in the workspace — implement it and update task statuses as you go."
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n")
              : "";
        const shellContextBlock = [
          "# Platform & Shell",
          `platform: ${process.platform}`,
          `shell: ${resolvedShell.via}`,
          shellGuidance,
          nonInteractiveGuidance,
          planPhaseBlock,
          "",
          "# Working Directory",
          `You are running in: ${cwd}`,
          "All relative file paths are resolved against this directory. Always work with real files here.",
          ...(planSummary
            ? [
                "",
                "# Plan Tracking",
                '- Plan tasks: when you START working on a plan task call updateTask {taskId, status: "in_progress"}; when it is complete and verified call updateTask {taskId, status: "done"}. NEVER edit .zelari/plan.json by hand.',
              ]
            : []),
        ].join("\n");
        const singleAgentRole = {
          id: "single",
          name: "Zelari Code",
          codename: "zelari",
          role: "interactive coding agent",
          color: "#00d9a3",
          avatar: "◆",
          tools: toolListNames,
          systemPrompt: shellContextBlock,
        };
        // workspaceContext + ragContext carry the summaries that were inline
        // before; the builder places them under # Current Workspace State and
        // # Retrieved Knowledge (RAG) headers.
        const workspaceContext = [workspaceSummary, zelariReadHint]
          .filter(Boolean)
          .join("\n\n");
        // v1.5.3: build via the shared builder. Wrap in try/catch with a
        // minimal fallback so a builder failure (e.g. test context without a
        // populated catalog) never breaks dispatch — the harness still gets a
        // usable system prompt and the turn proceeds.
        let systemPrompt: string;
        try {
          // v1.7.0: detect the user's language and inject the language-policy
          // module so the agent replies in the user's language. Honors
          // ZELARI_RESPONSE_LANG override (auto|it|en|fr|...). The module is
          // appended to customPromptModules alongside SINGLE_AGENT_IDENTITY_MODULE
          // — it lives in priority space (5) so it sorts BEFORE the base-identity
          // module (10): the model sets language scaffolding before reading role text.
          const languageModule = buildLanguagePolicyModuleFor(userText);
          const { loadProjectInstructions } = await import(
            "../workspace/projectInstructions.js"
          );
          const projectInstructions = loadProjectInstructions(
            process.cwd(),
          ).content;
          systemPrompt = buildSystemPrompt(singleAgentRole, {
            tools: getAllTools(),
            toolNames: toolListNames,
            mode: "agent",
            projectInstructions: projectInstructions || undefined,
            aiConfig: {
              enabledSkills: [],
              enabledTools: toolListNames,
              customPromptModules: [
                SINGLE_AGENT_IDENTITY_MODULE,
                languageModule,
              ],
              agentSkillConfigs: [],
            },
            workspaceContext: workspaceContext || undefined,
            ragContext: planSummary || undefined,
          });
        } catch {
          // Fallback: identity + platform/shell + tool list. Keeps the turn
          // runnable even if the builder or catalog is unavailable.
          const languageModule = buildLanguagePolicyModuleFor(userText);
          systemPrompt = [
            SINGLE_AGENT_IDENTITY_MODULE.content,
            languageModule.content,
            shellContextBlock,
            "# Available Tools",
            "You can call these tools. Use them to take action and gather information autonomously:",
            toolList,
            ...(workspaceContext ? ["", workspaceContext] : []),
            ...(planSummary ? ["", planSummary] : []),
          ].join("\n");
        }
        // v0.7.1 (A2): per-turn tool-call budget for single-prompt turns.
        // The council sets 5; the single-prompt path previously set NONE, so a
        // flailing model could loop for the full MAX_TOOL_LOOP_ITERATIONS (12)
        // of junk calls (e.g. read_file same path ×3 then silence). Default 25,
        // overridable via ZELARI_MAX_TOOL_CALLS.
        const maxToolCallsPerTurn = envNumber(process.env.ZELARI_MAX_TOOL_CALLS, {
          default: 25,
          min: 1,
        });
        // v1.5.2 / v1.8.0 / v1.8.3: soft tool-loop + optional hard ceiling.
        // Soft can auto-extend until hard so multi-step work finishes.
        const maxToolLoopIterations = budget.maxToolLoopIterations;
        const maxToolLoopHardCap = envNumber(process.env.ZELARI_MAX_TOOL_LOOP_HARD, {
          default: 0, // 0 → harness default (soft×3, min soft+60)
          min: 0,
        });
        const harness = new AgentHarness({
          model: envConfig.model,
          provider: "openai-compatible",
          messages: [
            { role: "system", content: systemPrompt },
            // v1.8.0: shared rolling history (agent/council/zelari) so short
            // answers bind to prior ---QUESTION--- blocks. Possibly empty
            // when ZELARI_HISTORY_TURNS=0.
            ...getHistory(),
            { role: "user", content: effectiveUserText },
          ],
          tools: toolRegistry.toOpenAITools().map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
          toolRegistry,
          providerStream,
          cwd,
          maxToolCallsPerTurn,
          maxToolLoopIterations,
          ...(maxToolLoopHardCap > 0 ? { maxToolLoopHardCap } : {}),
        });
        harnessRef.current = harness;
        setQueueCount(harness.queueLength);

        // Total assistant output across the whole turn — feeds the token/cost
        // estimate fallback in computeSessionStatsDelta.
        let assistantContent = "";
        // Display buffer for the CURRENT streamed message only. Reset on every
        // message_end: without this, the post-tool-call message re-rendered the
        // full accumulated turn text, duplicating everything said before the
        // tool ran.
        let streamContent = "";
        // tool_execution_end doesn't carry toolName — remember it from the
        // matching start event (keyed by toolCallId) for metrics.
        const toolNameById = new Map<string, string>();
        const metrics: MetricsLogger = getMetricsLogger();
        let realUsage: {
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
          cachedPromptTokens?: number;
        } | null = null;
        try {
          for await (const event of harness.run()) {
            if (event.type === "message_end") {
              if (event.usage) realUsage = event.usage;
              // Message boundary: drain buffered deltas, then seal the streamed
              // bubble so the next message starts fresh instead of merging.
              flushStreaming();
              if (useLiveModel) finalizeStreaming(setMessages, setLive!);
              else finalizeStreamingAssistant(setMessages);
              streamContent = "";
            }
            if (event.type === "queue_update") {
              setQueueCount(harness.queueLength);
            }
            if (writerRef.current) {
              await writerRef.current.append(event);
            }
            if (event.type === "agent_end") {
              metrics.record({
                kind: "run",
                sessionId,
                provider: envConfig.providerId,
                model: envConfig.model,
                latencyMs: event.durationMs,
                ok: event.reason === "stop",
              });
            } else if (event.type === "error") {
              metrics.record({
                kind: "error",
                sessionId,
                provider: envConfig.providerId,
                model: envConfig.model,
                error: event.message,
              });
            } else if (event.type === "tool_execution_end") {
              metrics.record({
                kind: "tool",
                sessionId,
                provider: envConfig.providerId,
                model: envConfig.model,
                toolName: toolNameById.get(event.toolCallId) ?? "unknown",
                toolCallId: event.toolCallId,
                durationMs: event.durationMs,
                ok: !event.isError,
              });
            }
            if (event.type === "message_delta") {
              assistantContent += event.delta;
              streamContent += event.delta;
              // v1.8.1: hide <think>… from the live bubble while streaming so
              // private reasoning never flashes in the TUI (full scrub also
              // runs on turn end).
              const displayContent = cleanAgentContent(streamContent);
              // Route through the throttled setter so per-token deltas (50-200/sec)
              // coalesce into ≤60 renders/sec instead of flickering the TUI.
              if (useLiveModel) {
                setStreaming(commitStreaming, displayContent, Date.now(), {
                  ...(event.memberId ? { memberId: event.memberId } : {}),
                  ...(event.memberName ? { memberName: event.memberName } : {}),
                });
              } else {
                // Legacy single-array fallback (existing tests).
                appendOrExtendStreamingAssistant(
                  commitStreaming,
                  displayContent,
                  Date.now(),
                  {
                    ...(event.memberId ? { memberId: event.memberId } : {}),
                    ...(event.memberName
                      ? { memberName: event.memberName }
                      : {}),
                  },
                );
              }
            } else if (event.type === "error") {
              flushStreaming();
              // Budget extension is informational, not a hard error.
              if (event.code === "tool_budget_extended") {
                appendSystem(
                  setMessages,
                  `[budget] ${event.message}`,
                  Date.now(),
                );
              } else {
                appendSystem(setMessages, `[error] ${event.message}`, Date.now());
              }
            } else if (event.type === "tool_execution_start") {
              toolNameById.set(event.toolCallId, event.toolName);
              // Drain buffered deltas FIRST so the text streamed before the
              // call renders above the tool line, not below it — then seal
              // that bubble: it's complete once the model starts calling tools.
              flushStreaming();
              if (useLiveModel) {
                finalizeStreaming(setMessages, setLive!);
                startTool(
                  setLive!,
                  event.toolName,
                  event.toolCallId,
                  event.args,
                  event.ts,
                );
              } else {
                finalizeStreamingAssistant(setMessages);
                appendToolStart(
                  setMessages,
                  event.toolName,
                  event.toolCallId,
                  event.args,
                  event.ts,
                );
              }
              // The pre-tool bubble is sealed: reset the display buffer so the
              // next delta starts a fresh bubble instead of re-showing (and
              // duplicating) the text already printed above the tool line.
              streamContent = "";
            } else if (event.type === "tool_execution_end") {
              if (useLiveModel) {
                completeTool(
                  setMessages,
                  setLive!,
                  event.toolCallId,
                  event.isError,
                  event.durationMs,
                  event.result,
                );
              } else {
                updateToolMessageEnd(
                  setMessages,
                  event.toolCallId,
                  event.isError,
                  event.durationMs,
                  event.result,
                );
              }
            }
          }
          turnSucceeded = true;
        } finally {
          // Drain any buffered streaming deltas so the final assistant message
          // is committed before busy flips to false (and the input re-enables).
          flushStreaming();
          if (useLiveModel) finalizeStreaming(setMessages, setLive!);
          else finalizeStreamingAssistant(setMessages);
          // v1.6.0: snapshot this turn's tail (assistant text + tool_calls +
          // tool results that harness.run() appended) so the NEXT turn sees
          // them as history. The seed we passed was
          // [system, ...historySeed, user], so the tail is everything after
          // that prefix. We snapshot BEFORE nulling harnessRef. Skipped on
          // error (turnSucceeded is false) — a failed turn doesn't pollute
          // history with a partial assistant tail.
          try {
            const h = harnessRef.current;
            if (h && turnSucceeded) {
              const all = h.getMessages();
              const seedLen = 1 /*system*/ + historySeedLen + 1 /*user*/;
              if (all.length > seedLen) {
                // Provider history: KEEP <think> (MiniMax-M3 interleaved tool
                // use requires full assistant content) and KEEP ---QUESTION---
                // so short answers bind. Still strip MiniMax XML tool dumps
                // and proprietary leaks via cleanAgentContent.
                appendMessages(
                  all.slice(seedLen).map((m) =>
                    m.role === "assistant" && m.content
                      ? {
                          ...m,
                          content: cleanAgentContent(m.content, {
                            stripQuestion: false,
                            stripThink: false,
                          }),
                        }
                      : m,
                  ),
                );
              }
            }
          } catch {
            // Non-fatal: a snapshot failure must never break the turn.
          }
          // v1.8.1: ALWAYS strip <think>/QUESTION private channels from the
          // display transcript after a successful turn — not only when a
          // clarifying picker opens. Otherwise GLM/MiniMax reasoning leaks
          // into the TUI as visible assistant prose.
          // Only call setMessages when at least one bubble needs scrubbing —
          // returning the same `prev` array ref from a functional updater is
          // fine for React, but breaks test harnesses that wipe-then-push.
          if (turnSucceeded && assistantContent) {
            try {
              const needsScrub =
                assistantContent.includes("<think") ||
                assistantContent.includes("<thinking") ||
                assistantContent.includes("---QUESTION---");
              if (needsScrub) {
                setMessages((prev) =>
                  prev.map((m) => {
                    if (m.role !== "assistant") return m;
                    if (
                      !m.content.includes("<think") &&
                      !m.content.includes("<thinking") &&
                      !m.content.includes("---QUESTION---")
                    ) {
                      return m;
                    }
                    const cleaned = cleanAgentContent(m.content);
                    return cleaned === m.content ? m : { ...m, content: cleaned };
                  }),
                );
              }

              const clar = parseClarificationRequest(assistantContent);
              if (clar && clar.choices && clar.choices.length >= 2) {
                setLastClarification({
                  question: clar.question,
                  choices: clar.choices,
                });
                if (setPicker) {
                  setPicker({
                    kind: "clarification",
                    title: clar.question,
                    items: clar.choices.map((c) => ({ value: c, label: c })),
                    onAnswer: (value: string) => {
                      void dispatchPrompt(value);
                    },
                  });
                }
              } else {
                setLastClarification(null);
              }
            } catch {
              // Parsing/picker failure must never break the turn.
            }
          }
          harnessRef.current = null;
          setQueueCount(0);
          setBusy(false);
          setSessionStats((prev) =>
            computeSessionStatsDelta(
              realUsage,
              userText,
              assistantContent,
              envConfig.model,
              prev,
            ),
          );
        }
      } catch (err) {
        // v0.4.3 audit fix: catches throws from providerFromEnv /
        // resolveFailoverStream / AgentHarness construction that were
        // previously escaping the function unhandled. Surfaces the error
        // to the chat instead of hanging silently.
        // Flush first so any partial assistant content streamed before the
        // throw is committed before the error message renders.
        flushStreaming();
        appendSystem(
          setMessages,
          `[dispatch error] ${err instanceof Error ? err.message : String(err)}`,
        );
        setBusy(false);
      }
    },
    [
      sessionId,
      writerRef,
      setMessages,
      commitStreaming,
      flushStreaming,
      setBusy,
      setSessionActive,
      setSessionStats,
      useLiveModel,
      setLive,
      liveRef,
    ],
  );

  const dispatchCouncilPrompt = useCallback(
    async (text: string) => {
      await dispatchCouncilPromptImpl(text, {
        sessionId,
        writerRef,
        setMessages,
        commitStreaming,
        flushStreaming,
        setBusy,
        setQueueCount,
        setLive,
        liveRef,
        setPicker,
      });
    },
    [
      sessionId,
      writerRef,
      setMessages,
      commitStreaming,
      flushStreaming,
      setBusy,
      setQueueCount,
      setLive,
      liveRef,
      setPicker,
    ],
  );

  const pendingZelariRef = useRef<{ userMessage: string } | null>(null);
  const dispatchZelariPrompt = useCallback(
    async (text: string) => {
      await dispatchZelariPromptImpl(
        text,
        {
          sessionId,
          writerRef,
          setMessages,
          commitStreaming,
          flushStreaming,
          setBusy,
          setQueueCount,
          setLive,
          liveRef,
        },
        pendingZelariRef,
      );
    },
    [
      sessionId,
      writerRef,
      setMessages,
      commitStreaming,
      flushStreaming,
      setBusy,
      setQueueCount,
      setLive,
      liveRef,
    ],
  );

  return {
    dispatchPrompt,
    dispatchCouncilPrompt,
    dispatchZelariPrompt,
    harnessRef,
    queueCount,
    setQueueCount,
    clearConversationHistory,
  };
}

/**
 * dispatchCouncilPrompt — multi-agent council dispatch.
 *
 * Surfaces tool_execution_start/end as 'tool' role messages so the live
 * region renders them. Runs AGENTS.MD auto-maintenance after the
 * council finishes (controlled by ZELARI_AGENTS_MD env var).
 *
 * Implementation lives outside the hook closure so it doesn't depend on the
 * hook's identity for memoization. Callers receive a stable callback via the
 * useChatTurn wrapper.
 */
/** One council slice's outcome, consumed by the Zelari mission loop. */
export interface CouncilSliceResult {
  completionOk: boolean;
  ran: boolean;
  synthesisText?: string;
  /** Project-file writes (write_file/edit_file) counted this slice. */
  writeCount?: number;
  /** The council flagged this slice as a degraded (non-hand-off) run. */
  degraded?: boolean;
}

/** Per-slice overrides injected by the Zelari driver. */
interface CouncilRunOverrides {
  ragContext?: string;
  runMode?: "implementation" | "design-phase";
  maxToolCallsChairman?: number;
}

async function dispatchCouncilPromptImpl(
  text: string,
  deps: UseChatTurnParams & { setQueueCount: (n: number) => void },
  overrides: CouncilRunOverrides = {},
): Promise<CouncilSliceResult> {
  const {
    sessionId,
    writerRef,
    setMessages,
    commitStreaming,
    flushStreaming,
    setBusy,
    setLive,
    liveRef,
    setPicker,
  } = deps;
  const useLiveModel = !!(setLive && liveRef);
  const envConfig = await providerFromEnv();
  if (!envConfig) {
    const active = resolveActiveProvider();
    const spec = PROVIDERS.find((p) => p.id === active);
    appendSystem(
      setMessages,
      `No API key for the active provider "${active}". Set ${spec?.envVar ?? "the provider API key env var"} or run /login ${active} before invoking /council.`,
    );
    return { completionOk: false, ran: false };
  }
  setBusy(true);
  // v1.8.0: compact shared history + budget + short-answer anchor.
  compactInPlace();
  const councilBudget = applyBudgetPolicy(getHistory(), getPhase());
  setHistory(councilBudget.history);
  for (const w of councilBudget.warnings) {
    appendSystem(setMessages, w, Date.now());
  }
  const anchored = maybeAnchorShortAnswer(text);
  const effectiveText = anchored ?? text;
  appendSystem(
    setMessages,
    `[phase] ${describePhase(getPhase())}`,
    Date.now(),
  );
  // Import dynamically to avoid a circular dep at module-load time.
  const { dispatchCouncil } = await import("../councilDispatcher.js");
  const { createWorkspaceContext, createWorkspaceStubs } =
    await import("../workspace/stubs.js");
  const { createWorkspaceToolRegistry } =
    await import("../workspace/toolRegistry.js");
  const { setWorkspaceStubs } = await import("@zelari/core/skills");
  const { runPostCouncilHook } =
    await import("../workspace/postCouncilHook.js");
  const { buildWorkspaceSummary, buildPlanSummary } =
    await import("../workspace/workspaceSummary.js");
  const { buildLessonsSummary } =
    await import("../workspace/buildLessonsSummary.js");
  const { FeedbackStore } = await import("../councilFeedback.js");

  const workPhase = getPhase();
  const { registry: councilToolRegistry } = createBuiltinToolRegistry({
    planMode: workPhase === "plan",
  });
  const workspaceCtx = createWorkspaceContext();
  const workspaceReg = createWorkspaceToolRegistry(workspaceCtx);
  for (const name of workspaceReg.list()) {
    const td = workspaceReg.get(name);
    if (!td) continue;
    // Plan phase: keep workspace plan/doc tools (createPlan, …); skip any
    // that are pure project-file mutators if ever added.
    councilToolRegistry.register(td);
  }
  // Force council design-phase when UI phase is plan (and vice-versa for build).
  const phaseRunMode =
    overrides.runMode ??
    (workPhase === "plan" ? "design-phase" : "implementation");
  // v0.7.5: MCP tools for the council too (same lazy singleton as the
  // single-agent path — zero extra spawns).
  try {
    const { registerMcpTools } = await import("../mcp/mcpManager.js");
    const mcp = await registerMcpTools(councilToolRegistry);
    for (const w of mcp.warnings) appendSystem(setMessages, w);
  } catch {
    // Best-effort.
  }
  setWorkspaceStubs(createWorkspaceStubs(workspaceCtx));
  const councilFeedbackStore = new FeedbackStore();
  // v0.7.3: per-member display accumulator for the streaming bubble.
  // The previous code accumulated by reading `liveRef.current.streaming` —
  // but that ref only updates on render (useEffect) and the delta commits go
  // through a 16ms throttle window, so every delta inside a window computed
  // staleContent+delta and the LAST write won: most tokens were silently
  // dropped (the mangled member text from the 2026-07-02 live test).
  // The accumulator lives here, in the event loop, exactly like
  // `streamContent` in dispatchPrompt.
  let streamContent = "";
  let streamMemberId: string | null = null;
  // v0.7.3: council members legitimately need more than the core default of
  // 5 tool calls per turn (a planner creating 8 tasks got 3 of them skipped
  // with "[skipped] maxToolCallsPerTurn reached"). Same env override as the
  // single-prompt path.
  const councilMaxToolCalls = envNumber(process.env.ZELARI_MAX_TOOL_CALLS, {
    default: 15,
    min: 1,
  });
  // v0.7.1 (A3): track member completion so the AGENTS.MD hook only runs when
  // the council actually produced output. v0.7.1 (A4): track repeated provider
  // errors to abort the remaining members instead of grinding through every
  // specialist after the API is clearly broken.
  let membersCompleted = 0;
  let chairmanProducedOutput = false;
  let chairmanSynthesisText = "";
  let consecutiveProviderErrors = 0;
  let lastErrorMessage = "";
  let councilAborted = false;
  let chairmanErrored = false;
  let luciferWriteCount = 0;
  let councilRunMode: "implementation" | "design-phase" = "implementation";
  // v1.0: slice outcome reported back to the Zelari mission loop.
  let sliceCompletionOk = false;
  let sliceRan = false;
  let sliceDegraded = false;
  const PROVIDER_ERROR_ABORT_THRESHOLD = 2;
  try {
    for await (const event of dispatchCouncil(effectiveText, {
      apiKey: envConfig.apiKey,
      model: envConfig.model,
      provider: "openai-compatible",
      providerStream: openaiCompatibleProvider(envConfig),
      sessionId,
      tools: councilToolRegistry,
      feedbackStore: councilFeedbackStore,
      // v0.7.2 (B2): give the council the same project awareness the
      // single-prompt path has — cwd, tech stack, file layout, build scripts.
      // Without this, members had no idea which project they were operating
      // on and projected their identity onto the task.
      // v0.7.3: append the existing plan (if any) so a follow-up /council
      // continues it instead of re-planning from scratch.
      // v1.8.0: rolling conversation context so short answers bind across
      // council turns (same history store as the single-agent path).
      workspaceContext: [
        buildWorkspaceSummary(process.cwd()),
        buildPlanSummary(process.cwd(), { userMessage: effectiveText }),
        buildLessonsSummary(process.cwd(), effectiveText),
        formatHistoryForCouncil(4),
      ]
        .filter(Boolean)
        .join("\n\n"),
      maxToolCallsPerTurn: councilMaxToolCalls,
      // v1.0: Zelari-mode per-slice overrides (memory RAG, forced run mode,
      // raised chairman budget). No-ops for a normal /council run.
      ...(overrides.ragContext ? { ragContext: overrides.ragContext } : {}),
      runMode: phaseRunMode,
      ...(overrides.maxToolCallsChairman
        ? { maxToolCallsChairman: overrides.maxToolCallsChairman }
        : {}),
      onCouncilStatus: (message) => {
        appendSystem(setMessages, message, Date.now());
      },
      // v1.8.0: pause council when a member asks a structured question.
      onClarification: setPicker
        ? (req) =>
            new Promise<string | null>((resolve) => {
              const choices = req.choices ?? [];
              if (choices.length < 2) {
                resolve(null);
                return;
              }
              setLastClarification({
                question: req.question,
                choices,
              });
              let settled = false;
              const finish = (value: string | null) => {
                if (settled) return;
                settled = true;
                setPicker(null);
                resolve(value);
              };
              setPicker({
                kind: "clarification",
                title: req.question,
                items: choices.map((c) => ({ value: c, label: c })),
                onAnswer: (value: string) => finish(value),
                onCancel: () => finish(null),
              });
            })
        : undefined,
    })) {
      if (councilAborted) {
        // Drain remaining events silently after the abort decision.
        if (writerRef.current) await writerRef.current.append(event);
        continue;
      }
      if (writerRef.current) {
        await writerRef.current.append(event);
      }
      if (event.type === "council_mode") {
        councilRunMode = event.runMode;
        appendSystem(
          setMessages,
          `[council] ${event.tier} · ${event.runMode} · ${event.councilSize} members`,
          event.ts,
        );
      } else if (event.type === "message_delta") {
        // Coalesce streaming assistant content through the throttled setter so
        // per-token deltas don't flicker the TUI (same as dispatchPrompt).
        if (useLiveModel) {
          // v0.7.3: accumulate in the local `streamContent` (NOT via liveRef —
          // stale under the throttle, see the accumulator comment above) and
          // always push the FULL content: dropped intermediate commits are
          // then harmless because the last one supersedes them.
          const memberId = event.memberId ?? null;
          if (memberId !== streamMemberId) {
            // Member boundary without a message_end (defensive): seal the
            // previous member's bubble before starting the new one.
            flushStreaming();
            finalizeStreaming(setMessages, setLive!);
            streamContent = "";
            streamMemberId = memberId;
          }
          streamContent += event.delta;
          setStreaming(
            commitStreaming,
            cleanAgentContent(streamContent),
            event.ts,
            {
              ...(event.memberId ? { memberId: event.memberId } : {}),
              ...(event.memberName ? { memberName: event.memberName } : {}),
            },
          );
        } else {
          // Legacy single-array fallback. Extend the trailing streaming bubble
          // only when it belongs to the SAME member — otherwise one specialist's
          // text would be appended to (and attributed to) the previous one.
          commitStreaming((prev) => {
            const last = prev[prev.length - 1];
            if (
              last &&
              last.role === "assistant" &&
              last.id.startsWith("streaming-") &&
              (last.memberId ?? null) === (event.memberId ?? null)
            ) {
              const nextContent = cleanAgentContent(last.content + event.delta);
              return [
                ...prev.slice(0, -1),
                { ...last, content: nextContent },
              ];
            }
            return [
              ...prev,
              {
                id: `streaming-${crypto.randomUUID()}`,
                role: "assistant",
                content: cleanAgentContent(event.delta),
                ts: event.ts,
                ...(event.memberId ? { memberId: event.memberId } : {}),
                ...(event.memberName ? { memberName: event.memberName } : {}),
              },
            ];
          });
        }
      } else if (event.type === "message_end") {
        // Member/turn boundary: drain buffered deltas and seal the bubble so
        // the next streamed message starts fresh.
        if (event.memberId === "lucifer" || event.memberName === "Lucifero") {
          if (streamContent.trim()) {
            chairmanProducedOutput = true;
            chairmanSynthesisText = streamContent;
          }
        }
        flushStreaming();
        if (useLiveModel) finalizeStreaming(setMessages, setLive!);
        else finalizeStreamingAssistant(setMessages);
        streamContent = "";
        streamMemberId = null;
        membersCompleted++;
      } else if (event.type === "tool_execution_start") {
        // Count ANY project-file write this run (implementer-agnostic). The
        // `tool_execution_start` event does NOT carry memberId — only message_*
        // events do — so gating on `event.memberId === "lucifer"` left this at 0
        // forever and made DEGRADED_RUN ("wrote no files") a permanent false
        // positive. Since implementation runs now have a single implementer
        // (specialists are read-only), "no writes at all" is the right signal.
        if (event.toolName === "write_file" || event.toolName === "edit_file") {
          luciferWriteCount++;
        }
        // Drain buffered deltas first so ordering matches reality, and seal
        // the pre-tool bubble (complete once the member starts calling tools).
        flushStreaming();
        if (useLiveModel) {
          finalizeStreaming(setMessages, setLive!);
          startTool(
            setLive!,
            event.toolName,
            event.toolCallId,
            event.args,
            event.ts,
          );
        } else {
          finalizeStreamingAssistant(setMessages);
          appendToolStart(
            setMessages,
            event.toolName,
            event.toolCallId,
            event.args,
            event.ts,
          );
        }
        // The pre-tool bubble is sealed: the next delta starts a fresh one.
        streamContent = "";
      } else if (event.type === "tool_execution_end") {
        if (useLiveModel) {
          completeTool(
            setMessages,
            setLive!,
            event.toolCallId,
            event.isError,
            event.durationMs,
            event.result,
          );
        } else {
          updateToolMessageEnd(
            setMessages,
            event.toolCallId,
            event.isError,
            event.durationMs,
            event.result,
          );
        }
      } else if (event.type === "member_cost") {
        if (event.cost.memberId === "lucifer" && event.cost.errored) {
          chairmanErrored = true;
        }
      } else if (event.type === "error") {
        if (event.memberId === "lucifer" || event.memberName === "Lucifero") {
          chairmanErrored = true;
        }
        flushStreaming();
        // v0.7.1 (A4): attribute the error to the member when known, so the
        // user sees `[error · Caronte] …` instead of three anonymous lines.
        const memberTag = event.memberName ? ` · ${event.memberName}` : "";
        appendSystem(
          setMessages,
          `[error${memberTag}] ${event.message}`,
          event.ts,
        );
        // v0.7.1 (A4): detect repeated identical provider errors and abort the
        // remaining members instead of grinding through every specialist.
        if (event.message === lastErrorMessage) {
          consecutiveProviderErrors++;
        } else {
          consecutiveProviderErrors = 1;
          lastErrorMessage = event.message;
        }
        if (consecutiveProviderErrors >= PROVIDER_ERROR_ABORT_THRESHOLD) {
          councilAborted = true;
          appendSystem(
            setMessages,
            `[council aborted: repeated provider error — ${consecutiveProviderErrors}× "${event.message.slice(0, 80)}"]`,
            Date.now(),
          );
        }
      }
    }
  } catch (err) {
    // Flush any partial streamed content before the error message renders.
    flushStreaming();
    appendSystem(
      setMessages,
      `[council error] ${err instanceof Error ? err.message : String(err)}`,
      Date.now(),
    );
  } finally {
    // Drain any buffered streaming deltas before status messages / busy flip,
    // so the final council output is committed to the chat.
    flushStreaming();
    if (useLiveModel) finalizeStreaming(setMessages, setLive!);
    else finalizeStreamingAssistant(setMessages);
    // v1.8.0: fold this council turn into shared rolling history so the next
    // agent/council/zelari turn sees user + synthesis (short answers bind).
    if (membersCompleted > 0 || chairmanProducedOutput) {
      try {
        appendMessages([
          { role: "user", content: effectiveText },
          {
            role: "assistant",
            content:
              chairmanSynthesisText.trim() ||
              "[council completed without chairman synthesis text]",
          },
        ]);
      } catch {
        // Non-fatal.
      }
    }
    // v0.7.1 (A3): only auto-write AGENTS.MD when the council actually produced
    // output. Running the hook after an all-error run (e.g. the HTTP 400 from
    // A1) dirtied the working tree with sections rewritten from nothing.
    const hookShouldRun = membersCompleted > 0 || chairmanProducedOutput;
    sliceRan = hookShouldRun;
    if (hookShouldRun) {
      try {
        const { detectDegradedRun } = await import("@zelari/core/council");
        const degraded = detectDegradedRun({
          chairmanErrored,
          councilAborted,
          luciferWriteCount,
          synthesisText: chairmanSynthesisText,
          runMode: councilRunMode,
        });
        sliceDegraded = degraded.degraded;
        if (degraded.degraded) {
          appendSystem(
            setMessages,
            `[council] DEGRADED_RUN — ${degraded.reasons.join("; ")}. Do not treat as verified hand-off.`,
            Date.now(),
          );
        }
        const hook = await runPostCouncilHook(workspaceCtx, {
          runMode: councilRunMode,
          userMessage: effectiveText,
          synthesisText: chairmanSynthesisText || undefined,
          degradedRun: degraded.degraded,
          degradedReasons: degraded.reasons,
        });
        sliceCompletionOk = hook.completion?.completion?.ok ?? false;
        if (hook.ran && hook.changed) {
          appendSystem(
            setMessages,
            `[agents.md] updated: ${hook.sections.length} section(s) changed (${hook.sections.join(", ")})`,
            Date.now(),
          );
        } else if (hook.ran && hook.reason) {
          if (!hook.reason.includes("disabled")) {
            appendSystem(setMessages, `[agents.md] ${hook.reason}`, Date.now());
          }
        }
        if (hook.autofix?.ran && hook.autofix.applied) {
          appendSystem(
            setMessages,
            `[verify-autofix] applied to ${hook.autofix.filesChanged?.join(", ") ?? "targets"}`,
            Date.now(),
          );
        }
        if (hook.verification?.ran) {
          const v = hook.verification;
          if (degraded.degraded) {
            appendSystem(
              setMessages,
              `[verify] SKIPPED — degraded run (see DEGRADED_RUN above)`,
              Date.now(),
            );
          } else if (v.ok) {
            appendSystem(
              setMessages,
              `[verify] PASS — ${v.report?.targets.join(", ") ?? "targets"} (see .zelari/verification-report.json)`,
              Date.now(),
            );
          } else {
            const fails = (v.report?.results ?? []).filter((r) => !r.ok);
            const lines = fails
              .slice(0, 8)
              .map((r) => `  · ${r.id}: ${r.message}`)
              .join("\n");
            appendSystem(
              setMessages,
              `[verify] FAIL — ${fails.length} issue(s). Do not commit until fixed.\n${lines}${fails.length > 8 ? "\n  · …" : ""}`,
              Date.now(),
            );
          }
        }
        if (hook.smoke?.ran) {
          const s = hook.smoke;
          if (s.ok) {
            appendSystem(
              setMessages,
              `[smoke] PASS — npm run ${s.script ?? "script"}`,
              Date.now(),
            );
          } else {
            appendSystem(
              setMessages,
              `[smoke] FAIL — npm run ${s.script ?? "script"}: ${s.reason ?? "non-zero exit"}`,
              Date.now(),
            );
          }
        } else if (
          hook.smoke?.reason &&
          !hook.smoke.reason.includes("disabled")
        ) {
          appendSystem(
            setMessages,
            `[smoke] skipped — ${hook.smoke.reason}`,
            Date.now(),
          );
        }
        if (hook.completion?.completion) {
          const c = hook.completion.completion;
          if (c.readyToCommit) {
            appendSystem(
              setMessages,
              `[completion] readyToCommit=true (see .zelari/completion.json)`,
              Date.now(),
            );
          } else {
            const n = c.blocking.length || c.openFails.length;
            appendSystem(
              setMessages,
              `[completion] readyToCommit=false — ${n} blocking issue(s)${c.degraded ? " (degraded run)" : ""}`,
              Date.now(),
            );
          }
        }
      } catch {
        // Best-effort — never block on AGENTS.MD errors.
      }
    } else if (!councilAborted) {
      appendSystem(
        setMessages,
        "[agents.md] skipped — council produced no output",
        Date.now(),
      );
    }
    setBusy(false);
  }

  return {
    completionOk: sliceCompletionOk,
    ran: sliceRan,
    synthesisText: chairmanSynthesisText || undefined,
    writeCount: luciferWriteCount,
    degraded: sliceDegraded,
  };
}

/**
 * dispatchZelariPromptImpl — Zelari-mode entrypoint.
 *
 * Two-step UX: the first prompt builds and shows a mission brief and (unless
 * ZELARI_MISSION_AUTO=1) waits for an 'ok' confirmation held in `pendingRef`;
 * the confirmation then runs the autonomous loop. Each mission iteration runs a
 * full council slice via `dispatchCouncilPromptImpl` with memory-derived RAG and
 * a raised chairman tool budget.
 */
async function dispatchZelariPromptImpl(
  text: string,
  deps: UseChatTurnParams & { setQueueCount: (n: number) => void },
  pendingRef: React.MutableRefObject<{ userMessage: string } | null>,
): Promise<void> {
  const { setMessages } = deps;
  const emit = (m: string) => appendSystem(setMessages, m, Date.now());

  // ── Confirmation step for a pending mission ──
  if (pendingRef.current) {
    const pending = pendingRef.current;
    pendingRef.current = null;
    const affirmative = /^(ok|okay|s[iì]|yes|y|procedi|vai|conferma|go)\b/i.test(
      text.trim(),
    );
    if (!affirmative) {
      emit("[zelari] missione annullata.");
      return;
    }
    await runZelariMissionInTui(pending.userMessage, deps, emit);
    return;
  }

  // ── Fresh prompt → build + show the brief ──
  const { buildMissionBrief } = await import("@zelari/core/council");
  const { hasWorkspacePlan } = await import("../workspace/planDetect.js");
  const { formatBriefForChat, isMissionAutoStart } = await import(
    "../zelariMission.js"
  );
  const projectRoot = process.cwd();
  const brief = buildMissionBrief({
    userMessage: text,
    hasPlan: hasWorkspacePlan(projectRoot),
  });
  emit(formatBriefForChat(brief));

  if (isMissionAutoStart()) {
    await runZelariMissionInTui(text, deps, emit);
    return;
  }
  pendingRef.current = { userMessage: text };
  emit(
    "[zelari] Confermi l'avvio della missione? invia 'ok' per procedere, qualsiasi altra cosa per annullare.",
  );
}

/** Wire the Zelari mission driver to the real council dispatch + memory. */
async function runZelariMissionInTui(
  userMessage: string,
  deps: UseChatTurnParams & { setQueueCount: (n: number) => void },
  emit: (m: string) => void,
): Promise<void> {
  const { setMessages } = deps;
  const envConfig = await providerFromEnv();
  if (!envConfig) {
    const active = resolveActiveProvider();
    const spec = PROVIDERS.find((p) => p.id === active);
    emit(
      `No API key for the active provider "${active}". Set ${spec?.envVar ?? "the provider API key env var"} or run /login ${active} before starting a Zelari mission.`,
    );
    return;
  }

  const projectRoot = process.cwd();
  const { buildMissionBrief } = await import("@zelari/core/council");
  const { hasWorkspacePlan } = await import("../workspace/planDetect.js");
  const { getMemoryBackend } = await import("../memory/fileBackend.js");
  const { runZelariMission } = await import("../zelariMission.js");

  const brief = buildMissionBrief({
    userMessage,
    hasPlan: hasWorkspacePlan(projectRoot),
  });
  const memory = await getMemoryBackend(projectRoot);
  const chairmanBudget = envNumber(process.env.ZELARI_MODE_MAX_TOOLS_LUCIFER, {
    default: 30,
    min: 1,
  });

  try {
    await runZelariMission(userMessage, brief, {
      projectRoot,
      memory,
      emit,
      runSlice: async ({ userMessage: slicePrompt, runMode, ragContext }) => {
        const r = await dispatchCouncilPromptImpl(slicePrompt, deps, {
          ragContext,
          runMode,
          maxToolCallsChairman: chairmanBudget,
        });
        return {
          completionOk: r.completionOk,
          ran: r.ran,
          synthesisText: r.synthesisText,
          writeCount: r.writeCount,
          degraded: r.degraded,
        };
      },
    });
  } catch (err) {
    emit(
      `[zelari] errore missione: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await memory.close();
  }
}

/**
 * Public wrapper that captures the dispatchCouncilPromptImpl dependencies
 * from the useChatTurn closure. Returns a stable callback the App can wire
 * into the InputBar onSubmit.
 */
export function makeCouncilDispatch(
  deps: UseChatTurnParams & { setQueueCount: (n: number) => void },
): (text: string) => Promise<void> {
  return (text: string) => dispatchCouncilPromptImpl(text, deps);
}
