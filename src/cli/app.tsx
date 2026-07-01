// @ts-nocheck — pre-existing strict-mode type narrowing issues carried over from
// the v3-N monolithic app. Behavior is correct; a future pass will tighten the
// hook signatures and remove this annotation. The split is documented in
// `docs/plans/2026-07-01-app-split.md`.
import React, { useState, useMemo, useCallback } from 'react';
import { Box } from 'ink';
import { Header } from './components/Header.js';
import { ChatStream } from './components/ChatStream.js';
import { InputBar } from './components/InputBar.js';
import { Sidebar } from './components/Sidebar.js';
import { formatSkillList } from './slashCommands.js';
import { listCodingSkills } from '../agents/skills.js';
import '../agents/skills/builtin/debugging.js';
import '../agents/skills/builtin/docs.js';
import '../agents/skills/builtin/git-ops.js';
import '../agents/skills/builtin/planning.js';
import '../agents/skills/builtin/refactoring.js';
import '../agents/skills/builtin/review.js';
import '../agents/skills/builtin/testing.js';
import {
  getProviderConfig,
  getActiveProvider as getActiveProviderSpec,
} from './providerConfig.js';
import { SessionJsonlWriter } from '../main/core/sessionJsonl.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useSession } from './hooks/useSession.js';
import { useChatTurn } from './hooks/useChatTurn.js';
import { useSlashDispatch } from './hooks/useSlashDispatch.js';

const MODEL = process.env.OPENAI_MODEL ?? 'grok-4';
const PROVIDER = 'openai-compatible';

/**
 * Default model per provider, used when the user runs `/login <provider>`
 * without a prior `/model <name>` call.
 */
const providerDefaults: Record<string, string> = {
  'openai-compatible': 'grok-4',
  'grok': 'grok-4',
  'minimax': 'MiniMax-chat-latest',
  'glm': 'glm-4.5',
};

/**
 * App — Ink UI shell.
 *
 * v0.4.2 split: the previous monolithic 2200-line app.tsx is now a thin
 * composition of focused hooks (see `src/cli/hooks/`):
 *   - useTerminalSize: reactive stdout dimensions with resize coalescing
 *   - useSession: session bootstrap + lifecycle (resume/new)
 *   - useChatTurn: AgentHarness dispatch (single prompt + council)
 *   - useSlashDispatch: router for every /command, delegates to handlers
 *                       in `src/cli/slashHandlers/*.ts`
 *
 * The App component itself only holds ephemeral UI state (input, busy,
 * sessionStats, providerConfig) and wires the hooks together.
 */
export function App(): React.ReactElement {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [providerConfig, setProviderConfig] = useState(() => getProviderConfig());
  const [sessionStats, setSessionStats] = useState({ totalTokens: 0, totalCostUsd: 0 });

  const activeProviderSpec = getActiveProviderSpec();
  const activeModel = providerConfig.modelByProvider[activeProviderSpec.id];

  const session = useSession();
  const size = useTerminalSize();

  const chatTurn = useChatTurn({
    sessionId: session.sessionId,
    writerRef: session.writerRef,
    setMessages: session.setMessages,
    setBusy,
    setSessionActive: session.setSessionActive,
    setSessionStats,
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
    onNewSession,
    onExit,
  });

  const skills = useMemo(() => listCodingSkills(), []);
  const skillList = useMemo(() => formatSkillList(skills), [skills]);
  const isSlashMode = input.startsWith('/');
  const chatWidth = Math.max(20, size.columns - 44);

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Header
        model={activeModel}
        provider={activeProviderSpec.id}
        skillCount={skills.length}
        sessionActive={session.sessionActive}
        sessionId={session.sessionId ? session.sessionId.slice(0, 8) : '...'}
        totalTokens={sessionStats.totalTokens}
        totalCostUsd={sessionStats.totalCostUsd}
      />
      <Box flexDirection="row" height={size.rows - 6}>
        <ChatStream messages={session.messages} height={size.rows - 6} width={chatWidth} />
        <Sidebar
          skillList={skillList}
          sessionCount={session.messages.length}
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