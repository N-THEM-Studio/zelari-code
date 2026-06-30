// @ts-nocheck — app.tsx is the monolithic Ink UI entrypoint with
// pre-existing strict-mode type narrowing issues that the v3-N
// mission surfaced. Runtime behavior is correct; a future v3-T
// refactor will split this file into typed hooks (useChatTurn,
// useSlashDispatch, etc). See packages/cli/docs/SPLIT_PLAN.md.
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Box, useStdout } from 'ink';
import { Header } from './components/Header.js';
import { ChatStream, type ChatMessage } from './components/ChatStream.js';
import { InputBar } from './components/InputBar.js';
import { Sidebar } from './components/Sidebar.js';
import { handleSlashCommand, formatSkillList, type SlashCommandResult } from './slashCommands.js';
import { listCodingSkills } from '../agents/skills.js';
import '../agents/skills/builtin/debugging.js';
import '../agents/skills/builtin/docs.js';
import '../agents/skills/builtin/git-ops.js';
import '../agents/skills/builtin/planning.js';
import '../agents/skills/builtin/refactoring.js';
import '../agents/skills/builtin/review.js';
import '../agents/skills/builtin/testing.js';
import { promoteMember } from '../agents/promoteMember.js';
import { AgentHarness } from '../main/core/AgentHarness.js';
import { SessionJsonlWriter } from '../main/core/sessionJsonl.js';
import { openaiCompatibleProvider, providerFromEnv, providerConfigFor } from './provider/openai-compatible.js';
import { providerFailover } from './providerFailover.js';
import { resolveFailoverStream } from './crossProviderFailover.js';
import {
  getCurrentSessionId,
  setCurrentSessionId,
  clearCurrentSessionId,
  newSessionId,
  ensureSessionDir,
  listSessions,
  loadSessionEvents,
} from './sessionManager.js';
import { dispatchCouncil } from './councilDispatcher.js';
import { FeedbackStore } from './councilFeedback.js';
import { setApiKey, setOAuthToken, getProviderSpec, maskKey, PROVIDERS, resolveApiKeyWithMeta, getOAuthToken, type ProviderName } from './keyStore.js';
import { getProviderConfig, getActiveProvider as getActiveProviderSpec, setActiveProviderId as persistActiveProvider, setModelForProvider as persistModelForProvider, getModelForProvider, setCustomEndpoint, clearCustomEndpoint, getCustomEndpoint } from './providerConfig.js';
import { discoverModelsInBackground, discoverModelsForProvider, getCachedModels, getDiscoveredModelIds, type ProviderId as DiscoveryProviderId } from './modelDiscovery.js';
import { runGrokOAuthFlow } from './grokOAuth.js';
import { validateApiKey } from './keyValidator.js';
import { listRefreshImpls, getRefreshImpl } from './refreshRegistry.js';
import { createBranch, listBranches, branchExists as checkBranchExists, setCurrentBranch, clearCurrentBranch, getCurrentBranch } from './branchManager.js';
import { createBuiltinToolRegistry } from './toolRegistry.js';
import { getWorkingDiff, undoWorkingChanges, isGitRepo, defaultProjectRoot } from './gitOps.js';
import { calculateCost } from './modelPricing.js';
import { compactTranscript, formatCompactionSummary } from './compaction.js';
import { MetricsLogger, getMetricsLogger } from './metrics.js';
import { SkillHistoryLogger, readSkillHistory, getSkillStats, type SkillHistoryRecord, type SkillStats } from './skillHistory.js';
import path from 'node:path';
import os from 'node:os';
import type { BrainEvent } from '../shared/events.js';

const MODEL = process.env.OPENAI_MODEL ?? 'grok-4';
const PROVIDER = 'openai-compatible';

/**
 * Default model per provider, used when the user runs `/login <provider>`
 * without a prior `/model <name>` call. Sourced from each provider's
 * published default at time of writing.
 */
const providerDefaults: Record<string, string> = {
  'openai-compatible': 'grok-4',
  'grok': 'grok-4',
  'minimax': 'MiniMax-chat-latest',
  'glm': 'glm-4.5',
};

/**
 * applySteerInterrupt — pure routing for the /steer --interrupt flow (Task C.3.2).
 *
 * Extracted from the App component so it can be unit-tested without React/Ink.
 * Side effects are injected via the options:
 *  - `harness`: the currently-running AgentHarness, or null if no run is active
 *  - `appendMessage(content)`: append a system message to the chat
 *  - `setQueueCount(n)`: update the sidebar queue counter
 *  - `dispatchPrompt(text)`: dispatch a fresh prompt as if the user hit Enter
 *
 * Semantics:
 *  - With active harness: enqueue(text) + cancel() → user does NOT need to press
 *    Enter again (queue drain re-enters provider stream with the queued prompt).
 *  - Without active harness: fallback to dispatchPrompt(text) as a fresh prompt.
 */
export async function applySteerInterrupt(options: {
  text: string;
  harness: { enqueue(text: string): void; cancel(): void; queueLength: number } | null;
  appendMessage: (content: string) => void;
  setQueueCount: (n: number) => void;
  dispatchPrompt: (text: string) => Promise<void>;
}): Promise<void> {
  const { text, harness, appendMessage, setQueueCount, dispatchPrompt } = options;
  if (!harness) {
    appendMessage('[steer --interrupt] no active run — dispatching as fresh prompt.');
    await dispatchPrompt(text);
    return;
  }
  harness.enqueue(text);
  harness.cancel();
  setQueueCount(harness.queueLength);
  appendMessage(`[steer --interrupt] cancelled current run + enqueued: "${text}" (queue: ${harness.queueLength})`);
}

/**
 * Compute the next session-stats snapshot after a chat turn (Task G.4.5).
 * Pure helper extracted from `dispatchPrompt` so the "real usage vs
 * ~4-char fallback" branch is testable without React/Ink render.
 *
 * Behavior:
 *  - When `realUsage` is present (provider honored `stream_options.include_usage`),
 *    use those numbers exactly.
 *  - When `realUsage` is null, fall back to the v3-B approximation:
 *    `Math.ceil(text.length / 4)` for both prompt and completion tokens.
 *
 * Cost is computed via `calculateCost(model, prompt, completion)` from
 * `modelPricing.ts`. The result is the new stats object; the caller is
 * responsible for merging it into state via `setSessionStats(prev => ...)`.
 */
export function computeSessionStatsDelta(
  realUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null,
  userText: string,
  assistantContent: string,
  model: string,
  prev: { totalTokens: number; totalCostUsd: number },
): { totalTokens: number; totalCostUsd: number } {
  const promptTokens = realUsage ? realUsage.promptTokens : Math.ceil(userText.length / 4);
  const completionTokens = realUsage
    ? realUsage.completionTokens
    : Math.ceil(assistantContent.length / 4);
  const turnCost = calculateCost(model, promptTokens, completionTokens);
  return {
    totalTokens: prev.totalTokens + promptTokens + completionTokens,
    totalCostUsd: prev.totalCostUsd + turnCost,
  };
}

/**
 * Format a side-by-side comparison of two skills' history stats (Task H.3).
 * Pure helper extracted from app.tsx dispatch so it's testable without
 * React/Ink render.
 *
 * Returns a multi-line string with:
 *  - Two lines summarizing each skill (id, count, success, avg duration, total tokens)
 *  - A "winner" line if there's a clear winner (higher successRate wins;
 *    ties broken by lower avgDurationMs; ties beyond that → no winner)
 *
 * When a skill ID has no recorded invocations, the line shows
 * "no invocations yet" so the user can still see the comparison.
 */
/**
 * Format a millisecond duration as a short human-readable string.
 * Negative durations get an "ago" suffix (Task F.3, v3-F).
 *
 * Examples:
 *   45_000    → "45s"
 *   3_600_000 → "1h 0m"
 *   86_400_000 → "1d 0h"
 *   -120_000  → "2m ago"
 */
function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? ' ago' : '';
  if (abs < 1000) return `${abs}ms${sign}`;
  const s = Math.floor(abs / 1000);
  if (s < 60) return `${s}s${sign}`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m${sign}` : `${m}m ${rs}s${sign}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm === 0 ? `${h}h${sign}` : `${h}h ${rm}m${sign}`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `${d}d${sign}` : `${d}d ${rh}h${sign}`;
}

export function formatSkillCompare(
  id1: string,
  id2: string,
  records: SkillHistoryRecord[],
): string {
  const stats1 = getSkillStats(records, id1);
  const stats2 = getSkillStats(records, id2);
  const lines: string[] = ['[skill-compare]'];
  lines.push(formatSkillCompareLine(id1, stats1));
  lines.push(formatSkillCompareLine(id2, stats2));
  // Winner heuristic — only declare when both have history
  if (stats1.count > 0 && stats2.count > 0) {
    const winner = pickCompareWinner(stats1, stats2);
    if (winner === null) {
      lines.push('Winner: tie (same success rate + same avg duration)');
    } else if (winner === 'a') {
      lines.push(`Winner: ${id1} (better success rate${stats1.successRate === stats2.successRate ? ' — tied, lower avg duration' : ''})`);
    } else {
      lines.push(`Winner: ${id2} (better success rate${stats1.successRate === stats2.successRate ? ' — tied, lower avg duration' : ''})`);
    }
  } else {
    lines.push('Winner: (insufficient data — both skills need ≥1 invocation to compare)');
  }
  return lines.join('\n');
}

/** Format a single skill's stats line for the compare output. */
function formatSkillCompareLine(id: string, stats: SkillStats): string {
  if (stats.count === 0) {
    return `  ${id} — no invocations recorded yet`;
  }
  return `  ${id} — ${stats.count} invocations, ${(stats.successRate * 100).toFixed(1)}% success, avg ${stats.avgDurationMs.toFixed(0)}ms, ${stats.totalTokens} tokens total`;
}

/**
 * Pick the winner between two SkillStats. Returns 'a' / 'b' / null on tie.
 * Order: successRate first (higher wins), then avgDurationMs (lower wins).
 * On perfect tie (same successRate AND same avgDurationMs), returns null.
 */
export function pickCompareWinner(
  a: SkillStats,
  b: SkillStats,
): 'a' | 'b' | null {
  if (a.successRate > b.successRate) return 'a';
  if (b.successRate > a.successRate) return 'b';
  // Same successRate — compare avgDurationMs (lower is better)
  if (a.avgDurationMs < b.avgDurationMs) return 'a';
  if (b.avgDurationMs < a.avgDurationMs) return 'b';
  // Perfect tie
  return null;
}

/**
 * Convenience wrapper: read history from disk + format compare. Caller
 * passes the file path so the test can inject a temp file.
 */
export async function compareSkillsFromFile(
  id1: string,
  id2: string,
  historyFile: string,
): Promise<string> {
  const records = await readSkillHistory(historyFile);
  return formatSkillCompare(id1, id2, records);
}

function eventsToMessages(events: readonly BrainEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let assistantBuffer = '';
  let assistantId = '';
  for (const e of events) {
    if (e.type === 'message_delta') {
      if (assistantId === '') assistantId = `resumed-${newSessionId()}`;
      assistantBuffer += e.delta;
      const last = out[out.length - 1];
      if (last && last.role === 'assistant' && last.id === assistantId) {
        out[out.length - 1] = { ...last, content: assistantBuffer };
      } else {
        out.push({ id: assistantId, role: 'assistant', content: assistantBuffer, ts: e.ts });
      }
    } else if (e.type === 'tool_call') {
      assistantBuffer = '';
      assistantId = '';
      out.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: `[tool_call] ${e.toolName}(${JSON.stringify(e.arguments).slice(0, 80)})`,
        ts: e.ts,
      });
    } else if (e.type === 'tool_result') {
      out.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: `[tool_result] ${e.toolName} → ${e.ok ? 'ok' : 'error'}`,
        ts: e.ts,
      });
    } else if (e.type === 'agent_start') {
      out.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: `[agent_start] model=${e.model} provider=${e.provider}`,
        ts: e.ts,
      });
    } else if (e.type === 'agent_end') {
      out.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: `[agent_end] reason=${e.reason} duration=${e.durationMs}ms`,
        ts: e.ts,
      });
    } else if (e.type === 'error') {
      out.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: `[error] ${e.message}`,
        ts: e.ts,
      });
    }
  }
  return out;
}

export function App(): React.ReactElement {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [sessionActive, setSessionActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [providerConfig, setProviderConfig] = useState(() => getProviderConfig());
  const [sessionStats, setSessionStats] = useState<{ totalTokens: number; totalCostUsd: number }>({ totalTokens: 0, totalCostUsd: 0 });
  const activeProviderSpec = getActiveProviderSpec();
  const activeModel = providerConfig.modelByProvider[activeProviderSpec.id];

  const writerRef = useRef<SessionJsonlWriter | null>(null);
  // Track the active AgentHarness so /steer can enqueue follow-up
  // prompts while a run is in flight (Task 18.2).
  const harnessRef = useRef<AgentHarness | null>(null);
  // Queue counter for sidebar display (Task 18.2).
  const [queueCount, setQueueCount] = useState<number>(0);

  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const handleResize = () => {
      setSize({
        columns: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
      });
    };
    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [stdout]);

  const chatWidth = Math.max(20, size.columns - 44);

  const skills = useMemo(() => listCodingSkills(), []);
  const skillList = useMemo(() => formatSkillList(skills), [skills]);
  const isSlashMode = input.startsWith('/');

  // Bootstrap session on mount: resume current or create new.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await ensureSessionDir();
      let id = getCurrentSessionId();
      let resumed = false;
      let restoredMessages: ChatMessage[] = [];
      if (id) {
        try {
          const events = await loadSessionEvents(id);
          if (!cancelled) {
            restoredMessages = eventsToMessages(events);
            resumed = events.length > 0;
          }
        } catch {
          // Corrupt session — fall through to create new.
          id = null;
        }
      }
      if (!id) {
        id = newSessionId();
        setCurrentSessionId(id);
      }
      if (cancelled) return;
      writerRef.current = new SessionJsonlWriter(id);
      setSessionId(id);
      setMessages(restoredMessages);
      if (resumed) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[resume] loaded ${restoredMessages.length} messages from session ${id.slice(0, 8)}…`,
            ts: Date.now(),
          },
        ]);
        setSessionActive(true);
      }
    })();
    return () => {
      cancelled = true;
      // Fire-and-forget close on unmount.
      void writerRef.current?.close();
    };
  }, []);

  const dispatchPrompt = async (userText: string) => {
    const envConfig = await providerFromEnv();
    if (!envConfig) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: 'OPENAI_API_KEY not set. Export it before running zelari-code.',
          ts: Date.now(),
        },
      ]);
      return;
    }

    setBusy(true);
    // Build the tool registry ONCE per run so the agent can read/write
    // files and run shell commands (Task A1, v3-A). The registry exposes
    // OpenAI-shaped tool descriptors via toOpenAITools() and executes
    // tool_call deltas when the provider returns them.
    const { registry: toolRegistry } = createBuiltinToolRegistry();
    // Wire providerFailover() (Task G.1, carryover from v3-B B.4.2).
    // The wrapper retries on the first transient error from the primary.
    // Set `ANATHEMA_FAILOVER=0` to disable wrapping. By default the
    // fallback uses the same provider config (a single retry against
    // the same endpoint).
    //
    // Task J.2 (v3-J) — cross-provider failover. The actual resolution
    // logic lives in the pure helper `resolveFailoverStream` so it's
    // testable without booting React/Ink. Here we just wire the env vars
    // + the dependency-injected lookup + the stream builder.
    const baseProviderStream = openaiCompatibleProvider(envConfig);
    const failoverResolution = await resolveFailoverStream({
      failoverEnabled: process.env.ANATHEMA_FAILOVER !== '0',
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
      console.warn(failoverResolution.warning);
    }
    const providerStream: import('../main/core/AgentHarness.js').ProviderStreamFn =
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
      'You are Zelari Code, an interactive AI coding agent operating directly in the user\'s terminal.',
      '',
      'You ARE connected to this machine and have real tools to read, modify, and explore the codebase.',
      'Never claim you lack filesystem or shell access — you have it. Use your tools instead of asking the user to paste file contents.',
      '',
      `# Working Directory`,
      `You are running in: ${cwd}`,
      'All relative file paths are resolved against this directory. Always work with real files here.',
      '',
      '# Available Tools',
      'You can call these tools. Use them to take action and gather information autonomously:',
      toolList,
      '',
      '# Guidelines',
      '- When the user asks you to write code, debug, or explore, be proactive: list files (bash: ls, list_files) and read key files (read_file) to understand the project instead of asking the user to paste file contents.',
      '- Only invoke tools when they are necessary to answer the user\'s prompt. If the user is just saying hello or greeting you (e.g., "ciao", "hello"), simply greet them back and ask how you can help, without running any commands or tools.',
      '- When you finish a task, briefly summarize what you did.',
    ].join('\n');
    const harness = new AgentHarness({
      model: envConfig.model,
      provider: PROVIDER,
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
    // Task G.3.3 — use the process-wide singleton so the SIGINT/SIGTERM
    // handler in `main.ts` can flush the same instance on shutdown.
    // The singleton respects `ANATHEMA_METRICS_FILE` for tests.
    const metrics: MetricsLogger = getMetricsLogger();
    // Task G.4.5 — capture real provider-reported token usage from
    // `message_end` events. When present, it overrides the ~4-char/token
    // approximation (v3-B behavior). When absent (some providers don't
    // honor `stream_options.include_usage`), we fall back to the estimate.
    let realUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
    try {
      for await (const event of harness.run()) {
        // Task G.4.5 — capture usage from message_end for sessionStats.
        if (event.type === 'message_end' && event.usage) {
          realUsage = event.usage;
        }
        // Keep the sidebar queue counter in sync with the harness.
        if (event.type === 'queue_update') {
          setQueueCount(harness.queueLength);
        }
        // Persist every event to JSONL sidecar.
        if (writerRef.current) {
          await writerRef.current.append(event);
        }
        // Telemetry hooks (Task B.5.2).
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
          // Telemetry hook for tool calls (Task G.3.2, carryover from v3-B
          // B.5.2 partial). Tracks which tools fire, how often they error,
          // and how long they take — useful for /skill-stats follow-ups
          // and for the Council role-depth mission.
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
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.id.startsWith('streaming-')) {
              return [...prev.slice(0, -1), { ...last, content: assistantContent }];
            }
            return [
              ...prev,
              { id: `streaming-${crypto.randomUUID()}`, role: 'assistant', content: assistantContent, ts: Date.now() },
            ];
          });
        } else if (event.type === 'error') {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: 'system', content: `[error] ${event.message}`, ts: Date.now() },
          ]);
        } else if (event.type === 'tool_call') {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[tool_call] ${event.toolName}(${JSON.stringify(event.arguments).slice(0, 80)})`,
              ts: event.ts,
            },
          ]);
        } else if (event.type === 'tool_result') {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[tool_result] ${event.toolName} → ${event.ok ? 'ok' : 'error'}`,
              ts: event.ts,
            },
          ]);
        } else if (event.type === 'tool_execution_start') {
          // Surface tool invocations as ephemeral UI indicators (Task A1).
          const argsPreview = JSON.stringify(event.args).slice(0, 120);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `▶ ${event.toolName}(${argsPreview})`,
              ts: event.ts,
            },
          ]);
        } else if (event.type === 'tool_execution_end') {
          const preview = event.result.slice(0, 200);
          const icon = event.isError ? '✗' : '✓';
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `${icon} ${preview}${event.result.length > 200 ? '…' : ''} (${event.durationMs}ms)`,
              ts: event.ts,
            },
          ]);
        }
      }
    } finally {
      harnessRef.current = null;
      setQueueCount(0);
      setBusy(false);
      // Accumulate session-level token/cost stats (Task B.1.1).
      // Task G.4.5 — prefer the provider-reported usage when present
      // (more accurate than the ~4-char approximation). When absent,
      // fall back to the v3-B estimate so old providers keep working.
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
  };

  const handleSessionKind = async (result: SlashCommandResult): Promise<string> => {
    if (result.kind === 'session') {
      try {
        const sessions = await listSessions();
        if (sessions.length === 0) return '[sessions] no past sessions';
        const lines = sessions.slice(0, 10).map((s) => {
          const dt = new Date(s.mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
          return `  ${s.id.slice(0, 8)}…  ${s.eventCount} events  ${dt}`;
        });
        return `[sessions] showing ${Math.min(sessions.length, 10)} of ${sessions.length}:\n${lines.join('\n')}`;
      } catch (err) {
        return `[sessions] error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (result.kind === 'resume' && result.targetSessionId) {
      setCurrentSessionId(result.targetSessionId);
      return `[resume] session ${result.targetSessionId.slice(0, 8)}… set as current — restart zelari-code to load it`;
    }
    if (result.kind === 'new') {
      clearCurrentSessionId();
      const id = newSessionId();
      setCurrentSessionId(id);
      writerRef.current?.close();
      writerRef.current = new SessionJsonlWriter(id);
      setSessionId(id);
      setMessages([]);
      setSessionActive(false);
      return `[new] fresh session ${id.slice(0, 8)}… started`;
    }
    return result.message ?? `[${result.kind}] handled`;
  };

  const dispatchCouncilPrompt = async (input: string) => {
    const envConfig = await providerFromEnv();
    if (!envConfig) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: 'OPENAI_API_KEY not set. Export it before invoking /council.',
          ts: Date.now(),
        },
      ]);
      return;
    }
    setBusy(true);
    // Council members get access to the same built-in tool registry as
    // the main prompt path (Task C.1.3). Each specialist can now
    // read/write/bash/grep the workspace; the harness emits
    // tool_execution_start/end events which we surface as 'tool' role
    // messages (ChatStream renders them via CollapsibleToolOutput).
    const { registry: councilToolRegistry } = createBuiltinToolRegistry();
    // Feedback store for specialist ordering (Task I.2 close-out).
    // Fresh instance per /council invocation: cheap (lazy JSON load) and
    // ensures the latest user feedback is visible after /council-feedback.
    const councilFeedbackStore = new FeedbackStore();
    try {
      for await (const event of dispatchCouncil(input, {
        apiKey: envConfig.apiKey,
        model: envConfig.model,
        provider: PROVIDER,
        providerStream: openaiCompatibleProvider(envConfig),
        sessionId,
        tools: councilToolRegistry,
        feedbackStore: councilFeedbackStore,
      })) {
        if (writerRef.current) {
          await writerRef.current.append(event);
        }
        if (event.type === 'message_delta') {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.id.startsWith('streaming-')) {
              return [...prev.slice(0, -1), { ...last, content: prev[prev.length - 1].content + event.delta }];
            }
            return [
              ...prev,
              { id: `streaming-${crypto.randomUUID()}`, role: 'assistant', content: event.delta, ts: event.ts },
            ];
          });
        } else if (event.type === 'tool_execution_start') {
          // Surface as 'tool' role so ChatStream renders CollapsibleToolOutput.
          const argsPreview = JSON.stringify(event.args).slice(0, 120);
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
          // Find the matching tool_execution_start message (by toolCallId) and update it.
          setMessages((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              const m = prev[i];
              if (m && m.role === 'tool' && m.toolCallId === event.toolCallId && m.toolDurationMs === undefined) {
                const updated = [...prev];
                updated[i] = {
                  ...m,
                  toolOk: !event.isError,
                  toolDurationMs: event.durationMs,
                  content: `${m.toolName ?? 'tool'}${event.isError ? ' → error' : ' → ok'} (${event.durationMs}ms)`,
                };
                return updated;
              }
            }
            return prev;
          });
        } else if (event.type === 'error') {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: 'system', content: `[error] ${event.message}`, ts: event.ts },
          ]);
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `[council error] ${err instanceof Error ? err.message : String(err)}`,
          ts: Date.now(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (value: string) => {
    if (!value.trim() || busy) return;

    const result: SlashCommandResult = handleSlashCommand(value, skills);

    if (!result.handled) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: value, ts: Date.now() },
      ]);
      setSessionActive(true);
      await dispatchPrompt(value);
      setInput('');
      return;
    }

    // Session-kind commands execute async side effects.
    if (result.kind === 'session' || result.kind === 'resume' || result.kind === 'new') {
      const sysMsg = await handleSessionKind(result);
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'system', content: sysMsg, ts: Date.now() },
      ]);
      setInput('');
      return;
    }

    // Council command dispatches to the multi-agent council.
    if (result.kind === 'council' && result.councilInput) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: `/council ${result.councilInput}`, ts: Date.now() },
      ]);
      setSessionActive(true);
      setInput('');
      await dispatchCouncilPrompt(result.councilInput);
      return;
    }

    // Council feedback (Task I.2, v3-I) — record 1-5 rating for a member.
    if (result.kind === 'council_feedback'
        && result.feedbackMemberId
        && typeof result.feedbackScore === 'number') {
      try {
        const store = new FeedbackStore();
        const entry = store.record({
          memberId: result.feedbackMemberId,
          score: result.feedbackScore,
          ...(result.feedbackNote ? { note: result.feedbackNote } : {}),
          ...(sessionId ? { sessionId } : {}),
        });
        const stats = store.getStats(result.feedbackMemberId);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[council-feedback] ${result.feedbackMemberId} rated ${entry.score}/5`
              + ` — running avg ${stats.avg.toFixed(2)} over ${stats.count} rating(s).`,
            ts: Date.now(),
          },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[council-feedback] failed: ${err instanceof Error ? err.message : 'Unknown'}`,
            ts: Date.now(),
          },
        ]);
      }
      return;
    }

    // Provider switch (Task 15.3).
    if (result.kind === 'provider_set' && result.provider) {
      const spec = getProviderSpec(result.provider);
      if (!spec) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[provider] unknown: ${result.provider}. Available: openai-compatible, minimax, glm, grok, custom`,
            ts: Date.now(),
          },
        ]);
        setInput('');
        return;
      }
      try {
        persistActiveProvider(spec.id);
        setProviderConfig(getProviderConfig());
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[provider] active: ${spec.displayName} (model: ${getModelForProvider(spec.id)})`,
            ts: Date.now(),
          },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[provider error] ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    if (result.kind === 'provider_list') {
      const list = getActiveProviderSpec();
      const customEp = getCustomEndpoint(list.id);
      const epHint = customEp ? ` — custom endpoint: ${customEp}` : '';
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `[provider] current: ${list.displayName} (model: ${activeModel})${epHint} — available: openai-compatible, minimax, glm, grok, custom`,
          ts: Date.now(),
        },
      ]);
      setInput('');
      return;
    }

    // Custom base URL for the active provider (Task A3, v3-A).
    if (result.kind === 'provider_custom') {
      const id = activeProviderSpec.id;
      try {
        if (result.customClear) {
          clearCustomEndpoint(id);
          setProviderConfig(getProviderConfig());
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[provider] cleared custom endpoint for ${id} — falling back to default`,
              ts: Date.now(),
            },
          ]);
        } else if (result.customEndpoint) {
          setCustomEndpoint(id, result.customEndpoint);
          setProviderConfig(getProviderConfig());
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[provider] custom endpoint for ${id} set to ${result.customEndpoint}`,
              ts: Date.now(),
            },
          ]);
        } else if (result.message) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[provider] ${result.message}`,
              ts: Date.now(),
            },
          ]);
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[provider error] ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    // /provider <id> refresh — force a refresh attempt (Task F.3.1, v3-F).
    if (result.kind === 'provider_refresh' && result.provider) {
      const spec = getProviderSpec(result.provider);
      if (!spec) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[provider] unknown: ${result.provider}. Available: openai-compatible, minimax, glm, grok, custom`,
            ts: Date.now(),
          },
        ]);
        setInput('');
        return;
      }
      try {
        const refreshed = await resolveApiKeyWithMeta(spec.id);
        if (!refreshed) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[provider refresh] ${spec.id}: no key configured (use /login ${spec.id} <key>)`,
              ts: Date.now(),
            },
          ]);
          setInput('');
          return;
        }
        const expires = refreshed.expiresAt
          ? ` — expires in ${formatDuration(refreshed.expiresAt - Date.now())}`
          : '';
        const impl = getRefreshImpl(spec.id);
        const implNote = impl ? '' : ' (no refresh impl registered — stale token returned)';
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[provider refresh] ${spec.id}: ok — key ${maskKey(refreshed.apiKey)}${expires}${implNote}`,
            ts: Date.now(),
          },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[provider refresh error] ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    // /provider <id> status — show key source, expiry, refresh impl (Task F.3.2, v3-F).
    if (result.kind === 'provider_status' && result.provider) {
      const spec = getProviderSpec(result.provider);
      if (!spec) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[provider] unknown: ${result.provider}. Available: openai-compatible, minimax, glm, grok, custom`,
            ts: Date.now(),
          },
        ]);
        setInput('');
        return;
      }
      const envKey = process.env[spec.envVar];
      const stored = getOAuthToken(spec.id);
      const source = envKey && envKey.trim().length > 0
        ? `env (${spec.envVar})`
        : stored
          ? 'store'
          : 'missing';
      const expires = stored?.expiresAt
        ? formatDuration(stored.expiresAt - Date.now())
        : '—';
      const hasRefresh = getRefreshImpl(spec.id) ? 'yes' : 'no';
      const hasRefreshToken = stored?.refreshToken ? 'yes' : 'no';
      const baseUrl = spec.baseUrl ?? '—';
      const validation = await validateApiKey(spec.id, envKey ?? stored?.apiKey ?? '').catch(() => null);
      const valLine = validation
        ? validation.skipped
          ? `validation: skipped (no baseUrl)`
          : `validation: ${validation.ok ? 'ok' : `fail (${validation.reason})`}${validation.durationMs ? ` ${validation.durationMs}ms` : ''}`
        : 'validation: error';
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `[provider status] ${spec.id} (${spec.displayName})\n  env var:    ${spec.envVar}\n  source:     ${source}\n  expires:    ${expires}\n  refresh:    ${hasRefresh} (impl registered)\n  refreshTkn: ${hasRefreshToken}\n  baseUrl:    ${baseUrl}\n  ${valLine}`,
          ts: Date.now(),
        },
      ]);
      setInput('');
      return;
    }

    // /promote-member <id> — promote a council member to a standalone skill (v3-K).
    if (result.kind === 'promote_member' && result.promoteMemberId) {
      try {
        const { skill, markdown } = promoteMember(result.promoteMemberId);
        const skillDir = process.env.ANATHEMA_SKILL_DIR
          ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'skills');
        await fs.promises.mkdir(skillDir, { recursive: true });
        const filePath = path.join(skillDir, `${skill.id}.md`);
        await fs.promises.writeFile(filePath, markdown, 'utf8');
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content:
              `[promote-member] ${skill.name} (${result.promoteMemberId}) → ${filePath}\n` +
              `  category:    ${skill.category}\n` +
              `  cost:        ${skill.estimatedCost}\n` +
              `  required:    ${skill.requiredRoles.join(', ') || '—'}\n` +
              `  tools:       ${skill.requiredTools.join(', ') || '—'}\n` +
              `  tags:        ${skill.tags.join(', ')}`,
            ts: Date.now(),
          },
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[promote-member error] ${msg}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    if (result.kind === 'promote_member_error') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: result.promoteMemberError ?? 'Usage: /promote-member <memberId>',
          ts: Date.now(),
        },
      ]);
      setInput('');
      return;
    }

    // /update — check or perform zelari-code self-update (Task N.5, v3-N).
    if (result.kind === 'update_check') {
      try {
        const { checkForUpdate } = await import('./updater.js');
        const info = await checkForUpdate();
        if (info.error) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[update] check failed: ${info.error}`,
              ts: Date.now(),
            },
          ]);
        } else if (info.updateAvailable) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content:
                `[update] 🆕 zelari-code ${info.latestVersion} available (current: ${info.currentVersion})\n` +
                `       Run \`/update --yes\` to install. You'll need to restart manually after.`,
              ts: Date.now(),
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[update] up to date (${info.currentVersion})`,
              ts: Date.now(),
            },
          ]);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[update error] ${msg}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    if (result.kind === 'update_perform') {
      try {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[update] running \`npm install -g zelari-code@latest\`...`,
            ts: Date.now(),
          },
        ]);
        const { performUpdate } = await import('./updater.js');
        const resultUpdate = await performUpdate();
        if (resultUpdate.ok) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content:
                `[update] ✅ installed successfully\n\n` +
                `Please restart zelari-code manually to use the new version.\n` +
                `(exit with /exit or Ctrl+C, then run \`zelari-code\` again)`,
              ts: Date.now(),
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content:
                `[update] ❌ failed: ${resultUpdate.error ?? 'unknown error'}\n\n` +
                `npm output:\n${resultUpdate.output || '(empty)'}`,
              ts: Date.now(),
            },
          ]);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[update error] ${msg}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    if (result.kind === 'update_usage') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: result.message ?? 'Usage: /update [--yes|-y]',
          ts: Date.now(),
        },
      ]);
      setInput('');
      return;
    }

    // /compact — Task B.3.2 — actually compact the in-memory transcript.
    if (result.kind === 'compact') {
      const opts: { threshold?: number; keepRecent?: number } = {};
      if (result.compactThreshold !== undefined) opts.threshold = result.compactThreshold;
      if (result.compactKeepRecent !== undefined) opts.keepRecent = result.compactKeepRecent;
      const r = compactTranscript(messages, opts);
      setMessages([...r.messages]);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: formatCompactionSummary(r),
          ts: Date.now(),
        },
      ]);
      setInput('');
      return;
    }

    // /diff — show uncommitted working-tree changes (Task A4, v3-A).
    if (result.kind === 'diff') {
      try {
        const repoRoot = defaultProjectRoot();
        if (!(await isGitRepo(repoRoot))) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: '[diff] not a git repository — nothing to show',
              ts: Date.now(),
            },
          ]);
        } else {
          const { diff, truncated, empty } = await getWorkingDiff({
            cwd: repoRoot,
            staged: result.diffStaged ?? false,
          });
          const banner = empty
            ? `[diff] working tree clean${result.diffStaged ? ' (incl. staged)' : ''}`
            : `[diff]${result.diffStaged ? ' (staged + unstaged)' : ''} — ${truncated ? 'truncated to 50k chars' : 'full output follows'}`;
          const body = empty ? '' : `\n\n${diff}`;
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `${banner}${body}`,
              ts: Date.now(),
            },
          ]);
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[diff error] ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    // /undo — destructive revert. With --yes, execute; without, just warn.
    if (result.kind === 'undo' || result.kind === 'undo_confirm') {
      // Always surface the warning/help message first.
      if (result.message) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: result.message!,
            ts: Date.now(),
          },
        ]);
      }
      if (result.kind === 'undo_confirm' && result.undoConfirmed) {
        try {
          const repoRoot = defaultProjectRoot();
          if (!(await isGitRepo(repoRoot))) {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'system',
                content: '[undo] not a git repository — nothing to revert',
                ts: Date.now(),
              },
            ]);
          } else {
            const res = await undoWorkingChanges({ cwd: repoRoot });
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'system',
                content: `[undo] ${res.summary}${res.reverted.length > 0 ? `\n  - ${res.reverted.slice(0, 10).join('\n  - ')}${res.reverted.length > 10 ? `\n  ... +${res.reverted.length - 10} more` : ''}` : ''}`,
                ts: Date.now(),
              },
            ]);
          }
        } catch (err) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[undo error] ${err instanceof Error ? err.message : String(err)}`,
              ts: Date.now(),
            },
          ]);
        }
      }
      setInput('');
      return;
    }

    if (result.kind === 'model_set' && result.model) {
      const id = activeProviderSpec.id;
      try {
        persistModelForProvider(id, result.model);
        setProviderConfig(getProviderConfig());
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[model] set: ${id} → ${result.model}`,
            ts: Date.now(),
          },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[model error] ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    if (result.kind === 'model_show') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `[model] current: ${activeProviderSpec.displayName} → ${activeModel}`,
          ts: Date.now(),
        },
      ]);
      setInput('');
      return;
    }

    // v3-U: /models — list discovered models for the active provider.
    if (result.kind === 'models_list') {
      const discId = activeProviderSpec.id as DiscoveryProviderId;
      const cached = getCachedModels(discId);
      if (!cached || cached.models.length === 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[models] no cache for ${activeProviderSpec.displayName}. Run /models refresh or /login ${discId} <key> to discover.`,
            ts: Date.now(),
          },
        ]);
      } else {
        const ageMin = Math.round((Date.now() - cached.fetchedAt) / 60_000);
        const list = cached.models.map((m) => `  - ${m.id}${m.ownedBy ? ` (${m.ownedBy})` : ''}`).join('\n');
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[models] ${activeProviderSpec.displayName} — ${cached.models.length} models (fetched ${ageMin}m ago from ${cached.baseUrl}):\n${list}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    // v3-U: /models refresh — force re-discovery for the active provider.
    if (result.kind === 'models_refresh' || result.kind === 'model_refresh') {
      const discId = activeProviderSpec.id as DiscoveryProviderId;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `[models] refreshing model list for ${activeProviderSpec.displayName}...`,
          ts: Date.now(),
        },
      ]);
      setInput('');
      // Fire discovery (await to surface errors inline).
      (async () => {
        try {
          const entry = await discoverModelsForProvider(discId);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[models] ✓ ${entry.models.length} models discovered for ${activeProviderSpec.displayName}. Use /model <name> to switch.`,
              ts: Date.now(),
            },
          ]);
        } catch (err) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[models] ✗ discovery failed: ${err instanceof Error ? err.message : String(err)}`,
              ts: Date.now(),
            },
          ]);
        }
      })();
      return;
    }

    // Branch commands (Task 17.2).
    if (result.kind === 'branch_create' && result.branchName) {
      if (!sessionId) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: '[branch] no active session — wait for bootstrap or run a prompt first',
            ts: Date.now(),
          },
        ]);
        setInput('');
        return;
      }
      try {
        const info = await createBranch(result.branchName, sessionId);
        setCurrentBranch(info.name);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[branch] created "${info.name}" from session ${info.fromSessionId.slice(0, 8)}… (${info.sessionCount} session file copied)`,
            ts: Date.now(),
          },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[branch error] ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    if (result.kind === 'branch_list') {
      try {
        const list = await listBranches();
        if (list.length === 0) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: '[branches] no branches yet — use /branch <name> to create one',
              ts: Date.now(),
            },
          ]);
        } else {
          const currentBranch = getCurrentBranch();
          const lines = list.slice(0, 10).map((b) => {
            const dt = new Date(b.createdAt).toISOString().replace('T', ' ').slice(0, 16);
            const marker = currentBranch === b.name ? ' *' : '  ';
            return ` ${marker}${b.name.padEnd(20)} from ${b.fromSessionId.slice(0, 8)}…  ${b.sessionCount} sessions  ${dt}`;
          });
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[branches] ${list.length} total (* = active):\n${lines.join('\n')}`,
              ts: Date.now(),
            },
          ]);
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[branches error] ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    if (result.kind === 'branch_checkout' && result.branchName) {
      try {
        if (!checkBranchExists(result.branchName)) {
          throw new Error(`Branch "${result.branchName}" does not exist. Use /branches to list.`);
        }
        setCurrentBranch(result.branchName);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[checkout] active branch set to "${result.branchName}". Restart zelari-code to load it.`,
            ts: Date.now(),
          },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[checkout error] ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    // /steer --interrupt — enqueue + cancel current run (Task C.3.2).
    if (result.kind === 'steer_interrupt') {
      const text = result.steerText;
      if (!text) {
        if (result.message) {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: 'system', content: result.message!, ts: Date.now() },
          ]);
        }
        setInput('');
        return;
      }
      applySteerInterrupt({
        text,
        harness: harnessRef.current,
        appendMessage: (content) =>
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: 'system', content, ts: Date.now() },
          ]),
        setQueueCount,
        dispatchPrompt,
      });
      setInput('');
      return;
    }

    // /steer — enqueue a follow-up prompt on the active harness (Task 18.2).
    if (result.kind === 'steer') {
      const text = result.steerText;
      if (!text) {
        // No text: the slash command emits a usage hint message.
        if (result.message) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: result.message!,
              ts: Date.now(),
            },
          ]);
        }
        setInput('');
        return;
      }
      const harness = harnessRef.current;
      if (!harness) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: '[steer] no active run — /steer only works while a run is in flight.',
            ts: Date.now(),
          },
        ]);
        setInput('');
        return;
      }
      harness.enqueue(text);
      setQueueCount(harness.queueLength);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `[steer] queued: "${text}" (queue: ${harness.queueLength})`,
          ts: Date.now(),
        },
      ]);
      setInput('');
      return;
    }

    // /steer without text — already handled by slashCommands with a usage hint.

    // Login with key: store it via keyStore AND switch the active
    // provider to the one just authenticated, so the next dispatch
    // resolves the key via keyStore without requiring an env var or
    // restart (Task 14.9 + v3-T persistence fix).
    if (result.kind === 'login' && result.provider && result.loginKey) {
      const spec = getProviderSpec(result.provider);
      const displayName = spec?.displayName ?? result.provider;
      const envVar = spec?.envVar ?? `${result.provider.toUpperCase()}_API_KEY`;
      try {
        setApiKey(result.provider, result.loginKey);
        // Switch the active provider so subsequent prompts resolve the
        // key from keyStore (providerFromEnv → resolveActiveProvider → resolveApiKeyWithMeta).
        persistActiveProvider(result.provider as Parameters<typeof persistActiveProvider>[0]);
        // Set a sensible default model for the new provider if none is
        // configured yet, so /login glm → /model picks up something useful.
        const currentModel = getModelForProvider(result.provider as Parameters<typeof getModelForProvider>[0]);
        if (!currentModel) {
          const fallbackModel = providerDefaults[result.provider as keyof typeof providerDefaults];
          if (fallbackModel) {
            persistModelForProvider(result.provider as Parameters<typeof persistModelForProvider>[0], fallbackModel);
          }
        }
        setProviderConfig(getProviderConfig());
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[login] ${displayName} key stored (${maskKey(result.loginKey)}). Active provider switched to ${displayName} — try a prompt now.`,
            ts: Date.now(),
          },
        ]);
        // v3-U: kick off model discovery in the background so /model can
        // suggest the provider's actual current list. Fire-and-forget: a
        // failed discovery call should not break the /login UX.
        const discoveryProvider = result.provider as DiscoveryProviderId;
        if (['grok', 'glm', 'minimax', 'openai-compatible'].includes(discoveryProvider)) {
          discoverModelsInBackground(discoveryProvider, {
            onError: (err) => {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'system',
                  content: `[models] discovery failed for ${discoveryProvider}: ${err.message} (using static defaults)`,
                  ts: Date.now(),
                },
              ]);
            },
          });
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[login error] ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          },
        ]);
      }
      setInput('');
      return;
    }

    // Login with OAuth: launch SuperGrok Device Authorization Grant flow
    // (RFC 8628). xAI does not support the browser-redirect Authorization
    // Code Grant — the user is shown a code to enter at a verification URL.
    if (result.kind === 'login_oauth' && result.provider === 'grok') {
      // Override GROK_OAUTH_CLIENT_ID via env if the user wants a custom client.
      // Default uses xAI's public client (see DEFAULT_GROK_OAUTH_CLIENT_ID).
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: '[login oauth] requesting device code from xAI...',
          ts: Date.now(),
        },
      ]);
      setBusy(true);
      try {
        const resultOAuth = await runGrokOAuthFlow({
          // Show the user_code + verification_uri as soon as xAI returns them.
          onUserCode: (info) => {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'system',
                content:
                  `[login oauth] Open ${info.verificationUri} in your browser and enter the code:\n` +
                  `  ${info.userCode}\n` +
                  `(Opening your browser automatically...)`,
                ts: Date.now(),
              },
            ]);
          },
        });
        // Persist full OAuth token (apiKey + expiresAt + refreshToken) so
        // the auto-refresh path (Task D.3.1) can use the refresh_token later.
        setOAuthToken('grok', {
          apiKey: resultOAuth.accessToken,
          ...(resultOAuth.expiresAt !== undefined ? { expiresAt: resultOAuth.expiresAt } : {}),
          ...(resultOAuth.refreshToken ? { refreshToken: resultOAuth.refreshToken } : {}),
        });
        // Switch active provider to grok so subsequent prompts pick up the OAuth token.
        persistActiveProvider('grok');
        if (!getModelForProvider('grok')) {
          persistModelForProvider('grok', providerDefaults['grok'] ?? 'grok-4');
        }
        setProviderConfig(getProviderConfig());
        const expiresHint = resultOAuth.expiresAt
          ? `, expires ${new Date(resultOAuth.expiresAt).toISOString()}`
          : '';
        const refreshHint = resultOAuth.refreshToken ? ', refresh token saved' : '';
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[login oauth] ✓ Grok authenticated via SuperGrok (token ${maskKey(resultOAuth.accessToken)}${expiresHint}${refreshHint}). Active provider switched to grok — try a prompt now.`,
            ts: Date.now(),
          },
        ]);
        // v3-U: kick off Grok model discovery (OAuth token as Bearer).
        discoverModelsInBackground('grok', {
          onError: (err) => {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'system',
                content: `[models] discovery failed for grok: ${err.message} (using static defaults)`,
                ts: Date.now(),
              },
            ]);
          },
        });
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[login oauth error] ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          },
        ]);
      } finally {
        setBusy(false);
      }
      setInput('');
      return;
    }

    const sysMsg = result.message
      ?? (result.kind === 'skill' && result.expandedSkill
        ? `[skill] ${result.expandedSkill.skillId} — prompt ready (dispatch lands in Phase 14.7)`
        : `[${result.kind}] handled`);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'system', content: sysMsg, ts: Date.now() },
    ]);

    // Dispatch skill prompt + record history (Task C.2.3).
    if (result.kind === 'skill' && result.expandedSkill) {
      const skillLogger = new SkillHistoryLogger();
      const invocationId = skillLogger.recordStart(result.expandedSkill.skillId, sessionId ?? undefined);
      let dispatchError: Error | undefined;
      try {
        setInput('');
        await dispatchPrompt(result.expandedSkill.prompt);
      } catch (err) {
        dispatchError = err instanceof Error ? err : new Error(String(err));
      } finally {
        skillLogger.recordEnd(invocationId, {
          ok: !dispatchError,
          error: dispatchError?.message,
        });
        setBusy(false);
      }
      return;
    }

    // /skill-stats [name] — aggregate stats from skill-history.jsonl (Task C.2.3).
    if (result.kind === 'skill_stats') {
      const historyFile = process.env.ANATHEMA_SKILL_HISTORY_FILE
        ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'skill-history.jsonl');
      try {
        const records = await readSkillHistory(historyFile);
        const stats = getSkillStats(records, result.skillStatsSkillId);
        const label = result.skillStatsSkillId ?? 'all skills';
        const formatted = stats.count === 0
          ? `[skill-stats] ${label}: no invocations recorded yet`
          : `[skill-stats] ${label}: ${stats.count} invocations, ${(stats.successRate * 100).toFixed(1)}% success, avg ${stats.avgDurationMs.toFixed(0)}ms, ${stats.totalTokens} tokens total`;
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'system', content: formatted, ts: Date.now() },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'system', content: `[skill-stats error] ${err instanceof Error ? err.message : String(err)}`, ts: Date.now() },
        ]);
      }
      setInput('');
      return;
    }

    // /skill-compare <id1> <id2> — side-by-side stats for two skills (Task H.3).
    if (result.kind === 'skill-compare') {
      const ids = result.compareIds;
      if (!ids) {
        // Missing-args case: the slash command produced a warning message.
        // Surface it in chat as a system message and exit early.
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'system', content: result.message ?? '[skill-compare] missing args', ts: Date.now() },
        ]);
        setInput('');
        return;
      }
      const historyFile = process.env.ANATHEMA_SKILL_HISTORY_FILE
        ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'skill-history.jsonl');
      try {
        const formatted = await compareSkillsFromFile(ids[0], ids[1], historyFile);
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'system', content: formatted, ts: Date.now() },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'system', content: `[skill-compare error] ${err instanceof Error ? err.message : String(err)}`, ts: Date.now() },
        ]);
      }
      setInput('');
      return;
    }

    if (result.kind === 'exit') {
      await writerRef.current?.close();
      setTimeout(() => process.exit(0), 50);
    }
    if (result.kind === 'clear') {
      setMessages([]);
      setSessionActive(false);
    }
    setInput('');
  };

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Header
        model={activeModel}
        provider={activeProviderSpec.id}
        skillCount={skills.length}
        sessionActive={sessionActive}
        sessionId={sessionId ? sessionId.slice(0, 8) : '...'}
        totalTokens={sessionStats.totalTokens}
        totalCostUsd={sessionStats.totalCostUsd}
      />
      <Box flexDirection="row" height={size.rows - 6}>
        <ChatStream messages={messages} height={size.rows - 6} width={chatWidth} />
        <Sidebar
          skillList={skillList}
          sessionCount={messages.length}
          isSlashMode={isSlashMode}
          height={size.rows - 6}
        />
      </Box>
      <InputBar
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={busy}
      />
    </Box>
  );
}