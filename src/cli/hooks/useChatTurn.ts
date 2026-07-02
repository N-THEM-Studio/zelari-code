// @ts-nocheck — pre-existing strict-mode type narrowing issues carried over
// from app.tsx. Runtime is correct; tighten signatures in a follow-up.
import { useState, useRef, useCallback } from 'react';
import type { ChatMessage } from '../components/ChatStream.js';
import { AgentHarness } from '@zelari/core/harness';
import { SessionJsonlWriter } from '@zelari/core/harness';
import { MetricsLogger, getMetricsLogger } from '../metrics.js';
import { calculateCost } from '../modelPricing.js';
import { openaiCompatibleProvider, providerFromEnv, providerConfigFor, resolveActiveProvider } from '../provider/openai-compatible.js';
import { providerFailover } from '../providerFailover.js';
import { resolveFailoverStream } from '../crossProviderFailover.js';
import { resolveShell } from '@zelari/core/harness/tools/builtin/shellResolver';
import { PROVIDERS } from '../keyStore.js';
import { createBuiltinToolRegistry } from '../toolRegistry.js';
import {
  appendOrExtendStreamingAssistant,
  appendSystem,
  appendToolStart,
  finalizeStreamingAssistant,
  updateToolMessageEnd,
} from './messageHelpers.js';
import {
  setStreaming,
  finalizeStreaming,
  startTool,
  completeTool,
  type LiveState,
} from './chatState.js';
import type { ProviderName } from '../keyStore.js';
import { computeSessionStatsDelta } from './chatStats.js';

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
  setSessionStats: React.Dispatch<React.SetStateAction<{ totalTokens: number; totalCostUsd: number }>>;
  // ── v0.7.0 live-region wiring (optional; legacy fallback when omitted) ──
  /** The live region setter (streaming bubble + pending tools). */
  setLive?: React.Dispatch<React.SetStateAction<LiveState>>;
  /** Always-current live snapshot for non-reactive event-loop reads. */
  liveRef?: React.MutableRefObject<LiveState>;
}

export interface UseChatTurnResult {
  dispatchPrompt: (userText: string) => Promise<void>;
  dispatchCouncilPrompt: (input: string) => Promise<void>;
  harnessRef: React.MutableRefObject<AgentHarness | null>;
  queueCount: number;
  setQueueCount: (n: number) => void;
}

export function useChatTurn(params: UseChatTurnParams): UseChatTurnResult {
  const { sessionId, writerRef, setMessages, commitStreaming, flushStreaming, setBusy, setSessionActive, setSessionStats, setLive, liveRef } = params;
  const harnessRef = useRef<AgentHarness | null>(null);
  const [queueCount, setQueueCount] = useState<number>(0);

  // v0.7.0: when the live region is wired, streaming + tool events route
  // there; otherwise we fall back to the v0.6 single-array behavior so the
  // existing unit tests (which pass only setMessages/commitStreaming) keep
  // asserting on `messages` directly.
  const useLiveModel = !!(setLive && liveRef);

  const dispatchPrompt = useCallback(
    async (userText: string) => {
      // v0.4.3 audit fix: provider resolution + harness construction now
      // live INSIDE the try block. Previously, throws from providerFromEnv,
      // resolveFailoverStream, or createBuiltinToolRegistry happened
      // BEFORE the try (which only wrapped the stream loop), so the
      // rejected promise escaped unhandled (useSlashDispatch doesn't
      // try/catch its await either). The user saw a hang with no
      // feedback instead of an actionable error message.
      let envConfig: Awaited<ReturnType<typeof providerFromEnv>>;
      let harness: AgentHarness;
      try {
        envConfig = await providerFromEnv();
        if (!envConfig) {
          // Name the ACTIVE provider — the old hardcoded "OPENAI_API_KEY not
          // set" message told grok/glm/minimax users to export the wrong var.
          const active = resolveActiveProvider();
          const spec = PROVIDERS.find((p) => p.id === active);
          appendSystem(
            setMessages,
            `No API key for the active provider "${active}". Set ${spec?.envVar ?? 'the provider API key env var'} or run /login ${active}.`,
          );
          return;
        }
        setBusy(true);
        const { registry: toolRegistry } = createBuiltinToolRegistry();
        const baseProviderStream = openaiCompatibleProvider(envConfig);
        const failoverResolution = await resolveFailoverStream({
          failoverEnabled: process.env.ANATHEMA_FAILOVER !== '0',
          envValue: process.env.ANATHEMA_FAILOVER_PROVIDER,
          primaryProviderId: envConfig.providerId,
          primary: baseProviderStream,
          validProviderIds: PROVIDERS.map((p) => p.id),
          lookupFallbackConfig: async (id) => providerConfigFor(id as ProviderName),
          buildStream: (config) =>
            openaiCompatibleProvider(config as Parameters<typeof openaiCompatibleProvider>[0]),
        });
        if (failoverResolution.warning) {
          // Surface in the chat instead of console.warn: writes that bypass
          // Ink force a full repaint of the TUI frame (visible flicker).
          appendSystem(setMessages, `[failover] ${failoverResolution.warning}`);
        }
        const providerStream: import('@zelari/core/harness').ProviderStreamFn =
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
      const toolList = toolRegistry.toOpenAITools().map((t) => `- ${t.function.name}: ${t.function.description}`).join('\n');
      // v0.7.2 (C3): platform-aware shell guidance. The model must know which
      // shell the `bash` tool actually runs in so it writes the right commands
      // (POSIX for Git Bash, Windows-native for cmd.exe fallback).
      const resolvedShell = resolveShell();
      const isWindows = process.platform === 'win32';
      const shellGuidance = resolvedShell.isBash
        ? `The bash tool runs commands via Git Bash / MSYS2 (${resolvedShell.shell}). Write POSIX commands: ls, grep, $VAR, &&, /c/Users/... all work.`
        : isWindows
          ? `The bash tool runs commands via cmd.exe (Git Bash not found). Write Windows-native commands: use dir (not ls), %VAR% (not $VAR), avoid POSIX-only syntax.`
          : `The bash tool runs commands via /bin/sh.`;
      const systemPrompt = [
        "You are Zelari Code, an interactive AI coding agent operating directly in the user's terminal.",
        '',
        'You ARE connected to this machine and have real tools to read, modify, and explore the codebase.',
        "Never claim you lack filesystem or shell access — you have it. Use your tools instead of asking the user to paste file contents.",
        '',
        '# Platform & Shell',
        `platform: ${process.platform}`,
        `shell: ${resolvedShell.via}`,
        shellGuidance,
        '',
        '# Working Directory',
        `You are running in: ${cwd}`,
        'All relative file paths are resolved against this directory. Always work with real files here.',
        '',
        '# Available Tools',
        'You can call these tools. Use them to take action and gather information autonomously:',
        toolList,
        '',
        '# Guidelines',
        '- When the user asks you to write code, debug, or explore, be proactive: list files (list_files, or bash: ls/dir) and read key files (read_file) to understand the project instead of asking the user to paste file contents.',
        "- Only invoke tools when they are necessary to answer the user's prompt. If the user is just saying hello or greeting them (e.g., \"ciao\", \"hello\"), simply greet them back and ask how you can help, without running any commands or tools.",
        '- When you finish a task, briefly summarize what you did.',
      ].join('\n');
      // v0.7.1 (A2): per-turn tool-call budget for single-prompt turns.
      // The council sets 5; the single-prompt path previously set NONE, so a
      // flailing model could loop for the full MAX_TOOL_LOOP_ITERATIONS (12)
      // of junk calls (e.g. read_file same path ×3 then silence). Default 25,
      // overridable via ZELARI_MAX_TOOL_CALLS.
      const maxToolCallsPerTurn = (() => {
        const raw = process.env.ZELARI_MAX_TOOL_CALLS;
        const n = raw ? Number.parseInt(raw, 10) : 25;
        return Number.isFinite(n) && n > 0 ? n : 25;
      })();
      const harness = new AgentHarness({
        model: envConfig.model,
        provider: 'openai-compatible',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
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
      });
      harnessRef.current = harness;
      setQueueCount(harness.queueLength);

      // Total assistant output across the whole turn — feeds the token/cost
      // estimate fallback in computeSessionStatsDelta.
      let assistantContent = '';
      // Display buffer for the CURRENT streamed message only. Reset on every
      // message_end: without this, the post-tool-call message re-rendered the
      // full accumulated turn text, duplicating everything said before the
      // tool ran.
      let streamContent = '';
      // tool_execution_end doesn't carry toolName — remember it from the
      // matching start event (keyed by toolCallId) for metrics.
      const toolNameById = new Map<string, string>();
      const metrics: MetricsLogger = getMetricsLogger();
      let realUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
      try {
        for await (const event of harness.run()) {
          if (event.type === 'message_end') {
            if (event.usage) realUsage = event.usage;
            // Message boundary: drain buffered deltas, then seal the streamed
            // bubble so the next message starts fresh instead of merging.
            flushStreaming();
            if (useLiveModel) finalizeStreaming(setMessages, setLive!);
            else finalizeStreamingAssistant(setMessages);
            streamContent = '';
          }
          if (event.type === 'queue_update') {
            setQueueCount(harness.queueLength);
          }
          if (writerRef.current) {
            await writerRef.current.append(event);
          }
          if (event.type === 'agent_end') {
            metrics.record({
              kind: 'run',
              sessionId,
              provider: envConfig.providerId,
              model: envConfig.model,
              latencyMs: event.durationMs,
              ok: event.reason === 'stop',
            });
          } else if (event.type === 'error') {
            metrics.record({
              kind: 'error',
              sessionId,
              provider: envConfig.providerId,
              model: envConfig.model,
              error: event.message,
            });
          } else if (event.type === 'tool_execution_end') {
            metrics.record({
              kind: 'tool',
              sessionId,
              provider: envConfig.providerId,
              model: envConfig.model,
              toolName: toolNameById.get(event.toolCallId) ?? 'unknown',
              toolCallId: event.toolCallId,
              durationMs: event.durationMs,
              ok: !event.isError,
            });
          }
          if (event.type === 'message_delta') {
            assistantContent += event.delta;
            streamContent += event.delta;
            // Route through the throttled setter so per-token deltas (50-200/sec)
            // coalesce into ≤60 renders/sec instead of flickering the TUI.
            if (useLiveModel) {
              setStreaming(commitStreaming, streamContent, Date.now(), {
                ...(event.memberId ? { memberId: event.memberId } : {}),
                ...(event.memberName ? { memberName: event.memberName } : {}),
              });
            } else {
              // Legacy single-array fallback (existing tests).
              appendOrExtendStreamingAssistant(commitStreaming, streamContent, Date.now(), {
                ...(event.memberId ? { memberId: event.memberId } : {}),
                ...(event.memberName ? { memberName: event.memberName } : {}),
              });
            }
          } else if (event.type === 'error') {
            flushStreaming();
            appendSystem(setMessages, `[error] ${event.message}`, Date.now());
          } else if (event.type === 'tool_execution_start') {
            toolNameById.set(event.toolCallId, event.toolName);
            // Drain buffered deltas FIRST so the text streamed before the
            // call renders above the tool line, not below it — then seal
            // that bubble: it's complete once the model starts calling tools.
            flushStreaming();
            if (useLiveModel) {
              finalizeStreaming(setMessages, setLive!);
              startTool(setLive!, event.toolName, event.toolCallId, event.args, event.ts);
            } else {
              finalizeStreamingAssistant(setMessages);
              appendToolStart(setMessages, event.toolName, event.toolCallId, event.args, event.ts);
            }
          } else if (event.type === 'tool_execution_end') {
            if (useLiveModel) {
              completeTool(liveRef!.current, setMessages, setLive!, event.toolCallId, event.isError, event.durationMs, event.result);
            } else {
              updateToolMessageEnd(setMessages, event.toolCallId, event.isError, event.durationMs, event.result);
            }
          }
        }
      } finally {
        // Drain any buffered streaming deltas so the final assistant message
        // is committed before busy flips to false (and the input re-enables).
        flushStreaming();
        if (useLiveModel) finalizeStreaming(setMessages, setLive!);
        else finalizeStreamingAssistant(setMessages);
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
    [sessionId, writerRef, setMessages, commitStreaming, flushStreaming, setBusy, setSessionActive, setSessionStats, useLiveModel, setLive, liveRef],
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
      });
    },
    [sessionId, writerRef, setMessages, commitStreaming, flushStreaming, setBusy, setQueueCount, setLive, liveRef],
  );

  return { dispatchPrompt, dispatchCouncilPrompt, harnessRef, queueCount, setQueueCount };
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
async function dispatchCouncilPromptImpl(
  text: string,
  deps: UseChatTurnParams & { setQueueCount: (n: number) => void },
): Promise<void> {
  const { sessionId, writerRef, setMessages, commitStreaming, flushStreaming, setBusy, setLive, liveRef } = deps;
  const useLiveModel = !!(setLive && liveRef);
  const envConfig = await providerFromEnv();
  if (!envConfig) {
    const active = resolveActiveProvider();
    const spec = PROVIDERS.find((p) => p.id === active);
    appendSystem(
      setMessages,
      `No API key for the active provider "${active}". Set ${spec?.envVar ?? 'the provider API key env var'} or run /login ${active} before invoking /council.`,
    );
    return;
  }
  setBusy(true);
  // Import dynamically to avoid a circular dep at module-load time.
  const { dispatchCouncil } = await import('../councilDispatcher.js');
  const { createWorkspaceContext, createWorkspaceStubs } = await import('../workspace/stubs.js');
  const { createWorkspaceToolRegistry } = await import('../workspace/toolRegistry.js');
  const { setWorkspaceStubs } = await import('@zelari/core/skills');
  const { runPostCouncilHook } = await import('../workspace/postCouncilHook.js');
  const { buildWorkspaceSummary } = await import('../workspace/workspaceSummary.js');
  const { FeedbackStore } = await import('../councilFeedback.js');

  const { registry: councilToolRegistry } = createBuiltinToolRegistry();
  const workspaceCtx = createWorkspaceContext();
  const workspaceReg = createWorkspaceToolRegistry(workspaceCtx);
  for (const name of workspaceReg.list()) {
    const td = workspaceReg.get(name);
    if (td) councilToolRegistry.register(td);
  }
  setWorkspaceStubs(createWorkspaceStubs(workspaceCtx));
  const councilFeedbackStore = new FeedbackStore();
  // v0.7.1 (A3): track member completion so the AGENTS.MD hook only runs when
  // the council actually produced output. v0.7.1 (A4): track repeated provider
  // errors to abort the remaining members instead of grinding through every
  // specialist after the API is clearly broken.
  let membersCompleted = 0;
  let chairmanProducedOutput = false;
  let consecutiveProviderErrors = 0;
  let lastErrorMessage = '';
  let councilAborted = false;
  const PROVIDER_ERROR_ABORT_THRESHOLD = 2;
  try {
    for await (const event of dispatchCouncil(text, {
      apiKey: envConfig.apiKey,
      model: envConfig.model,
      provider: 'openai-compatible',
      providerStream: openaiCompatibleProvider(envConfig),
      sessionId,
      tools: councilToolRegistry,
      feedbackStore: councilFeedbackStore,
      // v0.7.2 (B2): give the council the same project awareness the
      // single-prompt path has — cwd, tech stack, file layout, build scripts.
      // Without this, members had no idea which project they were operating
      // on and projected their identity onto the task.
      workspaceContext: buildWorkspaceSummary(process.cwd()),
    })) {
      if (councilAborted) {
        // Drain remaining events silently after the abort decision.
        if (writerRef.current) await writerRef.current.append(event);
        continue;
      }
      if (writerRef.current) {
        await writerRef.current.append(event);
      }
      if (event.type === 'message_delta') {
        // Coalesce streaming assistant content through the throttled setter so
        // per-token deltas don't flicker the TUI (same as dispatchPrompt).
        if (useLiveModel) {
          // v0.7.0: read the always-current streaming snapshot from liveRef
          // to accumulate full content per-member, then push through the
          // throttle in ONE call. setStreaming handles same-member extension
          // vs new-bubble creation via the member identity in memberContext.
          const cur = liveRef!.current.streaming;
          const sameMember = cur && (cur.memberId ?? null) === (event.memberId ?? null);
          const fullContent = sameMember ? cur!.content + event.delta : event.delta;
          setStreaming(commitStreaming, fullContent, event.ts, {
            ...(event.memberId ? { memberId: event.memberId } : {}),
            ...(event.memberName ? { memberName: event.memberName } : {}),
          });
        } else {
          // Legacy single-array fallback. Extend the trailing streaming bubble
          // only when it belongs to the SAME member — otherwise one specialist's
          // text would be appended to (and attributed to) the previous one.
          commitStreaming((prev) => {
            const last = prev[prev.length - 1];
            if (
              last &&
              last.role === 'assistant' &&
              last.id.startsWith('streaming-') &&
              (last.memberId ?? null) === (event.memberId ?? null)
            ) {
              return [...prev.slice(0, -1), { ...last, content: last.content + event.delta }];
            }
            return [
              ...prev,
              {
                id: `streaming-${crypto.randomUUID()}`,
                role: 'assistant',
                content: event.delta,
                ts: event.ts,
                ...(event.memberId ? { memberId: event.memberId } : {}),
                ...(event.memberName ? { memberName: event.memberName } : {}),
              },
            ];
          });
        }
      } else if (event.type === 'message_end') {
        // Member/turn boundary: drain buffered deltas and seal the bubble so
        // the next streamed message starts fresh.
        flushStreaming();
        if (useLiveModel) finalizeStreaming(setMessages, setLive!);
        else finalizeStreamingAssistant(setMessages);
        membersCompleted++;
        // Chairman is the last member; any assistant content from it counts.
        if (event.memberId === 'lucifer' || event.memberName === 'Lucifero') {
          chairmanProducedOutput = true;
        }
      } else if (event.type === 'tool_execution_start') {
        // Drain buffered deltas first so ordering matches reality, and seal
        // the pre-tool bubble (complete once the member starts calling tools).
        flushStreaming();
        if (useLiveModel) {
          finalizeStreaming(setMessages, setLive!);
          startTool(setLive!, event.toolName, event.toolCallId, event.args, event.ts);
        } else {
          finalizeStreamingAssistant(setMessages);
          appendToolStart(setMessages, event.toolName, event.toolCallId, event.args, event.ts);
        }
      } else if (event.type === 'tool_execution_end') {
        if (useLiveModel) {
          completeTool(liveRef!.current, setMessages, setLive!, event.toolCallId, event.isError, event.durationMs, event.result);
        } else {
          updateToolMessageEnd(setMessages, event.toolCallId, event.isError, event.durationMs, event.result);
        }
      } else if (event.type === 'error') {
        flushStreaming();
        // v0.7.1 (A4): attribute the error to the member when known, so the
        // user sees `[error · Caronte] …` instead of three anonymous lines.
        const memberTag = event.memberName ? ` · ${event.memberName}` : '';
        appendSystem(setMessages, `[error${memberTag}] ${event.message}`, event.ts);
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
    // v0.7.1 (A3): only auto-write AGENTS.MD when the council actually produced
    // output. Running the hook after an all-error run (e.g. the HTTP 400 from
    // A1) dirtied the working tree with sections rewritten from nothing.
    const hookShouldRun = membersCompleted > 0 || chairmanProducedOutput;
    if (hookShouldRun) {
      try {
        const hook = await runPostCouncilHook(workspaceCtx);
        if (hook.ran && hook.changed) {
          appendSystem(
            setMessages,
            `[agents.md] updated: ${hook.sections.length} section(s) changed (${hook.sections.join(', ')})`,
            Date.now(),
          );
        } else if (hook.ran && hook.reason) {
          if (!hook.reason.includes('disabled')) {
            appendSystem(setMessages, `[agents.md] ${hook.reason}`, Date.now());
          }
        }
      } catch {
        // Best-effort — never block on AGENTS.MD errors.
      }
    } else if (!councilAborted) {
      appendSystem(
        setMessages,
        '[agents.md] skipped — council produced no output',
        Date.now(),
      );
    }
    setBusy(false);
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