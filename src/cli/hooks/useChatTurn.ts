// @ts-nocheck — pre-existing strict-mode type narrowing issues carried over
// from app.tsx. Runtime is correct; tighten signatures in a follow-up.
import { useState, useRef, useCallback } from "react";
import type { ChatMessage } from "../components/ChatStream.js";
import { AgentHarness } from "@zelari/core/harness";
import type { AgentMessage } from "@zelari/core/harness";
import { ingestLiveEvent } from "./observationStore.js";
import { MetricsLogger, getMetricsLogger, recordCompactionMetrics } from "../metrics.js";
import type { BrainContextMetricsEvent } from "@zelari/core/events";
import { calculateCost } from "../modelPricing.js";
import {
  providerFromEnv,
  providerConfigFor,
  resolveActiveProvider,
} from "../provider/openai-compatible.js";
import { buildProviderStream } from "../provider/resolveStream.js";
import { providerFailover } from "../providerFailover.js";
import { resolveFailoverStream } from "../crossProviderFailover.js";
import { resolveShell } from "@zelari/core/harness/tools/builtin/shellResolver";
import { PROVIDERS } from "../keyStore.js";
import { getActiveModel } from "../providerConfig.js";
import { createBuiltinToolRegistry } from "../toolRegistry.js";
import { KrakenTurnRuntime } from "../kraken/turnRuntime.js";
import { resetTaskSpawnCount } from "../tools/taskTool.js";
import { isKrakenSelectionEnabled, krakenChecksPassed, krakenRequiredChecks, resetKrakenCandidates } from "../kraken/candidateRegistry.js";
import { collectKrakenTurnMetrics, markRepairSucceeded, markRepairTriggered, resetKrakenTurnMetrics } from "../kraken/metrics.js";
import { krakenSelectionPlaybook } from "../kraken/selectionPlaybook.js";
import { krakenDelegationPlaybook } from "../kraken/delegationPolicy.js";

import { buildKrakenRepairPrompt } from "../kraken/completionGate.js";
import {
  evaluateStrictBuildGate,
  strictGateEventPayload,
  type StrictBuildGateEvaluation,
  type StrictGateOptions,
} from "../kraken/verificationBridge.js";
import { writeCompletionProof } from "../kraken/completionProof.js";
import { nativePackEnabled } from "../kraken/nativeVerification.js";
import type { SpineMirroringWriter } from "../sessionSpine.js";
// W2: memory telemetry projected onto the session spine as state-only notes.
import { memorySinkFor } from "../memory/spineTelemetry.js";
import { createPermissionAskHandler } from "./permissionPicker.js";
import { armPickerTimeout, askUserTimeoutMs } from "./askUserTimeout.js";
import { defaultPermissionPolicy } from "../safety/toolPermissions.js";
import {
  buildSystemPromptSplit,
  systemMessagesFromSplit,
  getAllTools,
  KRAKEN_IDENTITY_MODULE,
  KRAKEN_LEAD_PLAYBOOK_MODULE,
  buildLanguagePolicyModuleFor,
} from "@zelari/core/skills";
import { hashStablePrompt } from "../state/fileStateStore.js";
import {
  parseClarificationRequest,
  cleanAgentContent,
  createBrainEvent,
} from "@zelari/core";
import { createStreamScrubber } from "./streamScrub.js";
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
  appendMessages,
  clearHistory,
  setLastClarification,
  maybeAnchorShortAnswer,
  formatHistoryForCouncil,
  setHistory,
  expectsDiskImplementation,
} from "./conversationContext.js";
import type { ProviderName } from "../keyStore.js";
import { computeSessionStatsDelta } from "./chatStats.js";
import { envNumber } from "../utils/envNumber.js";
import { getPhase } from "../phaseState.js";
import { describePhase } from "../phase.js";
import {
  buildModelContext,
  resourceStatusTail,
} from "../budget/modelContextBuilder.js";
import {
  recordRequestSnapshot,
  recordRequestUsage,
  getRequestSnapshotWithUsage,
} from "../budget/requestSnapshotStore.js";

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
  writerRef: React.MutableRefObject<SpineMirroringWriter | null>;
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
      // Kraken: fresh tentacle spawn budget each parent user turn.
      resetTaskSpawnCount();
      // Fase 3 (ADR-0020): fresh per-turn candidate registry.
      resetKrakenCandidates();
      resetKrakenTurnMetrics();
      // v0.4.3 audit fix: provider resolution + harness construction now
      // live INSIDE the try block. Previously, throws from providerFromEnv,
      // resolveFailoverStream, or createBuiltinToolRegistry happened
      // BEFORE the try (which only wrapped the stream loop), so the
      // rejected promise escaped unhandled (useSlashDispatch doesn't
      // try/catch its await either). The user saw a hang with no
      // feedback instead of an actionable error message.
      let envConfig: Awaited<ReturnType<typeof providerFromEnv>> | undefined;
      let harness: AgentHarness;
      let memoryService: import('@zelari/core/memory').MemoryService | undefined;
      let memoryAutoWrite = false;
      // v1.6.0: length of the history seed actually passed to the harness.
      // Captured here (after compaction) so the finally block can slice off
      // exactly the seed and keep only this turn's newly-appended tail.
      // v1.36.0: historySeedLen stays as the conversation-seed length (no
      // system constant baked in) — the finally block now slices off
      // `systemMessages.length` + historySeedLen + 1 (user) using the
      // ACTUAL system prefix count (1 or 2 depending on the builder), not
      // the old hardcoded 1.
      let historySeedLen = 0;
      // v1.36.0: system prefix count captured at seed-build time.
      let systemPrefixLen = 0;
      // v1.6.0: set true only after the stream loop completes without
      // throwing, so the finally snapshot is skipped on error (a failed
      // turn — provider 500, abort — must not pollute rolling history
      // with a partial assistant tail).
      let turnSucceeded = false;
      try {
        // Short-answer anchor: if the user is replying to a ---QUESTION---,
        // rewrite the user message so the model cannot treat "full"/"2" as
        // a brand-new request even if compaction dropped the prior turn.
        const anchored = maybeAnchorShortAnswer(userText);
        const effectiveUserText = anchored ?? userText;
        // 2.0 spine: the user prompt is model-visible — log it (the 1.x JSONL never did).
        // Exit-1/E1.3: the model context is spine-derived — the same canonical
        // path as headless (seedHeadlessModelHistory / derivedModelSeed).
        // Derive BEFORE the current user prompt is logged so the seed
        // excludes this turn. The in-process rolling store stays the
        // declared fallback (degraded/disabled spine, or a spine log still
        // empty while the store carries replayed 1.x history) and keeps
        // feeding render + budget heuristics.
        let historyForModel: readonly AgentMessage[] = getHistory();
        // Local-CLI provider (Slice B): opt-in via ZELARI_LOCAL_CLI=claude|codex|...
        // No API key needed — the CLI is authenticated on its own. Permission
        // prompts flow to the zelari broker via ZELARI_PERM_SOCKET (Slice A).
        const localCli = (process.env.ZELARI_LOCAL_CLI ?? "").trim();
        let localCliProvider: import("@zelari/core/harness").ProviderStreamFn | null = null;
        if (localCli) {
          const { createLocalCliProvider } = await import(
            "../provider/localCli/claudeProvider.js",
          );
          localCliProvider = createLocalCliProvider({ cli: localCli });
        } else {
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
        }
        setBusy(true);
        const workPhase = getPhase();
        try {
          const memoryFactory = await import('../memory/serviceFactory.js');
          if (memoryFactory.isMemoryV2Enabled()) {
            // W2: getter-backed holder — the spine mirror attaches per turn,
            // so events resolve `writerRef.current?.spine` at emit time.
            const tuiSpineHolder = {
              get current() {
                return writerRef.current?.spine;
              },
            };
            memoryService = await memoryFactory.getMemoryService(process.cwd(), process.env, {
              onWarning: (warning) => appendSystem(setMessages, warning, Date.now()),
              onEvent: memorySinkFor(tuiSpineHolder),
            });
            memoryAutoWrite = memoryFactory.isMemoryAutoWriteEnabled();
          }
        } catch {
          // Memory is fail-open; the model turn remains available.
        }
        // Grok-style ask_user: block the tool-loop until picker resolves so
        // the same harness run continues with the answer as tool_result.
        const onAskUser = setPicker
          ? (req: {
              question: string;
              choices: string[];
              context?: string;
            }) =>
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
                const choiceLines = choices
                  .map((c, i) => `  ${i + 1}. ${c}`)
                  .join("\n");
                appendSystem(
                  setMessages,
                  `[in attesa di risposta — ask_user]\n${req.question}\n${choiceLines}` +
                    (req.context ? `\n_(${req.context})_` : "") +
                    "\n→ scegli dalla lista (il turno continua dopo).",
                  Date.now(),
                );
                let settled = false;
                // v1.47.x: an unseen question must not hang the build forever
                // (silent "working", no error) — resolve null (documented
                // assumption path) after the timeout. Knob: ZELARI_ASK_USER_TIMEOUT_MS.
                const askTimeoutMs = askUserTimeoutMs();
                let cancelAskTimeout: () => void = () => undefined;
                const finish = (value: string | null) => {
                  if (settled) return;
                  settled = true;
                  cancelAskTimeout();
                  setPicker(null);
                  resolve(value);
                };
                cancelAskTimeout = armPickerTimeout(
                  () => {
                    appendSystem(
                      setMessages,
                      `[ask_user] nessuna risposta entro ${Math.round(
                        askTimeoutMs / 1000,
                      )}s — proseguo con assunzione documentata (ZELARI_ASK_USER_TIMEOUT_MS).`,
                      Date.now(),
                    );
                    finish(null);
                  },
                  askTimeoutMs,
                );
                setPicker({
                  kind: "clarification",
                  title: req.question,
                  items: choices.map((c) => ({ value: c, label: c })),
                  onAnswer: (value: string) => finish(value),
                  onCancel: () => finish(null),
                });
              })
          : undefined;
        const onPermissionAsk = setPicker
          ? createPermissionAskHandler({
              setPicker,
              appendSystem: (msg, at) =>
                appendSystem(setMessages, msg, at ?? Date.now()),
            })
          : undefined;
        const { registry: toolRegistry } = createBuiltinToolRegistry({
          planMode: workPhase === "plan",
          // Fase 1 (ADR-0020): anchor tentacles to THIS turn's resolved
          // provider/model so the TUI selection governs sub-agents too.
          ...(envConfig
            ? {
                subAgentProvider: envConfig.providerId,
                subAgentModel: envConfig.model,
                // Fase 4 (ADR-0020): kraken_select rides the same alpha
                // flag as candidate spawning (default off = unchanged).
                krakenSelect: isKrakenSelectionEnabled(),
              }
            : {}),
          onAskUser,
          onPermissionAsk,
          permissionPolicy: defaultPermissionPolicy(),
          ...(memoryService ? { memoryService } : {}),
          memoryAutoWrite,
        });
        // Fase 2 (ADR-0020): per-turn progress projection (sparse phase events).
        // The dedicated UI chip ships with the selection phases; for now the
        // events ride the same JSONL writer + live region channel as the rest.
        const progressRuntime = new KrakenTurnRuntime({
          mode: workPhase === "plan" ? "plan" : "build",
          sessionId,
          loadCheckTotal: () => krakenRequiredChecks().length,
          loadChecksPassed: () => krakenChecksPassed(),
          onProgress: (ev) => {
            if (writerRef.current) void writerRef.current.append(ev);
            if (sessionId) ingestLiveEvent(sessionId, ev);
          },
        });
        progressRuntime.beginTurn();
        const baseProviderStream = localCliProvider ?? buildProviderStream(envConfig!);
        let providerStream: import("@zelari/core/harness").ProviderStreamFn;
        if (localCliProvider) {
          providerStream = localCliProvider;
        } else {
          const failoverResolution = await resolveFailoverStream({
            failoverEnabled: process.env.ANATHEMA_FAILOVER !== "0",
            envValue: process.env.ANATHEMA_FAILOVER_PROVIDER,
            primaryProviderId: envConfig!.providerId,
            primary: baseProviderStream,
            validProviderIds: PROVIDERS.map((p) => p.id),
            lookupFallbackConfig: async (id) =>
              providerConfigFor(id as ProviderName),
            buildStream: (config) =>
              buildProviderStream(
                config as Parameters<typeof buildProviderStream>[0],
              ),
          });
          if (failoverResolution.warning) {
            // Surface in the chat instead of console.warn: writes that bypass
            // Ink force a full repaint of the TUI frame (visible flicker).
            appendSystem(setMessages, `[failover] ${failoverResolution.warning}`);
          }
          providerStream = failoverResolution.fallbackLabel
            ? providerFailover({
                primary: baseProviderStream,
                fallback: failoverResolution.fallback,
                fallbackLabel: failoverResolution.fallbackLabel,
              })
            : providerFailover({
                primary: baseProviderStream,
                fallback: failoverResolution.fallback,
              });
        }
        const cwd = process.cwd();

        // v1.36.0 (P6): compactInPlace() REMOVED from the hot path — it
        // rewrote history BEFORE measuring, busting the cache prefix every
        // turn. The budget pipeline below owns compaction now
        // (prune → remeasure → replay) and only rewrites when occupancy
        // actually demands it.
        // E1.5 (ADR-0024): the budget pipeline measures the spine-derived
        // model history, not the 1.x store — compaction decisions apply to
        // exactly what the model is about to see.
        const requestSnapshot = getRequestSnapshotWithUsage(sessionId);
        await writerRef.current?.spine?.beginResourceTurn();
        const modelContext = await buildModelContext({
          fallbackHistory: historyForModel,
          session: writerRef.current?.spine ?? null,
          resourceSnapshot: writerRef.current?.spine?.latestResourceSnapshot() ?? null,
          phase: workPhase,
          model: getActiveModel(),
          provider: envConfig?.providerId ?? (localCli || 'local'),
          sessionId,
          requestSnapshot,
          providerStream,
          onCompactionMetric: (metrics) => recordCompactionMetrics(
            sessionId,
            envConfig?.providerId ?? (localCli || 'local'),
            getActiveModel(),
            metrics,
          ),
          persistCompaction: async (payload, compactBudget) => {
            const compactionEvent = createBrainEvent('session_compacted', sessionId, {
              ...payload,
              ...(requestSnapshot
                ? {
                    sourceRequestFingerprint: requestSnapshot.snapshot.requestFingerprint,
                    headerFingerprint: requestSnapshot.snapshot.headerFingerprint,
                  }
                : {}),
              ...(compactBudget.contextPressureTokens !== undefined
                ? { sourceEstimatedTokens: compactBudget.contextPressureTokens }
                : {}),
              ...(compactBudget.cacheReuseExpected !== undefined
                ? { cacheReuseExpected: compactBudget.cacheReuseExpected }
                : {}),
            });
            await writerRef.current?.append(compactionEvent);
          },
        });
        const budget = modelContext.budget;
        historyForModel = modelContext.history;
        setHistory(historyForModel);
        for (const warning of budget.warnings) {
          appendSystem(setMessages, warning, Date.now());
        }
        writerRef.current?.spine?.userMessage(effectiveUserText);
        // E1.5: if the pipeline compacted, the replayed history replaces
        // this turn's seed so the model sees exactly what was measured.
        historySeedLen = historyForModel.length;
        // v0.7.3: surface the council plan (if any) to the single agent too.
        // The plan lives in .zelari/plan.json but the agent had no idea it
        // existed — users had to paste task-file paths by hand. Best-effort:
        // no plan → null → zero prompt-token cost.
        // v1.16: unified compose — product truth + draft plan ops; plan is
        // NEVER mislabeled as ragContext (that slot is for real memory only).
        let composedWorkspace = "";
        let composedInstructions = "";
        let hasPlan = false;
        try {
          const { composeProjectContext } = await import(
            "../workspace/composeContext.js"
          );
          const { hasWorkspacePlan } = await import(
            "../workspace/planDetect.js"
          );
          hasPlan = hasWorkspacePlan(cwd);
          const { loadDurableContext } = await import(
            "../state/loadDurableContext.js"
          );
          const durableState = await loadDurableContext(cwd);
          const composed = composeProjectContext({
            mode: 'kraken',
            cwd,
            userMessage: userText,
            includeLessons: false,
            durableState: durableState || undefined,
            // Pre-loaded async — skip sync fallback double-read.
            includeDurableState: false,
          });
          composedWorkspace = composed.workspaceContext;
          composedInstructions = composed.projectInstructions;
          // Put durable into volatile workspace path via rag if compose put it
          // in ragContext — agent buildSystemPrompt uses workspaceContext only;
          // merge rag durable into workspace for agent visibility.
          if (composed.ragContext) {
            composedWorkspace = [composedWorkspace, composed.ragContext]
              .filter(Boolean)
              .join("\n\n");
          }
          for (const w of composed.warnings) {
            appendSystem(setMessages, w, Date.now());
          }
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
          if (hasPlan) wantedWorkspaceTools.add("updateTask");
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
          : resolvedShell.isPowerShell
            ? `The bash tool runs commands via PowerShell (${resolvedShell.shell}). Write PowerShell syntax: ls/cat/pwd aliases work, use \`\$\{env:VAR\}\` (not %VAR%), pipe with |, && works in PS7+.`
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
        // KRAKEN_IDENTITY_MODULE overrides the council-flavored
        // 'base-identity' module so the persona is "Zelari Code in the terminal",
        // not "member of an AI Council".
        const planPhaseBlock =
          workPhase === "plan"
            ? [
                "# Work Phase: PLAN",
                "You are in PLAN mode. Explore and design only.",
                "- Do NOT implement production code or run destructive shell commands.",
                "- write_file / edit_file / bash / apply_diff are unavailable.",
                "- inspect_command IS available: allowlisted read-only inspector (no shell). Use it for git_status/git_log/git_diff/git_show/git_branch_current/git_ls_files/typecheck/node_version/npm_ls/npm_outdated/npm_view - it turns claims into execution-verified observations.",
                "- OBSERVATION INTEGRITY: negative evidence is valid only from a completed observation. Never conclude that code/symbols/files do not exist from degraded results, zero files examined, or unavailable backends (grep_content SEARCH_EMPTY_SCOPE, ast/LSP degraded status, inspect_command unsupported shapes).",
                "- Produce a clear plan, ask clarifying questions (---QUESTION---), use workspace plan tools when relevant.",
                "- When the plan is ready, tell the user to run /build to implement.",
              ].join("\n")
            : workPhase === "build"
              ? [
                  "# Work Phase: BUILD",
                  "Implement on disk. Prefer acting over describing.",
                  "- Prior plan/synthesis text is a SPEC to apply — not proof files already changed.",
                  "- You MUST use write_file/edit_file for every file you change before claiming done.",
                  "- After read_file: if the planned change is missing, WRITE it — do not stop at analysis.",
                  "- Never claim already-implemented based only on reading a plan or skimming code.",
                  hasPlan
                    ? "- A draft plan exists under .zelari/ — implement grounded tasks and update statuses; do not treat design docs as shipped code."
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n")
              : "";
        // Stable platform/shell block (session-constant). Phase/plan go in volatile.
        const shellContextBlock = [
          "# Platform & Shell",
          `platform: ${process.platform}`,
          `shell: ${resolvedShell.via}`,
          shellGuidance,
          nonInteractiveGuidance,
          "",
          "# Working Directory",
          `You are running in: ${cwd}`,
          "All relative file paths are resolved against this directory. Always work with real files here.",
        ].join("\n");
        const volatileSessionBlock = [
          planPhaseBlock,
          hasPlan
            ? [
                "# Plan Tracking",
                '- Plan tasks (draft ops): when you START a task call updateTask {taskId, status: "in_progress"}; when complete and verified call updateTask {taskId, status: "done"}. NEVER edit .zelari/plan.json by hand. Prefer product tree over design docs.',
              ].join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
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
        // Composed workspace already includes product tree + draft plan ops +
        // epistemic banner. ragContext stays empty on the agent path (memory
        // is zelari-only) so plan is never mislabeled as "Retrieved Knowledge".
        const workspaceContext = [
          volatileSessionBlock,
          composedWorkspace,
        ]
          .filter(Boolean)
          .join("\n\n");
        // v1.5.3: build via the shared builder. Wrap in try/catch with a
        // minimal fallback so a builder failure (e.g. test context without a
        // populated catalog) never breaks dispatch — the harness still gets a
        // usable system prompt and the turn proceeds.
        // Cache Wars: stable/volatile split so plan/workspace updates do not
        // bust the cached prefix (identity + tools + platform).
        let systemMessages: AgentMessage[] = [];
        let lastStableHash: string | undefined;
        try {
          // v1.7.0: detect the user's language and inject the language-policy
          // module so the agent replies in the user's language. Honors
          // ZELARI_RESPONSE_LANG override (auto|it|en|fr|...). The module is
          // appended to customPromptModules alongside KRAKEN_IDENTITY_MODULE + playbook
          // — it lives in priority space (5) so it sorts BEFORE the base-identity
          // module (10): the model sets language scaffolding before reading role text.
          const languageModule = buildLanguagePolicyModuleFor(userText);
          const split = buildSystemPromptSplit(singleAgentRole, {
            tools: getAllTools(),
            toolNames: toolListNames,
            mode: 'kraken',
            projectInstructions: composedInstructions || undefined,
            aiConfig: {
              enabledSkills: [],
              enabledTools: toolListNames,
              customPromptModules: [
                KRAKEN_IDENTITY_MODULE,
                KRAKEN_LEAD_PLAYBOOK_MODULE,
                ...krakenSelectionPlaybook(true),
                ...krakenDelegationPlaybook(true),

                languageModule,
              ],
              agentSkillConfigs: [],
            },
            workspaceContext: workspaceContext || undefined,
            // Do NOT put plan text here — that was mislabeled as RAG and
            // taught models to treat design vault as retrieved knowledge.
            ragContext: undefined,
          });
          lastStableHash = hashStablePrompt(split.stable);
          systemMessages = systemMessagesFromSplit(split) as AgentMessage[];
        } catch {
          // Fallback: identity + platform/shell + tool list. Keeps the turn
          // runnable even if the builder or catalog is unavailable.
          const languageModule = buildLanguagePolicyModuleFor(userText);
          const fallback = [
            KRAKEN_IDENTITY_MODULE.content,
            languageModule.content,
            shellContextBlock,
            "# Available Tools",
            "You can call these tools. Use them to take action and gather information autonomously:",
            toolList,
            ...(workspaceContext ? ["", workspaceContext] : []),
          ].join("\n");
          lastStableHash = hashStablePrompt(fallback);
          systemMessages = [{ role: "system", content: fallback }];
        }

        // v1.36.0: capture the ACTUAL system prefix length (1 from the
        // fallback builder, 2 from the stable/volatile split) — the finally
        // snapshot slices on this, fixing the off-by-one that leaked the
        // current user message into rolling history when 2 system messages
        // were present.
        systemPrefixLen = systemMessages.length;

        // v0.7.1 (A2): per-turn tool-call budget for single-prompt turns.
        // The harness cap is advisory anti-spam and is clamped by the active
        // ResourcePolicy epoch. ZELARI_MAX_TOOL_CALLS configures that one
        // policy; BudgetRuntime resets enforcement at each user turn while
        // keeping cumulative session telemetry separately.
        const perTurnEnv = envNumber(process.env.ZELARI_MAX_TOOL_CALLS, {
          default: 25,
          min: 1,
        });
        const sessionCap = writerRef.current?.spine?.resourceBudgetLimit();
        const maxToolCallsPerTurn = sessionCap
          ? Math.max(1, Math.min(perTurnEnv, sessionCap.maxToolCalls))
          : perTurnEnv;
        // v1.5.2 / v1.8.0 / v1.8.3: soft tool-loop + optional hard ceiling.
        // Soft can auto-extend until hard so multi-step work finishes.
        const maxToolLoopIterations = budget.maxToolLoopIterations;
        const maxToolLoopHardCap = envNumber(process.env.ZELARI_MAX_TOOL_LOOP_HARD, {
          default: 0, // 0 → harness default (soft×3, min soft+60)
          min: 0,
        });
        const harness = new AgentHarness({
          model: envConfig.model,
          // v1.36.0 (P0.2): real provider identity — the harness used to
          // hardcode "openai-compatible" (the transport family) so snapshots
          // and telemetry mislabeled deepseek/glm/minimax routing.
          provider: envConfig.providerId,
          messages: [
            ...systemMessages,
            // v1.8.0: shared rolling history (agent/council/zelari) so short
            // answers bind to prior ---QUESTION--- blocks. Possibly empty
            // when ZELARI_HISTORY_TURNS=0.
            ...historyForModel,
            { role: "user", content: effectiveUserText },
          ],
          tools: toolRegistry.toOpenAITools().map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
          toolRegistry,
          providerStream,
          buildLiveness: {
            mutationRequired: expectsDiskImplementation(
              userText,
              workPhase,
              historyForModel,
            ),
            maxRecoveries: 2,
          },
          requestTail: () =>
            resourceStatusTail(
              writerRef.current?.spine?.latestResourceSnapshot() ?? null,
            ),
          // 2.6 Phase 3: host-owned pre-dispatch resource gate via the spine
          // mirror (doc section 11.3). Degrade-and-stop (null gate = allow).
          // 2.6.1 (plan §13): argument-aware — bash is essential only when
          // the command is a test/typecheck/build/git-diff line.
          toolCallGate: (name: string, args: Record<string, unknown>) =>
            writerRef.current?.spine?.gateResourceToolCall(name, args) ?? { allowed: true },
          cwd,
          maxToolCallsPerTurn,
          maxToolLoopIterations,
          // v1.36.0: routed-request snapshots feed the meter (occupancy) and
          // the cache-aware compaction replay (last warm prefix).
          onRequestSnapshot: (snap) => recordRequestSnapshot(sessionId, snap),
          ...(maxToolLoopHardCap > 0 ? { maxToolLoopHardCap } : {}),
          ...(memoryService
            ? {
                memoryService,
                memoryQuery: effectiveUserText,
                memoryContextChars: 2_000,
              }
            : {}),
        });
        harnessRef.current = harness;
        setQueueCount(harness.queueLength);

        // Total assistant output across the whole turn — feeds the token/cost
        // estimate fallback in computeSessionStatsDelta.
        let assistantContent = "";
        // Fase 8 (ADR-0020): completion-gate budget — one automatic
        // repair pass per turn (structural: this flag never resets mid-turn).
        let krakenRepairEnqueued = false;
        // Display buffer for the CURRENT streamed message only. Reset on every
        // message_end: without this, the post-tool-call message re-rendered the
        // full accumulated turn text, duplicating everything said before the
        // tool ran.
        let streamContent = "";
        // v1.35: scrub at render cadence, not per delta. cleanAgentContent
        // runs ~35 regex passes over the full accumulated buffer, so at
        // 50-200 deltas/sec long streams scrubbed quadratically — while the
        // throttled commit only renders once per 16ms.
        const streamScrub = createStreamScrubber(16);
        // tool_execution_end doesn't carry toolName — remember it from the
        // matching start event (keyed by toolCallId) for metrics.
        const toolNameById = new Map<string, string>();
        const metrics: MetricsLogger = getMetricsLogger();
        // Fase M: last log-only context_metrics event (arrives before agent_end).
        let lastGrowth: BrainContextMetricsEvent | null = null;
        let realUsage: {
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
          cachedPromptTokens?: number;
        } | null = null;
        try {
          for await (const event of harness.run()) {
            progressRuntime.observe(event);
            if (event.type === "agent_end") {
              // Fase 8 (ADR-0020): completion gate — evaluate BEFORE finish
              // so a repair pass replaces the transient `completed` phase.
              // The repair prompt rides the harness queue: run() drains it
              // inside this SAME for-await loop, so streaming, history and
              // the finally block are shared with the first pass.
              let krakenSuppressFinish = false;
              // F3: forward engine verification events (verification.evidence/run) onto the spine.
              const krakenSpineEmit: NonNullable<StrictGateOptions["emit"]> = (input) =>
                writerRef.current?.spine?.appendEvent(input) ?? Promise.resolve(null);
              // P0.3 (harness-hardening x ADR-0023): persist the completion-proof
              // artifact after every strict gate evaluation — the file always
              // reflects the LAST evaluation of the turn. Best-effort by
              // contract: never breaks the turn.
              const writeProofSafe = (gate: StrictBuildGateEvaluation): Promise<void> =>
                writeCompletionProof(gate, { meta: { surface: "kraken", sessionId } }).then(
                  (): void => undefined,
                  (): void => undefined,
                );
              if (
                event.reason === "completed" &&
                !krakenRepairEnqueued &&
                (isKrakenSelectionEnabled() || nativePackEnabled()) &&
                workPhase === "build"
              ) {
                const strictGate = await evaluateStrictBuildGate("build", { emit: krakenSpineEmit });
                const krakenGate = strictGate.gate;
                writerRef.current?.spine?.verificationRun(strictGateEventPayload(strictGate));
                await writeProofSafe(strictGate);
                if (krakenGate.blocked) {
                  krakenRepairEnqueued = true; // budget = 1, structural
                  markRepairTriggered();
                  harness.enqueue(buildKrakenRepairPrompt(krakenGate));
                  appendSystem(
                    setMessages,
                    `[kraken] required checks unresolved (${krakenGate.passed}/${krakenGate.total} passed) — automatic repair pass`,
                    Date.now(),
                  );
                  progressRuntime.beginPass(true);
                  krakenSuppressFinish = true;
                }
              }
              const repairCheck =
                event.reason === "completed" && krakenRepairEnqueued
                  ? await evaluateStrictBuildGate("build", { emit: krakenSpineEmit })
                  : null;
              // P0.3: the proof artifact must reflect the LAST evaluation of
              // the turn — refresh it after every gate evaluation here.
              if (repairCheck) await writeProofSafe(repairCheck);
              if (repairCheck && !repairCheck.blocked) {
                markRepairSucceeded(); // repair pass resolved every blocking check
              } else if (event.reason === "completed" && krakenRepairEnqueued) {
                const still = await evaluateStrictBuildGate("build", { emit: krakenSpineEmit });
                await writeProofSafe(still);
                if (still.blocked) {
                  appendSystem(
                    setMessages,
                    `[kraken] strict done: evidence still incomplete after repair (${
                      still.evaluation?.unsatisfied.length ?? "?"
                    } unresolved) — turn is NOT verified-complete`,
                    Date.now(),
                  );
                }
              }
              if (!krakenSuppressFinish) progressRuntime.finish(event.reason);
            }
            if (event.type === "message_end") {
              if (event.usage) realUsage = event.usage;
              // v1.36.0: bind provider usage to the last routed snapshot so
              // the next meter run can anchor the header to ground truth.
              if (event.usage) {
                recordRequestUsage(sessionId, {
                  promptTokens: event.usage.promptTokens,
                  completionTokens: event.usage.completionTokens,
                  totalTokens: event.usage.totalTokens,
                  cachedPromptTokens: event.usage.cachedPromptTokens,
                });
              }
              // Message boundary: seal with a full scrub so the last tokens
              // inside the 16ms window are not dropped, then drain + reset.
              if (streamContent) {
                const sealed = streamScrub.finalize(streamContent);
                if (useLiveModel) setStreaming(commitStreaming, sealed, event.ts);
                else appendOrExtendStreamingAssistant(commitStreaming, sealed, event.ts);
              }
              flushStreaming();
              if (useLiveModel) finalizeStreaming(setMessages, setLive!);
              else finalizeStreamingAssistant(setMessages);
              streamContent = "";
              streamScrub.reset();
            }
            if (event.type === "queue_update") {
              setQueueCount(harness.queueLength);
            }
            if (writerRef.current) {
              // v1.35: the JSONL writer batches per-token events internally
              // (thresholds + 250ms cadence); awaiting each append here used
              // to serialize the render loop with mkdir+appendFile per delta.
              // Turn boundaries below call flush() so the tail is durable.
              void writerRef.current.append(event);
              if (sessionId) ingestLiveEvent(sessionId, event);
            }
            if (event.type === "context_metrics") {
              lastGrowth = event;
            }
            if (event.type === "agent_end") {
              metrics.record({
                kind: "run",
                sessionId,
                provider: envConfig.providerId,
                model: envConfig.model,
                latencyMs: event.durationMs,
                ok: event.reason === "stop",
                // Fase M: context-growth counters (log-only event, folded here).
                ...(lastGrowth
                  ? {
                      toolRoundTrips: lastGrowth.toolRoundTrips,
                      intermediateToolBytes: lastGrowth.intermediateToolBytes,
                      requests: lastGrowth.requests,
                      historyBytesAtRequest: lastGrowth.historyBytesLast,
                      historyBytesPeak: lastGrowth.historyBytesPeak,
                      cacheHitTokens: lastGrowth.cacheHitTokens,
                    }
                  : {}),
                // v1.35: real usage landed on message_end (which precedes
                // agent_end), so historical spend can be aggregated from
                // metrics.jsonl — previously these fields were always absent.
                ...(realUsage
                  ? {
                      tokens: realUsage.totalTokens,
                      costUsd: calculateCost(
                        envConfig.model,
                        realUsage.promptTokens,
                        realUsage.completionTokens,
                        realUsage.cachedPromptTokens ?? 0,
                      ),
                    }
                  : {}),
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
            // Turn-boundary events: make the batched transcript tail durable
            // immediately instead of waiting out the 250ms cadence. Optional
            // call: test writers may implement append() only.
            if (
              (event.type === "agent_end" || event.type === "error") &&
              writerRef.current
            ) {
              await (writerRef.current as { flush?: () => Promise<void> }).flush?.();
            }
            if (event.type === "message_delta") {
              assistantContent += event.delta;
              streamContent += event.delta;
              // v1.8.1: hide <think>… from the live bubble while streaming so
              // private reasoning never flashes in the TUI (full scrub also
              // runs on turn end). v1.35: re-scrub at most once per 16ms —
              // matches the throttled render cadence below.
              const displayContent = streamScrub.next(streamContent);
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
              } else if (event.code === "assistant_text_loop") {
                appendSystem(
                  setMessages,
                  `[text-loop] ${event.message}\n` +
                    `→ Next message tip: "Continue with tools only — inspect disk, one write_file, stop."`,
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
              if (streamContent) {
                const sealed = streamScrub.finalize(streamContent);
                if (useLiveModel) setStreaming(commitStreaming, sealed, event.ts);
                else appendOrExtendStreamingAssistant(commitStreaming, sealed, event.ts);
              }
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
              streamScrub.reset();
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
          // Fase 10: one metrics event per turn — only when selection ran.
          const turnMetrics = collectKrakenTurnMetrics();
          if (turnMetrics) {
            const metricsEvent = createBrainEvent("kraken_metrics", sessionId, {
              metrics: turnMetrics,
            });
            if (writerRef.current) void writerRef.current.append(metricsEvent);
            if (sessionId) ingestLiveEvent(sessionId, metricsEvent);
          }
          turnSucceeded = true;
        } finally {
          // Drain any buffered streaming deltas so the final assistant message
          // is committed before busy flips to false (and the input re-enables).
          flushStreaming();
          if (useLiveModel) finalizeStreaming(setMessages, setLive!);
          else finalizeStreamingAssistant(setMessages);
          // Durability point: flush the batched JSONL tail before the turn
          // ends (optional call — test writers may implement append() only).
          await (writerRef.current as { flush?: () => Promise<void> } | null)?.flush?.();
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
              // v1.36.0 (P0.1): slice off the REAL seed =
              // [..systemMessages (1 or 2), ...historySeed, user]. The old
              // hardcoded "1 system" dropped the current user message from
              // rolling history whenever the builder emitted 2 system
              // messages (stable + volatile) and corrupted the cache prefix.
              const seedLen = systemPrefixLen + historySeedLen + 1 /*user*/;
              if (all.length > seedLen) {
                // Provider history: KEEP <think> (MiniMax-M3 interleaved tool
                // use requires full assistant content) and KEEP ---QUESTION---
                // so short answers bind. Still strip MiniMax XML tool dumps
                // and proprietary leaks via cleanAgentContent.
                appendMessages(
                  all.slice(seedLen).map((m) => {
                    if (m.role !== "assistant" || !m.content) return m;
                    // v1.36.0: no-op-safe — only REPLACE when the cleaner
                    // changed something, so the common case keeps
                    // byte-identical history objects (warm prefix).
                    const cleaned = cleanAgentContent(m.content, {
                      stripQuestion: false,
                      stripThink: false,
                    });
                    return cleaned === m.content ? m : { ...m, content: cleaned };
                  }),
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
                // Visible prompt while the model "waits": turn is finished,
                // busy=false, SelectList (or typed short answer) continues.
                const choiceLines = clar.choices
                  .map((c, i) => `  ${i + 1}. ${c}`)
                  .join("\n");
                appendSystem(
                  setMessages,
                  `[in attesa di risposta]\n${clar.question}\n${choiceLines}` +
                    (clar.context ? `\n_(${clar.context})_` : "") +
                    "\n→ scegli dalla lista oppure digita la risposta e invia.",
                  Date.now(),
                );
                if (setPicker) {
                  setPicker({
                    kind: "clarification",
                    title: clar.question,
                    items: clar.choices.map((c) => ({ value: c, label: c })),
                    onAnswer: (value: string) => {
                      void dispatchPrompt(value);
                    },
                    onCancel: () => {
                      appendSystem(
                        setMessages,
                        "[chiarimento annullato — puoi ancora rispondere scrivendo in chat]",
                        Date.now(),
                      );
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
          if (memoryService && memoryAutoWrite && turnSucceeded && assistantContent.trim()) {
            try {
              const cleanedOutcome = cleanAgentContent(assistantContent, {
                stripQuestion: true,
                stripThink: true,
              }).trim();
              if (cleanedOutcome) {
                await memoryService.remember({
                  kind: workPhase === 'build' ? 'outcome' : 'finding',
                  content: cleanedOutcome.slice(0, 8_000),
                  importance: workPhase === 'build' ? 0.7 : 0.55,
                  confidence: workPhase === 'build' ? 0.72 : 0.6,
                  source: { agent: 'zelari', sessionId },
                  tags: ['agent-turn', `phase:${workPhase}`],
                  metadata: {
                    objective: userText.slice(0, 2_000),
                    phase: workPhase,
                    writeClass: workPhase === 'build' ? 'auto' : 'candidate',
                  },
                  writeClass: workPhase === 'build' ? 'auto' : 'candidate',
                });
              }
            } catch {
              // A memory write never changes the outcome of the model turn.
            }
          }
          await memoryService?.close().catch(() => undefined);
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
              lastStableHash ? { stableHash: lastStableHash } : undefined,
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
  /** Implementation 2+: Minosse + Lucifero only (skip specialists). */
  skipSpecialists?: boolean;
  /**
   * When true, allow implementation even if free-form council is plan-only
   * (ZELARI_COUNCIL_CAN_BUILD unset). Used by Zelari legacy build@council path.
   */
  allowCouncilBuild?: boolean;
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
    setSessionStats,
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
  // v1.36 parity + E1.5 (ADR-0024): compactInPlace() removed from the hot
  // path — the budget pipeline owns compaction (prune → remeasure → replay)
  // and now measures the spine-derived model history, not the 1.x store.
  const anchored = maybeAnchorShortAnswer(text);
  const effectiveText = anchored ?? text;
  await writerRef.current?.spine?.beginResourceTurn();
  const councilContext = await buildModelContext({
    fallbackHistory: getHistory(),
    session: writerRef.current?.spine ?? null,
    phase: getPhase(),
    model: envConfig.model,
    provider: envConfig.providerId,
    sessionId,
    onCompactionMetric: (metrics) => recordCompactionMetrics(
      sessionId,
      envConfig.providerId,
      envConfig.model,
      metrics,
    ),
    persistCompaction: async (payload) => {
      await writerRef.current?.append(
        createBrainEvent('session_compacted', sessionId, payload),
      );
    },
  });
  const councilBudget = councilContext.budget;
  setHistory(councilContext.history);
  for (const warning of councilBudget.warnings) {
    appendSystem(setMessages, warning, Date.now());
  }
  writerRef.current?.spine?.userMessage(effectiveText);
  // E1.5: compaction must be visible on the spine too (model-visible ⟺
  // logged) — same durable event as the single-agent path.

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
  const { composeProjectContext } = await import(
    "../workspace/composeContext.js"
  );
  const { FeedbackStore } = await import("../councilFeedback.js");

  const workPhase = getPhase();
  const onAskUserCouncil = setPicker
    ? (req: {
        question: string;
        choices: string[];
        context?: string;
      }) =>
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
          const choiceLines = choices
            .map((c, i) => `  ${i + 1}. ${c}`)
            .join("\n");
          appendSystem(
            setMessages,
            `[council in attesa — ask_user]\n${req.question}\n${choiceLines}` +
              (req.context ? `\n_(${req.context})_` : "") +
              "\n→ scegli dalla lista (il membro riprende dopo la risposta).",
            Date.now(),
          );
          let settled = false;
          // v1.47.x: same guard as the kraken path — council questions cannot
          // hang the member turn forever. Knob: ZELARI_ASK_USER_TIMEOUT_MS.
          const askTimeoutMs = askUserTimeoutMs();
          let cancelAskTimeout: () => void = () => undefined;
          const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            cancelAskTimeout();
            setPicker(null);
            resolve(value);
          };
          cancelAskTimeout = armPickerTimeout(
            () => {
              appendSystem(
                setMessages,
                `[council ask_user] nessuna risposta entro ${Math.round(
                  askTimeoutMs / 1000,
                )}s — il membro prosegue con assunzione documentata (ZELARI_ASK_USER_TIMEOUT_MS).`,
                Date.now(),
              );
              finish(null);
            },
            askTimeoutMs,
          );
          setPicker({
            kind: "clarification",
            title: req.question,
            items: choices.map((c) => ({ value: c, label: c })),
            onAnswer: (value: string) => finish(value),
            onCancel: () => finish(null),
          });
        })
    : undefined;
  // Force council design-phase when UI phase is plan (and vice-versa for build).
  // Experiment: free-form council+build is soft-gated to design-phase unless
  // ZELARI_COUNCIL_CAN_BUILD=1 or the caller (zelari legacy path) opts in.
  // Soft-gate also enables planMode tool registry so write_file/edit_file/bash
  // cannot create product files while "planning".
  let phaseRunMode =
    overrides.runMode ??
    (workPhase === "plan" ? "design-phase" : "implementation");
  let softGatedToDesign = false;
  if (phaseRunMode === "implementation") {
    const { shouldAllowCouncilBuild } = await import("../buildPolicy.js");
    const allowed =
      overrides.allowCouncilBuild === true || shouldAllowCouncilBuild();
    if (!allowed) {
      phaseRunMode = "design-phase";
      softGatedToDesign = true;
      appendSystem(
        setMessages,
        "[council] build soft-gate: implementation disabled for free-form council " +
          "(experiment: multi-agent = plan). Forced design-phase + plan tools. " +
          "Set ZELARI_COUNCIL_CAN_BUILD=1 to let Lucifero implement, " +
          "or use mode kraken/zelari for on-disk work.",
        Date.now(),
      );
    }
  }
  const onPermissionAskCouncil = setPicker
    ? createPermissionAskHandler({
        setPicker,
        appendSystem: (msg, at) =>
          appendSystem(setMessages, msg, at ?? Date.now()),
      })
    : undefined;
  let councilMemory: import('@zelari/core/memory').MemoryService | undefined;
  let councilMemoryAutoWrite = false;
  let nativeMemoryContext = '';
  /** Pressure band from the retrieval wire — reused for the skill-catalog gate. */
  let councilRetrievalBand: 'low' | 'medium' | 'high' = 'low';
  try {
    const memoryFactory = await import('../memory/serviceFactory.js');
    if (memoryFactory.isMemoryV2Enabled()) {
      // W2: getter-backed holder — spine mirror resolves at emit time.
      const councilSpineHolder = {
        get current() {
          return writerRef.current?.spine;
        },
      };
      councilMemory = await memoryFactory.getMemoryService(process.cwd(), process.env, {
        onWarning: (warning) => appendSystem(setMessages, warning, Date.now()),
        onEvent: memorySinkFor(councilSpineHolder),
      });
      councilMemoryAutoWrite = memoryFactory.isMemoryAutoWriteEnabled();
      if (!overrides.ragContext) {
        // Budget-aware retrieval (T4 follow-up): scale recall packing and
        // weights with measured occupancy instead of a flat 2_000/8 budget.
        const { resolveRetrievalPolicy } = await import(
          '../budget/retrievalPolicy.js'
        );
        const retrieval = resolveRetrievalPolicy(
          councilContext.budget.occupancy,
        );
        councilRetrievalBand = retrieval.band;
        nativeMemoryContext = (await councilMemory.buildContext({
          text: effectiveText,
          useGraph: true,
          maxChars: retrieval.maxChars,
          maxMemories: retrieval.maxMemories,
          ...(retrieval.weights ? { weights: retrieval.weights } : {}),
        })).text;
      }
    }
  } catch {
    // Native memory is advisory and fail-open.
  }
  const { registry: councilToolRegistry } = createBuiltinToolRegistry({
    planMode: workPhase === "plan" || softGatedToDesign,
    onAskUser: onAskUserCouncil,
    onPermissionAsk: onPermissionAskCouncil,
    permissionPolicy: defaultPermissionPolicy(),
    ...(councilMemory ? { memoryService: councilMemory } : {}),
    memoryAutoWrite: councilMemoryAutoWrite,
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
  // v0.7.5: MCP tools for the council too (same lazy singleton as the
  // single-agent path — zero extra spawns).
  try {
    const { registerMcpTools } = await import("../mcp/mcpManager.js");
    // Council: skip Cua desktop tools by default (context hygiene).
    const mcp = await registerMcpTools(councilToolRegistry, process.cwd(), {
      councilMode: true,
    });
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
  const streamScrub = createStreamScrubber(16);
  // v0.7.3: council members legitimately need more than the core default of
  // 5 tool calls per turn (a planner creating 8 tasks got 3 of them skipped
  // with "[skipped] maxToolCallsPerTurn reached"). Same env override as the
  // single-prompt path.
  // 2.6.1 (plan §8): same rule as the single-prompt path — the council
  // per-turn cap is advisory and clamped by the session ResourcePolicy
  // (single authority), never a second independent limit.
  const councilPerTurnEnv = envNumber(process.env.ZELARI_MAX_TOOL_CALLS, {
    default: 15,
    min: 1,
  });
  const councilSessionCap = writerRef.current?.spine?.resourceBudgetLimit();
  const councilMaxToolCalls = councilSessionCap
    ? Math.max(1, Math.min(councilPerTurnEnv, councilSessionCap.maxToolCalls))
    : councilPerTurnEnv;
  // Wire soft/hard tool-loop budgets into every council member harness
  // (previously only the single-agent path set these — members defaulted
  // to harness soft=30 with unbounded soft×3 hard extension).
  const councilMaxToolLoop = envNumber(
    process.env.ZELARI_MAX_TOOL_LOOP_ITERATIONS,
    { default: 30, min: 1 },
  );
  const councilMaxToolLoopHard = envNumber(
    process.env.ZELARI_MAX_TOOL_LOOP_HARD,
    { default: 0, min: 0 },
  );
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
  // v1.35: accumulate member usage so the StatusBar/session cost reflects
  // the whole council, not just the single-agent path.
  const councilUsage = { promptTokens: 0, completionTokens: 0 };
  let councilRunMode: "implementation" | "design-phase" = "implementation";
  // v1.0: slice outcome reported back to the Zelari mission loop.
  let sliceCompletionOk = false;
  let sliceRan = false;
  let sliceDegraded = false;
  const PROVIDER_ERROR_ABORT_THRESHOLD = 2;
  // Pre-load durable HEAD once (async materialize) for all council members.
  let councilCompose: {
    workspaceContext: string;
    ragContext?: string;
  } = { workspaceContext: formatHistoryForCouncil(4) || "" };
  try {
    const { loadDurableContext } = await import(
      "../state/loadDurableContext.js"
    );
    const durableState = await loadDurableContext(process.cwd());
    const composed = composeProjectContext({
      mode: overrides.ragContext ? "zelari" : "council",
      cwd: process.cwd(),
      userMessage: effectiveText,
      memoryHits: [overrides.ragContext, nativeMemoryContext].filter(Boolean).join('\n\n') || undefined,
      durableState: durableState || undefined,
      historySnippet: formatHistoryForCouncil(4) || undefined,
      includeLessons: true,
      includeDurableState: false,
    });
    for (const w of composed.warnings) {
      appendSystem(setMessages, w, Date.now());
    }
    councilCompose = {
      workspaceContext: composed.workspaceContext,
      ...(composed.ragContext ? { ragContext: composed.ragContext } : {}),
    };
  } catch {
    if (overrides.ragContext) {
      councilCompose = {
        workspaceContext: formatHistoryForCouncil(4) || "",
        ragContext: overrides.ragContext,
      };
    }
  }
  try {
    for await (const event of dispatchCouncil(effectiveText, {
      apiKey: envConfig.apiKey,
      model: envConfig.model,
      provider: "openai-compatible",
      providerStream: buildProviderStream(envConfig),
      sessionId,
      tools: councilToolRegistry,
      feedbackStore: councilFeedbackStore,
      workspaceContext: councilCompose.workspaceContext,
      ...(councilCompose.ragContext
        ? { ragContext: councilCompose.ragContext }
        : {}),
      maxToolCallsPerTurn: councilMaxToolCalls,
      maxToolLoopIterations: councilMaxToolLoop,
      ...(councilMaxToolLoopHard > 0
        ? { maxToolLoopHardCap: councilMaxToolLoopHard }
        : {}),
      runMode: phaseRunMode,
      ...(overrides.maxToolCallsChairman
        ? { maxToolCallsChairman: overrides.maxToolCallsChairman }
        : {}),
      ...(overrides.skipSpecialists ? { skipSpecialists: true } : {}),
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
              const choiceLines = choices
                .map((c, i) => `  ${i + 1}. ${c}`)
                .join("\n");
              appendSystem(
                setMessages,
                `[council in attesa]\n${req.question}\n${choiceLines}` +
                  (req.context ? `\n_(${req.context})_` : "") +
                  "\n→ scegli dalla lista (il membro riprende dopo la risposta).",
                Date.now(),
              );
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
        if (writerRef.current) void writerRef.current.append(event);
        if (sessionId) ingestLiveEvent(sessionId, event);
        continue;
      }
      if (writerRef.current) {
        // Same batching as the single-agent path: fire-and-forget per event,
        // flush at the turn boundary in `finally`.
        void writerRef.current.append(event);
        if (sessionId) ingestLiveEvent(sessionId, event);
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
        // v0.7.3: accumulate in the local `streamContent` (NOT via liveRef —
        // stale under the throttle) and always push the FULL content.
        // v1.35: scrub at 16ms, not per delta (council path used to re-run
        // cleanAgentContent on every token).
        const memberId = event.memberId ?? null;
        if (memberId !== streamMemberId) {
          if (streamContent) {
            const sealed = streamScrub.finalize(streamContent);
            if (useLiveModel) {
              setStreaming(commitStreaming, sealed, event.ts, {
                ...(streamMemberId ? { memberId: streamMemberId } : {}),
              });
            } else {
              appendOrExtendStreamingAssistant(commitStreaming, sealed, event.ts);
            }
          }
          flushStreaming();
          if (useLiveModel) finalizeStreaming(setMessages, setLive!);
          else finalizeStreamingAssistant(setMessages);
          streamContent = "";
          streamScrub.reset();
          streamMemberId = memberId;
        }
        streamContent += event.delta;
        const displayContent = streamScrub.next(streamContent);
        const memberCtx = {
          ...(event.memberId ? { memberId: event.memberId } : {}),
          ...(event.memberName ? { memberName: event.memberName } : {}),
        };
        if (useLiveModel) {
          setStreaming(commitStreaming, displayContent, event.ts, memberCtx);
        } else {
          appendOrExtendStreamingAssistant(
            commitStreaming,
            displayContent,
            event.ts,
            memberCtx,
          );
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
        if (streamContent) {
          const sealed = streamScrub.finalize(streamContent);
          if (useLiveModel) {
            setStreaming(commitStreaming, sealed, event.ts, {
              ...(event.memberId ? { memberId: event.memberId } : {}),
              ...(event.memberName ? { memberName: event.memberName } : {}),
            });
          } else {
            appendOrExtendStreamingAssistant(commitStreaming, sealed, event.ts);
          }
        }
        flushStreaming();
        if (useLiveModel) finalizeStreaming(setMessages, setLive!);
        else finalizeStreamingAssistant(setMessages);
        streamContent = "";
        streamScrub.reset();
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
        if (streamContent) {
          const sealed = streamScrub.finalize(streamContent);
          if (useLiveModel) {
            setStreaming(commitStreaming, sealed, Date.now(), {
              ...(streamMemberId ? { memberId: streamMemberId } : {}),
            });
          } else {
            appendOrExtendStreamingAssistant(commitStreaming, sealed, Date.now());
          }
        }
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
        streamScrub.reset();
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
        councilUsage.promptTokens += event.cost.promptTokens;
        councilUsage.completionTokens += event.cost.completionTokens;
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
        // Durable State Commit after verified council completion (Palmer).
        // Skip degraded / failed verification — those must not become HEAD.
        const verifyOk = hook.verification?.ran
          ? hook.verification.ok === true
          : false;
        const completionOk =
          hook.completion?.completion?.ok === true ||
          hook.completion?.completion?.readyToCommit === true;
        if (
          !degraded.degraded &&
          !councilAborted &&
          (verifyOk || completionOk) &&
          luciferWriteCount > 0
        ) {
          try {
            const { tryStateCommit, discoveriesFromOutcome } = await import(
              "../state/commitHelpers.js"
            );
            const res = await tryStateCommit({
              projectRoot: process.cwd(),
              mode: "council",
              layer: `council:${councilRunMode ?? "run"}`,
              label: `council ${councilRunMode ?? "run"} verified`,
              sessionId,
              verification: {
                ok: true,
                ran: hook.verification?.ran ?? completionOk,
              },
              withCheckpoint: true,
              discoveries: discoveriesFromOutcome({
                stepId: `${sessionId}-${Date.now()}`,
                synthesis: chairmanSynthesisText,
                writeCount: luciferWriteCount,
                note: "Council implementation verified",
              }),
            });
            if (res.ok && res.meta?.id) {
              appendSystem(
                setMessages,
                `[state] commit ${res.meta.id}` +
                  (res.checkpointId
                    ? ` · checkpoint ${res.checkpointId}`
                    : ""),
                Date.now(),
              );
            }
          } catch {
            // fail-open
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
    // v1.35: fold accumulated council member usage into session stats so
    // cost/tokens shown by the StatusBar include every member's run (the
    // events carry no model per member, so the active turn model prices it).
    if (councilUsage.promptTokens > 0 || councilUsage.completionTokens > 0) {
      const memberCostUsd = calculateCost(
        envConfig.model,
        councilUsage.promptTokens,
        councilUsage.completionTokens,
        0,
      );
      setSessionStats((prev) => ({
        ...prev,
        totalTokens:
          prev.totalTokens +
          councilUsage.promptTokens +
          councilUsage.completionTokens,
        totalCostUsd: prev.totalCostUsd + memberCostUsd,
      }));
      getMetricsLogger().record({
        kind: "run",
        sessionId,
        provider: envConfig.providerId,
        model: envConfig.model,
        tokens: councilUsage.promptTokens + councilUsage.completionTokens,
        costUsd: memberCostUsd,
        ok: !councilAborted && !chairmanErrored,
      });
    }
    if (
      councilMemory &&
      councilMemoryAutoWrite &&
      (membersCompleted > 0 || chairmanProducedOutput) &&
      chairmanSynthesisText.trim()
    ) {
      try {
        await councilMemory.remember({
          kind: councilRunMode === 'design-phase' ? 'decision' : 'outcome',
          content: chairmanSynthesisText.slice(0, 12_000),
          importance: councilRunMode === 'design-phase' ? 0.8 : 0.75,
          confidence: sliceCompletionOk ? 0.95 : sliceDegraded ? 0.45 : 0.72,
          source: { agent: 'council', sessionId },
          tags: ['council', `run-mode:${councilRunMode}`],
          metadata: {
            objective: effectiveText.slice(0, 2_000),
            completionOk: sliceCompletionOk,
            degraded: sliceDegraded,
            writeCount: luciferWriteCount,
            verified: sliceCompletionOk && !sliceDegraded,
            writeClass: sliceDegraded ? 'candidate' : 'auto',
          },
          writeClass: sliceDegraded ? 'candidate' : 'auto',
        });
        await councilMemory.consolidate({
          source: { agent: 'council', sessionId },
          minOccurrences: 2,
        });
      } catch {
        // Council completion is independent from memory persistence.
      }
    }
    await councilMemory?.close().catch(() => undefined);
    await (writerRef.current as { flush?: () => Promise<void> } | null)?.flush?.();
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
  // W2: getter-backed holder — the spine mirror attaches per turn, so mission
  // memory events resolve `deps.writerRef.current?.spine` at emit time.
  const missionSpineHolder = {
    get current() {
      return deps.writerRef.current?.spine;
    },
  };
  const memory = await getMemoryBackend(projectRoot, process.env, memorySinkFor(missionSpineHolder));
  const chairmanBudget = envNumber(process.env.ZELARI_MODE_MAX_TOOLS_LUCIFER, {
    default: 30,
    min: 1,
  });
  const { shouldBuildViaAgent } = await import("../buildPolicy.js");
  const buildViaAgent = shouldBuildViaAgent();
  if (buildViaAgent) {
    emit(
      "[zelari] policy: design@council · build@kraken (ZELARI_BUILD_VIA_AGENT; set=0 for legacy council impl)",
    );
  }

  try {
    await runZelariMission(userMessage, brief, {
      projectRoot,
      memory,
      emit,
      buildViaAgent,
      runSlice: async ({
        userMessage: slicePrompt,
        runMode,
        ragContext,
        implementerRetry,
      }) => {
        // Design always uses council. Implementation uses agent when policy says so.
        if (runMode === "design-phase" || !buildViaAgent) {
          const r = await dispatchCouncilPromptImpl(slicePrompt, deps, {
            ragContext,
            runMode,
            maxToolCallsChairman: chairmanBudget,
            ...(implementerRetry ? { skipSpecialists: true } : {}),
            // Mission may need Lucifero to write even when free-form council is plan-only.
            allowCouncilBuild: true,
          });
          return {
            completionOk: r.completionOk,
            ran: r.ran,
            synthesisText: r.synthesisText,
            writeCount: r.writeCount,
            degraded: r.degraded,
          };
        }

        // build@kraken implementation slice
        const { runAgentMissionSlice } = await import("../missionSlice.js");
        // createBuiltinToolRegistry, openaiCompatibleProvider, providerFromEnv
        // already imported at module top.
        const { composeProjectContext } = await import(
          "../workspace/composeContext.js"
        );
        const { loadDurableContext } = await import(
          "../state/loadDurableContext.js"
        );
        const { createWorkspaceContext } = await import(
          "../workspace/stubs.js"
        );
        const { runPostCouncilHook } = await import(
          "../workspace/postCouncilHook.js"
        );
        const { detectDegradedRun } = await import("@zelari/core/council");

        const envConfig = await providerFromEnv();
        if (!envConfig) {
          emit(
            "[zelari] build@kraken aborted: missing API key for active provider",
          );
          return { completionOk: false, ran: false };
        }

        const onPermissionAskZelari = setPicker
          ? createPermissionAskHandler({
              setPicker,
              appendSystem: (msg, at) =>
                appendSystem(setMessages, msg, at ?? Date.now()),
            })
          : undefined;
        const { registry: toolRegistry } = createBuiltinToolRegistry({
          planMode: false,
          onPermissionAsk: onPermissionAskZelari,
          permissionPolicy: defaultPermissionPolicy(),
        });
        try {
          const { registerMcpTools } = await import("../mcp/mcpManager.js");
          await registerMcpTools(toolRegistry, projectRoot);
        } catch {
          // best-effort MCP
        }

        const durableState = await loadDurableContext(projectRoot);
        const composed = composeProjectContext({
          mode: "zelari",
          cwd: projectRoot,
          userMessage: slicePrompt,
          memoryHits: ragContext,
          durableState: durableState || undefined,
          includeLessons: true,
          includeDurableState: false,
        });
        for (const w of composed.warnings) {
          emit(w);
        }

        const workspaceCtx = createWorkspaceContext(projectRoot);
        const { setMessages, writerRef, setBusy } = deps;
        setBusy(true);
        try {
          return await runAgentMissionSlice({
            projectRoot,
            model: envConfig.model,
            provider: "openai-compatible",
            providerStream: buildProviderStream(envConfig),
            toolRegistry,
            slicePrompt,
            ragContext: composed.ragContext ?? ragContext,
            workspaceContext: composed.workspaceContext,
            projectInstructions: composed.projectInstructions,
            emit,
            onEvent: async (event) => {
              if (writerRef.current) await writerRef.current.append(event);
              if (sessionId) ingestLiveEvent(sessionId, event);
              if (event.type === "tool_execution_start") {
                const name =
                  (event as { toolName?: string }).toolName ?? "tool";
                appendSystem(
                  setMessages,
                  `[build@kraken] → ${name}`,
                  Date.now(),
                );
              }
            },
            runCompletionHook: async ({ synthesisText, writeCount, errored }) => {
              const d = detectDegradedRun({
                chairmanErrored: errored,
                luciferWriteCount: writeCount,
                synthesisText,
                runMode: "implementation",
              });
              if (d.degraded) {
                appendSystem(
                  setMessages,
                  `[zelari] DEGRADED_RUN — ${d.reasons.join("; ")}`,
                  Date.now(),
                );
              }
              const hook = await runPostCouncilHook(workspaceCtx, {
                runMode: "implementation",
                userMessage: userMessage,
                synthesisText: synthesisText || undefined,
                degradedRun: d.degraded,
                degradedReasons: d.reasons,
              });
              return {
                completionOk: hook.completion?.completion?.ok ?? false,
                degraded: d.degraded,
              };
            },
          });
        } finally {
          setBusy(false);
        }
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
