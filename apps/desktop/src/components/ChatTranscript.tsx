/**
 * Chat transcript — the per-message list of the active conversation.
 *
 * SLICE2(transcript-memo): extracted from App.tsx, where the map lived inside
 * the (very large) App component and therefore re-ran on EVERY App render —
 * including every streaming delta, where only the last message actually
 * changed. Two memo layers keep the cost flat:
 *   1. `React.memo` here — an App re-render for unrelated state (status line,
 *      panels, sidebar) does not re-walk the transcript at all, because
 *      `messages` keeps its array identity.
 *   2. `MessageContent` is memoised with a value comparator, so when a delta
 *      does arrive (new `messages` array) only the message that changed is
 *      re-parsed — see `messageContentPropsEqual` in ./MessageContent.tsx.
 *
 * Renders a fragment: the caller owns the `.chat-inner` wrapper and the live
 * run widgets (RunActivity, cards) that share it, so the DOM is unchanged.
 */
import { memo } from "react";
import type { ChatMessage } from "../types";
import type { PermissionAskStatus } from "../inChatAsk";
import { cleanAssistantContent } from "../exportSession";
import { hasGauntletLoop, stripGauntletLoop } from "../gauntletLoop";
import { ChatImageCard } from "./ChatImageCard";
import { ClarificationCard } from "./ClarificationCard";
import { CopyButton } from "./CopyButton";
import { MessageContent } from "./MessageContent";
import { PermissionCard } from "./PermissionCard";
import { ReplyAccordion } from "./ReplyAccordion";

/** User-selectable decisions (settled/timeout states are not emitted here). */
export type PermissionDecision = Exclude<
  PermissionAskStatus,
  "pending" | "timeout"
>;

export interface ChatTranscriptProps {
  /** Messages of the active conversation (unfiltered, as stored). */
  messages: ChatMessage[];
  /** A run is active: ask cards are inert, the stop path owns the turn. */
  running: boolean;
  /** Choice picked in an inline ---QUESTION--- block of an assistant reply. */
  onClarificationChoose: (choice: string) => void;
  /** In-chat tool permission decision (sidecar permission.request). */
  onPermissionDecide: (requestId: string, decision: PermissionDecision) => void;
  /** In-chat ask_user answer (sidecar ask_user.request). */
  onAskUserChoose: (requestId: string, choice: string) => void;
}

function ChatTranscriptImpl({
  messages,
  running,
  onClarificationChoose,
  onPermissionDecide,
  onAskUserChoose,
}: ChatTranscriptProps) {
  return (
    <>
      {messages
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
                  onClarificationChoose={onClarificationChoose}
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
                  <div className="bubble system-bubble">
                    {m.askUserAsk.status === "timeout"
                      ? "No answer — continuing with a documented assumption."
                      : `Answered: ${m.askUserAsk.answer ?? ""}`}
                  </div>
                )
              ) : (
                <div className="bubble system-bubble">{m.content}</div>
              )}
            </div>
          ),
        )}
    </>
  );
}

/**
 * React.memo with the default shallow comparison: `messages` changes identity
 * exactly when a message is added/updated (the reducer rebuilds the array), and
 * the three handlers are stable (`useStableHandler` / `useCallback` in App) —
 * so this bails out on every App render that is not a transcript change.
 */
export const ChatTranscript = memo(ChatTranscriptImpl);
