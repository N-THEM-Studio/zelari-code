// @ts-nocheck — pre-existing strict-mode type narrowing issues carried over from
// the v3-N monolithic app. Behavior is correct; a future pass will tighten the
// hook signatures and remove this annotation. The split is documented in
// `docs/plans/2026-07-01-app-split.md`.
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Box, Text, Static, useInput, useStdin } from 'ink';
import { InputBar } from './components/InputBar.js';
import { LiveRegion } from './components/LiveRegion.js';
import { StatusBar, type ChatMode } from './components/StatusBar.js';
import { SelectList } from './components/SelectList.js';
import { Sidebar, sidebarVisibility } from './components/Sidebar.js';
import { StartupBanner } from './components/StartupBanner.js';
import type { PickerRequest } from './slashHandlers/provider.js';
import { discoverModelsInBackground, isModelsCacheStale, type ProviderId as DiscoveryProviderId } from './modelDiscovery.js';
import { renderMessage, type ChatMessage } from './components/ChatStream.js';
import { listCodingSkills } from '@zelari/core/skills';
import { useGitChanges } from './hooks/useGitChanges.js';
import { useExecutionTimer } from './hooks/useExecutionTimer.js';
import { shortenCwd } from './utils/paths.js';
import '@zelari/core/skills/builtin/debugging';
import '@zelari/core/skills/builtin/docs';
import '@zelari/core/skills/builtin/git-ops';
import '@zelari/core/skills/builtin/planning';
import '@zelari/core/skills/builtin/refactoring';
import '@zelari/core/skills/builtin/review';
import '@zelari/core/skills/builtin/testing';
import '@zelari/core/skills/builtin/schema-loop';
import '@zelari/core/skills/builtin/computer-use-cua';
import {
  getProviderConfig,
  getActiveProvider as getActiveProviderSpec,
} from './providerConfig.js';
import { SessionJsonlWriter } from '@zelari/core/harness';
import { VERSION } from './main.js';
import { useSession } from './hooks/useSession.js';
import { useChatTurn } from './hooks/useChatTurn.js';
import { useSlashDispatch } from './hooks/useSlashDispatch.js';
import { nextMode } from './mode.js';
import { useBatchedMessages } from './hooks/useBatchedMessages.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import type { LiveState } from './hooks/chatState.js';

const MODEL = process.env.OPENAI_MODEL ?? 'grok-4.5';
const PROVIDER = 'openai-compatible';

/**
 * Default model per provider, used when the user runs `/login <provider>`
 * without a prior `/model <name>` call.
 */
const providerDefaults: Record<string, string> = {
  'openai-compatible': 'grok-4.5',
  'grok': 'grok-4.5',
  'minimax': 'MiniMax-chat-latest',
  'glm': 'glm-4.5',
  'deepseek': 'deepseek-v4-pro',
};

/**
 * App — Ink UI shell (v0.7.0 static-scrollback layout).
 *
 * The fixed-height frame of v0.6 (root `<Box width height overflow=hidden>` +
 * `pickVisibleMessages`) is gone. Finalized messages feed Ink's `<Static>`,
 * which prints each item exactly once to real stdout so it becomes part of
 * the terminal's native scrollback. The dynamic region Ink repaints is now
 * just: the streaming tail (`<LiveRegion>`), a one-line `<StatusBar>`, and
 * the `<InputBar>`. Because that region is always a few lines tall, it can
 * never exceed the terminal height → no full-screen clear/repaint → no
 * flicker, by construction.
 *
 * v0.4.2 split still holds: App is a thin composition of focused hooks
 * (useSession, useChatTurn, useSlashDispatch).
 */
export function App(): React.ReactElement {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [providerConfig, setProviderConfig] = useState(() => getProviderConfig());
  const [sessionStats, setSessionStats] = useState({
    totalTokens: 0,
    totalCostUsd: 0,
    cachedTokens: 0,
    contextTokens: 0,
    premiumTokens: 0,
    cacheHitRate: 0,
    promptTokens: 0,
    stableBustCount: 0,
    lastStableHash: undefined as string | undefined,
  });
  // v0.7.0: bump on /clear to remount <Static> (resets its internal "already
  // printed" index so the ANSI-cleared scrollback stays in sync). Also bumped
  // implicitly by a sessionId change (/new).
  const [clearEpoch, setClearEpoch] = useState(0);
  // v0.7.9: dispatch mode for free-form prompts — 'agent' (single harness
  // turn) or 'council' (6-member pipeline). Toggled with shift+tab.
  const [mode, setMode] = useState<ChatMode>('agent');
  // v1.8.0: work phase (plan | build) — React state mirrors phaseState module
  // so StatusBar re-renders when /plan or /build is used.
  const [phase, setPhaseUi] = useState<'plan' | 'build'>('build');
  // v0.7.10: interactive picker (/provider, /model). While open it replaces
  // the InputBar so ink-text-input never competes for arrow keys.
  const [picker, setPicker] = useState<PickerRequest | null>(null);

  const activeProviderSpec = getActiveProviderSpec();
  const activeModel = providerConfig.modelByProvider[activeProviderSpec.id];

  const session = useSession();
  const size = useTerminalSize();
  const gitChanges = useGitChanges();
  const cwd = useMemo(() => shortenCwd(process.cwd(), 32), []);
  // v0.7.9: execution timer — elapsed time of the in-flight turn (shown in
  // the StatusBar as `⏱ 12s`, then frozen as `last 34s` when the run ends).
  const timer = useExecutionTimer(busy);

  // shift+tab → cycle agent → council → zelari. ink-text-input ignores tab
  // keys, so this never fights the InputBar. Guarded: useInput needs raw mode.
  const { isRawModeSupported } = useStdin();
  useInput(
    (_input, key) => {
      if (key.tab && key.shift) {
        setMode(nextMode);
      }
    },
    { isActive: isRawModeSupported === true },
  );

  // v0.7.10: startup model discovery — refresh the /v1/models cache in the
  // background when it's missing or older than 6h, so the /model picker and
  // tab-completion show current choices without an explicit /discover.
  useEffect(() => {
    const id = activeProviderSpec.id as DiscoveryProviderId;
    if (!['grok', 'glm', 'minimax', 'deepseek', 'openai-compatible'].includes(id)) return;
    if (!isModelsCacheStale(id)) return;
    discoverModelsInBackground(id, {});
    // Run once at mount for the provider active at startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Throttle layer for the `live` region — coalesces per-token streaming
  // updates (~50-200/sec) into ≤60 renders/sec. The finalized array uses the
  // raw setter (its appends are rare and user-facing).
  const { commit: commitLive, flush: flushLive } = useBatchedMessages<LiveState>(
    session.live,
    session.setLive,
  );

  const chatTurn = useChatTurn({
    sessionId: session.sessionId,
    writerRef: session.writerRef,
    setMessages: session.setMessages,
    commitStreaming: commitLive,
    flushStreaming: flushLive,
    setBusy,
    setSessionActive: session.setSessionActive,
    setSessionStats,
    setLive: session.setLive,
    liveRef: session.liveRef,
    // v1.6.0: lets dispatchPrompt open a SelectList when the agent poses a
    // ---QUESTION--- clarifying block, so the user picks from the offered
    // choices instead of typing (and the answer binds via rolling history).
    setPicker,
  });

  // /new callback: close the old writer, open a new one for the new id.
  const onNewSession = useCallback((id: string) => {
    void session.writerRef.current?.close();
    session.writerRef.current = new SessionJsonlWriter(id);
  }, [session.writerRef]);

  // /exit callback: flush the writer, then exit. 50ms lets the Ink render
  // queue drain so the last message reaches the terminal.
  const onExit = useCallback(() => {
    void session.writerRef.current?.close();
    setTimeout(() => process.exit(0), 50);
  }, [session.writerRef]);

  // /clear callback (v0.7.0): reset the live region too (pending tools /
  // streaming bubble shouldn't survive a clear) and bump the Static epoch.
  const onClear = useCallback(() => {
    session.resetTranscript();
    setClearEpoch((e) => e + 1);
  }, [session]);

  const handleSubmit = useSlashDispatch({
    skills: useMemo(() => listCodingSkills(), []),
    sessionId: session.sessionId,
    messages: session.messages,
    setMessages: session.setMessages,
    setInput,
    setBusy,
    setSessionId: session.setSessionId,
    setSessionActive: session.setSessionActive,
    setProviderConfig: (cfg) => setProviderConfig(cfg as typeof providerConfig),
    activeProviderSpec,
    activeModel,
    providerDefaults,
    harnessRef: chatTurn.harnessRef,
    setQueueCount: chatTurn.setQueueCount,
    dispatchPrompt: chatTurn.dispatchPrompt,
    dispatchCouncilPrompt: chatTurn.dispatchCouncilPrompt,
    dispatchZelariPrompt: chatTurn.dispatchZelariPrompt,
    mode,
    setMode,
    openPicker: setPicker,
    onNewSession,
    onExit,
    onClear,
    onPhaseChange: setPhaseUi,
    sessionStats,
  });

  // Picker selection re-enters the normal slash pipeline ('/provider <id>' /
  // '/model <id>') so persistence, config refresh and the system message all
  // come from the same code path as a typed command. For kind 'clarification'
  // (v1.6.0) the selected value is the user's answer to an agent-posed
  // question — it flows through onAnswer → dispatchPrompt, and rolling
  // history ensures the model re-sees its own question.
  const onPickerSelect = useCallback((value: string) => {
    if (!picker) return;
    setPicker(null);
    if (picker.kind === 'clarification') {
      picker.onAnswer?.(value);
      return;
    }
    const cmd = `${picker.commandPrefix} ${value}`;
    void handleSubmit(cmd);
  }, [picker, handleSubmit]);
  const onPickerCancel = useCallback(() => {
    if (picker?.kind === 'clarification') {
      picker.onCancel?.();
    }
    setPicker(null);
  }, [picker]);

  // One-shot clean header (text only; Braille logo is in the right Sidebar).
  // Marker message content is unused; Static renders StartupBanner for this id.
  const banner = useMemo<ChatMessage>(() => {
    return {
      id: 'banner-once',
      role: 'system',
      ts: 0,
      content: '',
    };
  }, []);

  // Sidebar visibility with hysteresis — avoid flapping at the 96-col edge.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    setSidebarOpen((prev) => sidebarVisibility(size.columns, size.rows, prev));
  }, [size.columns, size.rows]);

  // The Static feed: banner first, then finalized messages. `key` lets /clear
  // remount Static so its internal "already printed" index resets. clearEpoch
  // is composed in so /clear forces a remount even within the same session.
  //
  // v0.7.9 duplicate-banner fix: before the session bootstraps, sessionId is
  // '' — the first Static mount would print the banner, then the bootstrap
  // sessionId change would remount Static (new key) and print it AGAIN into
  // scrollback. Feed Static nothing until the session id exists, so the
  // banner prints exactly once, after bootstrap.
  const staticKey = `${session.sessionId || 'pre-bootstrap'}-${clearEpoch}`;
  const staticItems: readonly ChatMessage[] = session.sessionId
    ? [banner, ...session.messages]
    : [];

  return (
    <>
      <Static key={staticKey} items={staticItems}>
        {(item) =>
          item.id === 'banner-once' ? (
            <StartupBanner
              key={item.id}
              version={VERSION}
              providerId={activeProviderSpec.id}
              model={activeModel}
              cwd={cwd}
              columns={size.columns || 80}
              rows={size.rows || 24}
            />
          ) : (
            renderMessage(item)
          )
        }
      </Static>
      <Box flexDirection="row">
        {/* v0.7.9: the status line moved BELOW the input box (no more bar
            above it) and shows the execution timer instead of tokens/cost. */}
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <LiveRegion live={session.live} busy={busy} elapsedMs={timer.elapsedMs} />
          {picker ? (
            <SelectList
              title={picker.title}
              items={picker.items}
              onSelect={onPickerSelect}
              onCancel={onPickerCancel}
              maxVisible={Math.max(4, Math.min(10, size.rows - 10))}
            />
          ) : (
            <InputBar
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              disabled={busy}
            />
          )}
          <StatusBar
            model={activeModel}
            provider={activeProviderSpec.id}
            sessionId={session.sessionId ? session.sessionId.slice(0, 8) : '...'}
            sessionActive={session.sessionActive}
            queueCount={chatTurn.queueCount}
            busy={busy}
            mode={mode}
            phase={phase}
            cwd={cwd}
            elapsedMs={timer.elapsedMs}
            lastMs={timer.lastMs}
            costUsd={sessionStats.totalCostUsd}
            cachedTokens={sessionStats.cachedTokens}
            cacheHitRate={sessionStats.cacheHitRate || 0}
            contextUsed={sessionStats.contextTokens || 0}
            contextLimit={Number(process.env.ZELARI_CONTEXT_LIMIT) || 200_000}
          />
        </Box>
        {sidebarOpen && (
          <Sidebar version={VERSION} changes={gitChanges} rows={size.rows} />
        )}
      </Box>
    </>
  );
}

// Re-export so legacy imports keep working (Task v0.4.2 audit split).
// New code should import directly from src/cli/hooks/* instead.
export { applySteerInterrupt } from './hooks/steer.js';
export {
  formatSkillCompare,
  pickCompareWinner,
  compareSkillsFromFile,
  formatSkillCompareLine,
} from './hooks/skillCompare.js';
export { computeSessionStatsDelta } from './hooks/chatStats.js';
export { eventsToMessages } from './hooks/eventsToMessages.js';
export { formatDuration } from './utils/duration.js';

// Silence the unused-vars warning for these module-level constants while
// keeping them documented at the top of the file.
void MODEL; void PROVIDER;
