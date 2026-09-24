/**
 * Presentational message list: user/assistant bubbles plus the tool
 * permission and ask-user cards.
 *
 * Pure — App owns consultations, run wiring and stream commits; ChatList only
 * maps messages to markup and forwards the user's intent through callbacks, so
 * a Composer keystroke (or any unrelated App state) never re-renders it.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ChatMessage } from "../types";
import type { PermissionAskStatus } from "../inChatAsk";
import { cleanAssistantContent } from "../exportSession";
import { hasGauntletLoop, stripGauntletLoop } from "../gauntletLoop";
import { MessageContent } from "./MessageContent";
import { CopyButton } from "./CopyButton";
import { ReplyAccordion } from "./ReplyAccordion";
import { ChatImageCard } from "./ChatImageCard";
import { PermissionCard } from "./PermissionCard";
import { ClarificationCard } from "./ClarificationCard";
import { SystemNotice } from "./SystemNotice";
import { describeAskUserOutcome, describeSystemMessage } from "../systemNotice";

/** Permission decisions the card can emit (pending/timeout are not choices). */
export type PermissionDecision = Exclude<
  PermissionAskStatus,
  "pending" | "timeout"
>;

/**
 * How many trailing messages to mount on first paint (and per "load earlier"
 * step). Conversations can hold hundreds of messages; mounting them all on
 * open is the cost this window keeps off the first render. No pixel
 * virtualization — rows keep their natural height, we just cap the tail.
 */
const WINDOW_SIZE = 60;

interface Props {
  messages: ChatMessage[];
  /** A run is live in this conversation (gates clarification buttons). */
  running: boolean;
  onClarificationChoose: (choice: string) => void;
  onPermissionDecide: (requestId: string, decision: PermissionDecision) => void;
  onAskUserChoose: (requestId: string, choice: string) => void;
  /**
   * Active conversation id: changing it collapses the window back to the
   * newest {@link WINDOW_SIZE} messages so a previously expanded chat never
   * leaks its window into the next one.
   */
  conversationId?: string;
  /**
   * App-owned scroll container. ChatList only reads/restores `scrollTop` /
   * `scrollHeight` around a window extension to keep the reading position
   * stable when content is prepended; it never owns the scroller. Optional so
   * the component stays renderable without a real scroll host (unit tests).
   */
  scrollRef?: RefObject<HTMLElement | null>;
}

function ChatListBase({
  messages,
  running,
  onClarificationChoose,
  onPermissionDecide,
  onAskUserChoose,
  conversationId,
  scrollRef,
}: Props) {
  // Stable per-render handler so the memoized MessageContent below only
  // re-renders when its own content/streaming props (or `running`) change.
  const handleClarification = useCallback(
    (choice: string) => {
      if (running) return;
      onClarificationChoose(choice);
    },
    [running, onClarificationChoose],
  );

  // --- Windowing (progressive rendering) ---------------------------------
  // Only the trailing `visibleCount` messages are mounted. The window is
  // always anchored to the END of the array, so streaming/append at the tail
  // never evicts what is currently on screen — it just slides the cut point.
  const [visibleCount, setVisibleCount] = useState(WINDOW_SIZE);

  // Switching chat drops back to the newest window (id is a prop, so this is
  // the memo boundary too). No-op on first mount.
  useEffect(() => {
    setVisibleCount(WINDOW_SIZE);
  }, [conversationId]);

  // Prepend anchor: extending upward inserts content ABOVE the viewport, which
  // would shove the reading position down. Measure the scroller before the
  // re-render, then add the grown height back to scrollTop in a layout effect
  // (before paint) so the same message stays under the user's eyes.
  const preAnchorRef = useRef<{ top: number; height: number } | null>(null);

  const loadEarlier = useCallback(() => {
    const el = scrollRef?.current ?? null;
    preAnchorRef.current = el
      ? { top: el.scrollTop, height: el.scrollHeight }
      : null;
    // +WINDOW_SIZE per click; the tail remaining collapses to "all" naturally.
    setVisibleCount((c) => Math.min(messages.length, c + WINDOW_SIZE));
  }, [scrollRef, messages.length]);

  useLayoutEffect(() => {
    const el = scrollRef?.current;
    const anchor = preAnchorRef.current;
    if (!el || !anchor) return;
    preAnchorRef.current = null;
    const grown = el.scrollHeight - anchor.height;
    if (grown > 0) el.scrollTop = anchor.top + grown;
  }, [visibleCount, scrollRef]);

  const startIndex = Math.max(0, messages.length - visibleCount);
  const earlierCount = startIndex;
  const visibleMessages = earlierCount > 0 ? messages.slice(startIndex) : messages;

  return (
    <>
      {earlierCount > 0 ? (
        <button
          type="button"
          className="btn-ghost chat-load-earlier"
          onClick={loadEarlier}
          style={{ alignSelf: "center" }}
          title="Mount the messages before these"
        >
          Load earlier messages ({earlierCount})
        </button>
      ) : null}
      {visibleMessages
        .filter((m) => {
          if (m.role === "tool") return false;
          // Hide legacy bootstrap noise already stored in chat history
          if (m.role === "system") {
            const t = m.content.trim();
            if (/^\[headless\]\s*mode=/i.test(t)) return false;
            if (/^\[headless\]\s*MCP tools\s*:/i.test(t)) return false;
          }
          return true;
        })
        .map((m) =>
          m.role === "assistant" && m.imagePaths?.length ? (
            <ChatImageCard
              key={m.id}
              paths={m.imagePaths}
              caption="Screenshot"
            />
          ) : m.role === "assistant" ? (
            <div
              key={m.id}
              className={`message assistant msg-fade${m.streaming ? " is-streaming" : ""}`}
            >
              <ReplyAccordion
                title={m.memberName || "Zelari"}
                badge={m.memberName ? "council" : undefined}
                streaming={m.streaming}
                defaultOpen
                stats={m.stats}
                onCopy={() => cleanAssistantContent(m.content)}
              >
                <MessageContent
                  content={m.content}
                  streaming={m.streaming}
                  thinking={m.meta === "thinking"}
                  showThinking={
                    m.streaming && m.meta === "thinking" && !m.content.trim()
                  }
                  clarificationDisabled={running}
                  onClarificationChoose={handleClarification}
                />
              </ReplyAccordion>
            </div>
          ) : (
            <div
              key={m.id}
              className={`message ${m.role}${m.steer ? " is-steer" : ""}`}
            >
              {m.role === "user" ? (
                <>
                  <div className="bubble user-bubble">
                    {m.steer ? (
                      <span className={`steer-state ${m.steer.state}`}>
                        {m.steer.state === "sent"
                          ? "steering…"
                          : m.steer.state === "accepted"
                            ? "queued · applies at turn end"
                            : m.steer.state === "applied"
                              ? "applied ✓"
                              : m.steer.state === "not_applied"
                                ? "not applied — run finished"
                                : "rejected ✗"}
                      </span>
                    ) : null}
                    {hasGauntletLoop(m.content) ? (
                      <>
                        <span className="gauntlet-badge">Gauntlet</span>
                        {stripGauntletLoop(m.content) || "Gauntlet Loop"}
                      </>
                    ) : (
                      m.content
                    )}
                  </div>
                  <div className="bubble-actions">
                    <CopyButton getText={() => m.content} title="Copy message" />
                  </div>
                </>
              ) : m.permissionAsk ? (
                <PermissionCard
                  ask={m.permissionAsk}
                  disabled={m.permissionAsk.status !== "pending"}
                  onDecide={(decision) =>
                    onPermissionDecide(m.permissionAsk!.requestId, decision)
                  }
                />
              ) : m.askUserAsk ? (
                m.askUserAsk.status === "pending" ? (
                  <ClarificationCard
                    request={{
                      question: m.askUserAsk.question,
                      choices: m.askUserAsk.choices,
                      context: m.askUserAsk.context,
                    }}
                    onChoose={(choice) =>
                      onAskUserChoose(m.askUserAsk!.requestId, choice)
                    }
                  />
                ) : (
                  <SystemNotice
                    notice={describeAskUserOutcome(
                      m.askUserAsk.question,
                      m.askUserAsk.answer,
                      m.askUserAsk.status === "timeout",
                    )}
                    raw={m.askUserAsk.answer ?? m.askUserAsk.question}
                  />
                )
              ) : (
                <SystemNotice notice={describeSystemMessage(m.content, m.notice)} raw={m.content} />
              )}
            </div>
          ),
        )}
    </>
  );
}

export const ChatList = memo(ChatListBase);
