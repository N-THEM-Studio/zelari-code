/**
 * usePermissionBroker — TUI-side broker for external-agent permission
 * prompts (OpenMausBot pattern).
 *
 * When `ZELARI_PERM_SOCKET` is set, the TUI listens on that socket. An
 * external CLI (`claude --permission-prompt-tool "zelari-code
 * --permission-mcp <socket>"`) forwards `approve`/`ask_user` requests here;
 * this hook routes them through the EXISTING picker machinery:
 *   - permission → `createPermissionAskHandler` (Allow once · Always ·
 *     Deny) + `resolveToolPermission` policy (ZELARI_AUTO auto-allow, session
 *     grants apply across external requests too),
 *   - question → the same clarification picker used by ask_user.
 *
 * Never throws: a broker that cannot start logs to stderr and is skipped.
 *
 * @since v1.30.0
 */

import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage } from "../components/ChatStream.js";
import {
  startPermissionBroker,
  type PermissionBrokerHandle,
} from "../mcp/permissionBroker.js";
import {
  createBrokerPermissionHandler,
  createBrokerQuestionHandler,
} from "../mcp/brokerHandlers.js";
import { createPermissionAskHandler, type SetPicker } from "./permissionPicker.js";
import { appendSystem } from "./messageHelpers.js";

export function usePermissionBroker(opts: {
  setPicker: SetPicker;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}): { socketPath?: string } {
  const { setPicker, setMessages } = opts;
  const handleRef = useRef<PermissionBrokerHandle | null>(null);

  useEffect(() => {
    const socketPath = process.env.ZELARI_PERM_SOCKET?.trim();
    if (!socketPath) return;

    let disposed = false;
    let handle: PermissionBrokerHandle | null = null;

    const onPermissionAsk = createPermissionAskHandler({
      setPicker,
      appendSystem: (msg, at) => appendSystem(setMessages, msg, at ?? Date.now()),
    });

    const onQuestion = (req: {
      question: string;
      choices?: string[];
      context?: string;
    }): Promise<string | null> =>
      new Promise<string | null>((resolve) => {
        const choices = (req.choices ?? [])
          .map((c) => String(c).trim())
          .filter((c) => c.length > 0);
        if (choices.length < 2) {
          resolve(null);
          return;
        }
        let settled = false;
        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          setPicker(null);
          resolve(value);
        };
        appendSystem(
          setMessages,
          `[external agent] ${req.question}\n→ ${choices.join(" · ")}`,
          Date.now(),
        );
        setPicker({
          kind: "clarification",
          title: req.question,
          items: choices.map((c) => ({ value: c, label: c })),
          onAnswer: (value: string) => finish(value),
          onCancel: () => finish(null),
        });
      });

    void startPermissionBroker(socketPath, {
      onPermission: createBrokerPermissionHandler({ onPermissionAsk }),
      onQuestion: createBrokerQuestionHandler({ onQuestion }),
    })
      .then((h) => {
        if (disposed) {
          void h.stop();
          return;
        }
        handle = h;
        handleRef.current = h;
        appendSystem(
          setMessages,
          `[permission-broker] listening on ${socketPath} — external agents can request approvals.`,
          Date.now(),
        );
        process.stderr.write(
          `[zelari-code] permission broker listening on ${socketPath}\n`,
        );
      })
      .catch((err) => {
        process.stderr.write(
          `[zelari-code] permission broker failed to start: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      });

    return () => {
      disposed = true;
      if (handle) void handle.stop();
      handleRef.current = null;
    };
  }, [setPicker, setMessages]);

  return { socketPath: process.env.ZELARI_PERM_SOCKET?.trim() || undefined };
}
