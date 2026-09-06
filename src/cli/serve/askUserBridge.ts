/**
 * Serve-harness ask_user bridge — same-turn clarifying questions over NDJSON.
 *
 *   CLI → host : {"type":"ask_user.request","requestId", "question", "choices", "context"?}
 *   host → CLI : {"method":"ask_user.respond","params":{"requestId","answer": string|null}}
 *
 * Timeout / cancel → answer null → the tool proceeds with a documented
 * assumption (not a permission deny). Knob: ZELARI_ASK_USER_TIMEOUT_MS.
 */
import type { AskUserHandler, AskUserRequest } from '../tools/askUser.js';
import { askUserTimeoutMs } from '../hooks/askUserTimeout.js';

export interface AskUserAskPayload extends AskUserRequest {}

interface PendingAsk {
  resolve: (answer: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ServeAskUserBridge {
  onAskUser: AskUserHandler;
  respond: (requestId: string, answer: string | null) => boolean;
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
        pending.set(requestId, { resolve, timer });
        write(
          JSON.stringify({
            type: 'ask_user.request',
            requestId,
            question,
            choices,
            ...(req.context ? { context: req.context } : {}),
          }),
        );
      });
    },
    respond: (requestId, answer) => settle(requestId, answer, false),
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
  const { requestId, answer } = params as Record<string, unknown>;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return { accepted: false, reason: 'ask_user.respond requires a non-empty string requestId' };
  }
  if (answer !== null && typeof answer !== 'string') {
    return { accepted: false, reason: 'ask_user.respond answer must be a string or null' };
  }
  const text = typeof answer === 'string' ? answer.trim() : null;
  return { accepted: bridge.respond(requestId, text && text.length > 0 ? text : null) };
}
