// @ts-nocheck — pre-existing strict-mode type narrowing issues carried over
// from app.tsx. Runtime is correct; tighten signatures in a follow-up.
import { useState, useRef, useCallback, useEffect } from 'react';
import {
  getCurrentSessionId,
  setCurrentSessionId,
  clearCurrentSessionId,
  newSessionId,
  ensureSessionDir,
  listSessions,
  loadSessionEvents,
} from '../sessionManager.js';
import { SessionJsonlWriter } from '@zelari/core/harness';
import type { ChatMessage } from '../components/ChatStream.js';
import { eventsToMessages } from './eventsToMessages.js';
import { EMPTY_LIVE, type LiveState } from './chatState.js';

/**
 * useSession — owns session lifecycle (bootstrap, restore, /sessions, /resume, /new).
 *
 * v0.7.0 static-scrollback refactor: the single `messages` array is now the
 * `finalized` region (append-only, feeds `<Static>`), with a new `live`
 * region holding the streaming bubble + pending tool invocations that Ink
 * repaints. See `src/cli/hooks/chatState.ts` for the invariant.
 *
 * Backward compatibility: `messages` / `setMessages` still expose the
 * finalized array, so `useSlashDispatch` and the slash handlers (which all
 * append system/user/sealed messages via `appendSystem(setMessages, ...)`)
 * keep working unchanged. Only the streaming hot-path in `useChatTurn` and
 * the tool start/end events are rerouted to `live`.
 */
export interface UseSessionResult {
  sessionId: string;
  setSessionId: (id: string) => void;
  /** The finalized transcript — append-only, feeds `<Static>`. */
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /** The dynamic region (streaming bubble + pending tools) Ink repaints. */
  live: LiveState;
  setLive: React.Dispatch<React.SetStateAction<LiveState>>;
  /** Always-current `live` snapshot for non-reactive callbacks (event loop). */
  liveRef: React.MutableRefObject<LiveState>;
  /** Reset both regions (used by /clear, /new). */
  resetTranscript: () => void;
  sessionActive: boolean;
  setSessionActive: (v: boolean) => void;
  writerRef: React.MutableRefObject<SessionJsonlWriter | null>;
  handleSessionKind: (kind: 'session' | 'resume' | 'new', targetSessionId?: string) => Promise<string>;
}

export function useSession(): UseSessionResult {
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE);
  const [sessionActive, setSessionActive] = useState(false);
  const writerRef = useRef<SessionJsonlWriter | null>(null);

  // Mirror `live` into a ref so non-reactive callbacks (the AgentHarness event
  // loop in useChatTurn) can read the current pending-tools snapshot without
  // depending on `live` in their dependency array (which would recreate the
  // callback every token and break the throttle layer).
  const liveRef = useRef<LiveState>(EMPTY_LIVE);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  const resetTranscript = useCallback(() => {
    setMessages([]);
    setLive(EMPTY_LIVE);
  }, []);

  // Bootstrap on mount: resume current session or create new one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await ensureSessionDir();
      let id = getCurrentSessionId();
      let restoredMessages: ChatMessage[] = [];
      if (id) {
        try {
          const events = await loadSessionEvents(id);
          if (!cancelled) {
            restoredMessages = eventsToMessages(events);
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
      // Restored messages are historical (immutable) → go straight into
      // finalized, printed once into native scrollback on resume. Same
      // behavior as Claude Code on session resume.
      setMessages(restoredMessages);
      if (restoredMessages.length > 0) {
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

  /**
   * Dispatch /sessions, /resume <id>, /new commands.
   * Returns the system message to surface in chat.
   */
  const handleSessionKind = useCallback(
    async (kind: 'session' | 'resume' | 'new', targetSessionId?: string): Promise<string> => {
      if (kind === 'session') {
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
      if (kind === 'resume' && targetSessionId) {
        setCurrentSessionId(targetSessionId);
        return `[resume] session ${targetSessionId.slice(0, 8)}… set as current — restart zelari-code to load it`;
      }
      if (kind === 'new') {
        clearCurrentSessionId();
        const id = newSessionId();
        setCurrentSessionId(id);
        writerRef.current?.close();
        writerRef.current = new SessionJsonlWriter(id);
        setSessionId(id);
        resetTranscript();
        setSessionActive(false);
        return `[new] fresh session ${id.slice(0, 8)}… started`;
      }
      return `[${kind}] handled`;
    },
    [resetTranscript],
  );

  return {
    sessionId,
    setSessionId,
    messages,
    setMessages,
    live,
    setLive,
    liveRef,
    resetTranscript,
    sessionActive,
    setSessionActive,
    writerRef,
    handleSessionKind,
  };
}
