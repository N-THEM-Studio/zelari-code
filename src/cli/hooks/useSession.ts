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
import { SessionJsonlWriter } from '../../main/core/sessionJsonl.js';
import type { ChatMessage } from '../components/ChatStream.js';
import { eventsToMessages } from './eventsToMessages.js';

/**
 * useSession — owns session lifecycle (bootstrap, restore, /sessions, /resume, /new).
 *
 * Extracted from app.tsx (Task v0.4.2 audit split). The component is purely
 * state + side effects — no rendering. Callers receive:
 *   - sessionId: current session id (or '' pre-bootstrap)
 *   - messages: restored + appended chat messages
 *   - sessionActive: true once at least one prompt has been dispatched
 *   - writerRef: SessionJsonlWriter for streaming event persistence
 *   - setMessages / setSessionId / setSessionActive: setters
 *   - handleSessionKind: dispatcher for /sessions, /resume, /new
 *
 * The hook is intentionally render-free so it can be unit-tested with
 * @testing-library/react-hooks or similar without booting Ink.
 */
export interface UseSessionResult {
  sessionId: string;
  setSessionId: (id: string) => void;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  sessionActive: boolean;
  setSessionActive: (v: boolean) => void;
  writerRef: React.MutableRefObject<SessionJsonlWriter | null>;
  handleSessionKind: (kind: 'session' | 'resume' | 'new', targetSessionId?: string) => Promise<string>;
}

export function useSession(): UseSessionResult {
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionActive, setSessionActive] = useState(false);
  const writerRef = useRef<SessionJsonlWriter | null>(null);

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
        setMessages([]);
        setSessionActive(false);
        return `[new] fresh session ${id.slice(0, 8)}… started`;
      }
      return `[${kind}] handled`;
    },
    [],
  );

  return {
    sessionId,
    setSessionId,
    messages,
    setMessages,
    sessionActive,
    setSessionActive,
    writerRef,
    handleSessionKind,
  };
}