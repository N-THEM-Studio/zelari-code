/**
 * Serve-harness ask_user bridge — same-turn clarifying questions over NDJSON.
 *
 *   CLI → host : {"type":"ask_user.request","requestId", "question", "choices", "context"?, "sessionId"?}
 *   host → CLI : {"method":"ask_user.respond","params":{"requestId","answer": string|null,"sessionId"?}}
 *
 * Timeout / cancel → answer null → the tool proceeds with a documented
 * assumption (not a permission deny). Knob: ZELARI_ASK_USER_TIMEOUT_MS.
 *
 * t59 (chat isolation): request/settled events carry the harness
 * `sessionId` of the turn that asked, and a scoped respond may only
 * settle its own session's question — one chat can never answer
 * another chat's dialog on the shared sidecar transport.
 */
import type { AskUserHandler, AskUserRequest } from '../tools/askUser.js';
import { askUserTimeoutMs } from '../hooks/askUserTimeout.js';
import { getCurrentHarnessSessionId } from './sessionControl.js';

export interface AskUserAskPayload extends AskUserRequest {}

interface PendingAsk {
  resolve: (answer: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Harness session the question was raised in (t59 routing stamp). */
  sessionId?: string;
}

export interface ServeAskUserBridge {
  onAskUser: AskUserHandler;
  /** Scoped settle: a session-scoped answer only resolves its own ask. */
  respond: (requestId: string, answer: string | null, scopeSessionId?: string) => boolean;
  /** Session a pending question belongs to (undefined = unscoped/legacy). */
  sessionOf: (requestId: string) => string | undefined;
  pendingCount: () => number;
}

export function createServeAskUserBridge(
  write: (line: string) => void,
  timeoutMs = askUserTimeoutMs(),
): ServeAskUserBridge {
  const pending = new Map<string, PendingAsk>();
  let seq = 0;

  const settle = (
    requestId: string,
    answer: string | null,
    timedOut = false,
  ): boolean => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    write(
      JSON.stringify({
        type: 'ask_user.settled',
        requestId,
        answer,
        ...(entry.sessionId
          ? { sessionId: entry.sessionId, harnessSessionId: entry.sessionId }
          : {}),
        ...(timedOut ? { timedOut: true } : {}),
      }),
    );
    entry.resolve(answer);
    return true;
  };

  return {
    onAskUser(req) {
      const question = req.question.trim();
      const choices = req.choices.map((c) => c.trim()).filter(Boolean);
      if (choices.length < 2) return Promise.resolve(null);
      const requestId = `ask-${Date.now()}-${++seq}`;
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          settle(requestId, null, true);
        }, timeoutMs);
        // t59: stamp the owning harness session so the Desktop sidecar
        // can direct-route the question instead of broadcasting it.
        const sessionId = getCurrentHarnessSessionId();
        pending.set(requestId, { resolve, timer, sessionId });
        write(
          JSON.stringify({
            type: 'ask_user.request',
            requestId,
            // Routing key (session-routing capability): the SAME harness id
            // the Desktop routes every other line of this turn by.
            ...(sessionId ? { sessionId, harnessSessionId: sessionId } : {}),
            question,
            choices,
            ...(req.context ? { context: req.context } : {}),
          }),
        );
      });
    },
    respond: (requestId, answer, scopeSessionId) => {
      const entry = pending.get(requestId);
      // t59 scoping: a scoped respond may only settle its own session's ask.
      if (
        entry &&
        scopeSessionId &&
        entry.sessionId &&
        entry.sessionId !== scopeSessionId
      ) {
        return false;
      }
      return settle(requestId, answer, false);
    },
    sessionOf: (requestId) => pending.get(requestId)?.sessionId,
    pendingCount: () => pending.size,
  };
}

export function serveAskUserRespond(
  bridge: ServeAskUserBridge,
  params: unknown,
): { accepted: boolean; reason?: string } {
  if (!params || typeof params !== 'object') {
    return { accepted: false, reason: 'ask_user.respond requires an object params' };
  }
  const { requestId, answer, sessionId } = params as Record<string, unknown>;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return { accepted: false, reason: 'ask_user.respond requires a non-empty string requestId' };
  }
  if (answer !== null && typeof answer !== 'string') {
    return { accepted: false, reason: 'ask_user.respond answer must be a string or null' };
  }
  // t59: optional session scope — mismatch is an idempotent no-op with a
  // reason, never an error (the timeout already settled the turn).
  const scope = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
  if (scope && bridge.sessionOf(requestId) && bridge.sessionOf(requestId) !== scope) {
    return { accepted: false, reason: 'session_mismatch: requestId belongs to another session' };
  }
  const text = typeof answer === 'string' ? answer.trim() : null;
  return { accepted: bridge.respond(requestId, text && text.length > 0 ? text : null, scope) };
}
