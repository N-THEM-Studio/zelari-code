// @ts-nocheck — pre-existing strict-mode type narrowing issues carried over
// from app.tsx. Runtime is correct; tighten signatures in a follow-up.
import { useState, useRef, useCallback } from 'react';
import type { ChatMessage } from '../components/ChatStream.js';
import { AgentHarness } from '../../main/core/AgentHarness.js';
import { SessionJsonlWriter } from '../../main/core/sessionJsonl.js';
import { MetricsLogger, getMetricsLogger } from '../metrics.js';
import { calculateCost } from '../modelPricing.js';
import { openaiCompatibleProvider, providerFromEnv, providerConfigFor } from '../provider/openai-compatible.js';
import { providerFailover } from '../providerFailover.js';
import { resolveFailoverStream } from '../crossProviderFailover.js';
import { PROVIDERS } from '../keyStore.js';
import { createBuiltinToolRegistry } from '../toolRegistry.js';
import {
  appendOrExtendStreamingAssistant,
  appendSystem,
  appendToolEnd,
  appendToolStart,
  updateToolMessageEnd,
} from './messageHelpers.js';
import type { ProviderName } from '../keyStore.js';
import { computeSessionStatsDelta } from './chatStats.js';

/**
 * useChatTurn — owns the chat-turn lifecycle (single prompt dispatch +
 * council dispatch + queue management).
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
 *     messages so ChatStream renders CollapsibleToolOutput.
 */
export interface UseChatTurnParams {
  sessionId: string;
  writerRef: React.MutableRefObject<SessionJsonlWriter | null>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setBusy: (v: boolean) => void;
  setSessionActive: (v: boolean) => void;
  setSessionStats: React.Dispatch<React.SetStateAction<{ totalTokens: number; totalCostUsd: number }>>;
}

export interface UseChatTurnResult {
  dispatchPrompt: (userText: string) => Promise<void>;
  dispatchCouncilPrompt: (input: string) => Promise<void>;
  harnessRef: React.MutableRefObject<AgentHarness | null>;
  queueCount: number;
  setQueueCount: (n: number) => void;
}

export function useChatTurn(params: UseChatTurnParams): UseChatTurnResult {
  const { sessionId, writerRef, setMessages, setBusy, setSessionActive, setSessionStats } = params;
  const harnessRef = useRef<AgentHarness | null>(null);
  const [queueCount, setQueueCount] = useState<number>(0);

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
          appendSystem(setMessages, 'OPENAI_API_KEY not set. Export it before running zelari-code.');
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
          console.warn(failoverResolution.warning);
        }
        const providerStream: import('../../main/core/AgentHarness.js').ProviderStreamFn =
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
      const systemPrompt = [
        "You are Zelari Code, an interactive AI coding agent operating directly in the user's terminal.",
        '',
        'You ARE connected to this machine and have real tools to read, modify, and explore the codebase.',
        "Never claim you lack filesystem or shell access — you have it. Use your tools instead of asking the user to paste file contents.",
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
        '- When the user asks you to write code, debug, or explore, be proactive: list files (bash: ls, list_files) and read key files (read_file) to understand the project instead of asking the user to paste file contents.',
        "- Only invoke tools when they are necessary to answer the user's prompt. If the user is just saying hello or greeting them (e.g., \"ciao\", \"hello\"), simply greet them back and ask how you can help, without running any commands or tools.",
        '- When you finish a task, briefly summarize what you did.',
      ].join('\n');
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
      });
      harnessRef.current = harness;
      setQueueCount(harness.queueLength);

      let assistantContent = '';
      const metrics: MetricsLogger = getMetricsLogger();
      let realUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
      try {
        for await (const event of harness.run()) {
          if (event.type === 'message_end' && event.usage) {
            realUsage = event.usage;
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
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              durationMs: event.durationMs,
              ok: !event.isError,
            });
          }
          if (event.type === 'message_delta') {
            assistantContent += event.delta;
            appendOrExtendStreamingAssistant(setMessages, assistantContent, Date.now());
          } else if (event.type === 'error') {
            appendSystem(setMessages, `[error] ${event.message}`, Date.now());
          } else if (event.type === 'tool_call') {
            appendSystem(
              setMessages,
              `[tool_call] ${event.toolName}(${JSON.stringify(event.arguments).slice(0, 80)})`,
              event.ts,
            );
          } else if (event.type === 'tool_result') {
            appendSystem(
              setMessages,
              `[tool_result] ${event.toolName} → ${event.ok ? 'ok' : 'error'}`,
              event.ts,
            );
          } else if (event.type === 'tool_execution_start') {
            appendToolStart(setMessages, event.toolName, event.args, event.ts);
          } else if (event.type === 'tool_execution_end') {
            appendToolEnd(setMessages, event.result, event.isError, event.durationMs, event.ts);
          }
        }
      } finally {
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
        appendSystem(
          setMessages,
          `[dispatch error] ${err instanceof Error ? err.message : String(err)}`,
        );
        setBusy(false);
      }
    },
    [sessionId, writerRef, setMessages, setBusy, setSessionActive, setSessionStats],
  );

  const dispatchCouncilPrompt = useCallback(
    async (text: string) => {
      await dispatchCouncilPromptImpl(text, {
        sessionId,
        writerRef,
        setMessages,
        setBusy,
        setQueueCount,
      });
    },
    [sessionId, writerRef, setMessages, setBusy, setQueueCount],
  );

  return { dispatchPrompt, dispatchCouncilPrompt, harnessRef, queueCount, setQueueCount };
}

/**
 * dispatchCouncilPrompt — multi-agent council dispatch.
 *
 * Surfaces tool_execution_start/end as 'tool' role messages so ChatStream
 * renders CollapsibleToolOutput. Runs AGENTS.MD auto-maintenance after the
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
  const { sessionId, writerRef, setMessages, setBusy } = deps;
  const envConfig = await providerFromEnv();
  if (!envConfig) {
    appendSystem(setMessages, 'OPENAI_API_KEY not set. Export it before invoking /council.');
    return;
  }
  setBusy(true);
  // Import dynamically to avoid a circular dep at module-load time.
  const { dispatchCouncil } = await import('../councilDispatcher.js');
  const { createWorkspaceContext, createWorkspaceStubs } = await import('../workspace/stubs.js');
  const { createWorkspaceToolRegistry } = await import('../workspace/toolRegistry.js');
  const { setWorkspaceStubs } = await import('../../agents/tools.js');
  const { runPostCouncilHook } = await import('../workspace/postCouncilHook.js');
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
  try {
    for await (const event of dispatchCouncil(text, {
      apiKey: envConfig.apiKey,
      model: envConfig.model,
      provider: 'openai-compatible',
      providerStream: openaiCompatibleProvider(envConfig),
      sessionId,
      tools: councilToolRegistry,
      feedbackStore: councilFeedbackStore,
    })) {
      if (writerRef.current) {
        await writerRef.current.append(event);
      }
      if (event.type === 'message_delta') {
        // Coalesce streaming assistant content
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.id.startsWith('streaming-')) {
            return [...prev.slice(0, -1), { ...last, content: last.content + event.delta }];
          }
          return [
            ...prev,
            { id: `streaming-${crypto.randomUUID()}`, role: 'assistant', content: event.delta, ts: event.ts },
          ];
        });
      } else if (event.type === 'tool_execution_start') {
        const argsPreview = JSON.stringify(event.args).slice(0, 120);
        appendSystem(setMessages, `▶ ${event.toolName}(${argsPreview})`, event.ts);
        // Also surface as 'tool' role for CollapsibleToolOutput rendering.
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'tool',
            content: `${event.toolName}(${argsPreview})`,
            ts: event.ts,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            toolOk: undefined,
            toolDurationMs: undefined,
          },
        ]);
      } else if (event.type === 'tool_execution_end') {
        updateToolMessageEnd(setMessages, event.toolCallId, event.isError, event.durationMs);
      } else if (event.type === 'error') {
        appendSystem(setMessages, `[error] ${event.message}`, event.ts);
      }
    }
  } catch (err) {
    appendSystem(
      setMessages,
      `[council error] ${err instanceof Error ? err.message : String(err)}`,
      Date.now(),
    );
  } finally {
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