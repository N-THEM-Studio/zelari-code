import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelRun,
  extractDelta,
  extractToolName,
  getCliStatus,
  onAgentEvent,
  onAgentStderr,
  onRunFinished,
  runTask,
} from "./agentClient";
import type { ChatMessage, CliStatus, Conversation } from "./types";
import "./App.css";

const SUGGESTIONS = [
  "Explain the architecture of this repo in plain language",
  "Find flaky tests and suggest fixes",
  "Add a unit test for the headless CLI path",
  "Review recent git changes for risk",
];

function uid(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFromPrompt(prompt: string): string {
  const t = prompt.trim().replace(/\s+/g, " ");
  return t.length > 48 ? `${t.slice(0, 48)}…` : t || "New chat";
}

function formatTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

function newConversation(council = false): Conversation {
  const now = Date.now();
  return {
    id: uid("conv"),
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
    council,
  };
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(() => [
    newConversation(),
  ]);
  const [activeId, setActiveId] = useState(() => conversations[0].id);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [council, setCouncil] = useState(false);
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [statusLine, setStatusLine] = useState("Connecting…");

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const assistantIdRef = useRef<string | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? conversations[0],
    [conversations, activeId],
  );

  const refreshCli = useCallback(async () => {
    try {
      const s = await getCliStatus();
      setCli(s);
      setStatusLine(
        s.ok
          ? `CLI ${s.cliVersion ?? "ready"} · ${s.message}`
          : s.message,
      );
    } catch (e) {
      setCli(null);
      setStatusLine(
        e instanceof Error ? e.message : "Failed to query CLI status",
      );
    }
  }, []);

  useEffect(() => {
    void refreshCli();
  }, [refreshCli]);

  // Auto-scroll chat
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active?.messages, running]);

  // Subscribe to agent events once
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const u1 = await onAgentEvent((ev) => {
        if (cancelled) return;
        const convId = activeIdRef.current;

        if (ev.type === "message_delta" || ev.type === "thinking_delta") {
          const delta = extractDelta(ev);
          if (!delta) return;
          const isThinking = ev.type === "thinking_delta";
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              const messages = [...c.messages];
              let aid = assistantIdRef.current;
              if (!aid || !messages.some((m) => m.id === aid)) {
                aid = uid("asst");
                assistantIdRef.current = aid;
                messages.push({
                  id: aid,
                  role: "assistant",
                  content: "",
                  createdAt: Date.now(),
                  streaming: true,
                  meta: isThinking ? "thinking" : undefined,
                });
              }
              return {
                ...c,
                updatedAt: Date.now(),
                messages: messages.map((m) =>
                  m.id === aid
                    ? {
                        ...m,
                        content: m.content + delta,
                        streaming: true,
                        meta: isThinking ? "thinking" : m.meta,
                      }
                    : m,
                ),
              };
            }),
          );
          return;
        }

        if (ev.type === "message_end" || ev.type === "agent_end") {
          const aid = assistantIdRef.current;
          if (!aid) return;
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === aid ? { ...m, streaming: false } : m,
                ),
              };
            }),
          );
          return;
        }

        if (ev.type === "tool_execution_start") {
          const name = extractToolName(ev);
          const toolMsg: ChatMessage = {
            id: uid("tool"),
            role: "tool",
            content: `Running ${name}…`,
            toolName: name,
            createdAt: Date.now(),
          };
          // Start a fresh assistant bubble after tools
          assistantIdRef.current = null;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === convId
                ? {
                    ...c,
                    updatedAt: Date.now(),
                    messages: [...c.messages, toolMsg],
                  }
                : c,
            ),
          );
          return;
        }

        if (ev.type === "tool_execution_end") {
          const name = extractToolName(ev);
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              const messages = [...c.messages];
              for (let i = messages.length - 1; i >= 0; i--) {
                if (
                  messages[i].role === "tool" &&
                  messages[i].toolName === name &&
                  messages[i].content.endsWith("…")
                ) {
                  messages[i] = {
                    ...messages[i],
                    content: `✓ ${name}`,
                  };
                  break;
                }
              }
              return { ...c, messages };
            }),
          );
          return;
        }

        if (ev.type === "error") {
          const msg =
            (typeof ev.message === "string" && ev.message) ||
            (typeof (ev as { error?: string }).error === "string" &&
              (ev as { error?: string }).error) ||
            "Unknown error";
          setConversations((prev) =>
            prev.map((c) =>
              c.id === convId
                ? {
                    ...c,
                    messages: [
                      ...c.messages,
                      {
                        id: uid("sys"),
                        role: "system",
                        content: msg,
                        createdAt: Date.now(),
                      },
                    ],
                  }
                : c,
            ),
          );
        }
      });
      if (!cancelled) unsubs.push(u1);

      const u2 = await onAgentStderr((line) => {
        if (cancelled) return;
        // Keep stderr quiet unless it looks like an error
        if (/error|fail|missing|no api key/i.test(line)) {
          setStatusLine(line);
        }
      });
      if (!cancelled) unsubs.push(u2);

      const u3 = await onRunFinished(({ exitCode, cancelled: wasCancelled }) => {
        if (cancelled) return;
        setRunning(false);
        assistantIdRef.current = null;
        if (wasCancelled) {
          setStatusLine("Run cancelled");
        } else if (exitCode === 0) {
          setStatusLine("Completed");
        } else {
          setStatusLine(`Finished with exit code ${exitCode}`);
        }
        void refreshCli();
      });
      if (!cancelled) unsubs.push(u3);
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [refreshCli]);

  const startNewChat = () => {
    if (running) return;
    const c = newConversation(council);
    setConversations((prev) => [c, ...prev]);
    setActiveId(c.id);
    setDraft("");
    assistantIdRef.current = null;
    taRef.current?.focus();
  };

  const send = async (text?: string) => {
    const prompt = (text ?? draft).trim();
    if (!prompt || running) return;

    if (cli && !cli.ok) {
      setStatusLine(cli.message);
      return;
    }

    const userMsg: ChatMessage = {
      id: uid("user"),
      role: "user",
      content: prompt,
      createdAt: Date.now(),
    };

    assistantIdRef.current = null;
    setDraft("");
    setRunning(true);
    setStatusLine(council ? "Council running…" : "Agent running…");

    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== activeId) return c;
        const isFirst = c.messages.length === 0;
        return {
          ...c,
          title: isFirst ? titleFromPrompt(prompt) : c.title,
          council,
          updatedAt: Date.now(),
          messages: [...c.messages, userMsg],
        };
      }),
    );

    try {
      await runTask({ prompt, council });
    } catch (e) {
      setRunning(false);
      const msg = e instanceof Error ? e.message : String(e);
      setStatusLine(msg);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeId
            ? {
                ...c,
                messages: [
                  ...c.messages,
                  {
                    id: uid("sys"),
                    role: "system",
                    content: msg,
                    createdAt: Date.now(),
                  },
                ],
              }
            : c,
        ),
      );
    }
  };

  const onStop = async () => {
    try {
      await cancelRun();
      setStatusLine("Cancelling…");
    } catch (e) {
      setStatusLine(e instanceof Error ? e.message : String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const messages = active?.messages ?? [];
  const empty = messages.length === 0;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <div className="brand-mark">Z</div>
            <div className="brand-text">
              <span className="brand-name">Zelari Desktop</span>
              <span className="brand-sub">coding agent shell</span>
            </div>
          </div>
          <button
            type="button"
            className="btn-new"
            onClick={startNewChat}
            disabled={running}
          >
            <span aria-hidden>+</span> New chat
          </button>
        </div>

        <div className="session-list">
          <div className="session-label">Sessions</div>
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`session-item${c.id === activeId ? " active" : ""}`}
              onClick={() => {
                if (!running) {
                  setActiveId(c.id);
                  setCouncil(c.council);
                }
              }}
            >
              <span className="session-title">{c.title}</span>
              <span className="session-meta">
                {c.council ? "Council · " : "Agent · "}
                {formatTime(c.updatedAt)}
              </span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <div className="status-pill">
            <span
              className={`status-dot ${cli?.ok ? "ok" : "bad"}`}
              aria-hidden
            />
            <div>
              <div>{statusLine}</div>
              {cli?.cliPath && (
                <div>
                  <code>{cli.cliPath}</code>
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">{active?.title ?? "Zelari"}</div>
          <div className="mode-toggle" role="group" aria-label="Run mode">
            <button
              type="button"
              className={`mode-btn${!council ? " active" : ""}`}
              disabled={running}
              onClick={() => setCouncil(false)}
            >
              Agent
            </button>
            <button
              type="button"
              className={`mode-btn${council ? " active" : ""}`}
              disabled={running}
              onClick={() => setCouncil(true)}
            >
              Council
            </button>
          </div>
        </header>

        <div className="chat-scroll" ref={scrollRef}>
          {empty ? (
            <div className="empty-state">
              <div className="brand-mark" style={{ width: 40, height: 40 }}>
                Z
              </div>
              <h1>What should we build?</h1>
              <p>
                Chat with Zelari Code through a desktop shell. The CLI stays
                installed via npm — this app streams{" "}
                <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                  --headless
                </code>{" "}
                runs.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="suggestion"
                    onClick={() => void send(s)}
                    disabled={running || (cli !== null && !cli.ok)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-inner">
              {messages.map((m) => (
                <div key={m.id} className={`message ${m.role}`}>
                  <div className="message-role">
                    {m.role === "user"
                      ? "You"
                      : m.role === "assistant"
                        ? "Zelari"
                        : m.role === "tool"
                          ? "Tool"
                          : "System"}
                    {m.meta === "thinking" && (
                      <span className="badge">thinking</span>
                    )}
                    {m.streaming && <span className="badge">streaming</span>}
                  </div>
                  <div
                    className={`bubble${m.streaming ? " streaming-cursor" : ""}`}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                council
                  ? "Ask the council… (Enter to send, Shift+Enter newline)"
                  : "Message Zelari… (Enter to send, Shift+Enter newline)"
              }
              rows={2}
              disabled={running}
            />
            <div className="composer-bar">
              <div className="composer-hints">
                {council ? "6-agent council" : "Single agent"} · CLI side-car
              </div>
              <div className="composer-actions">
                {running ? (
                  <button type="button" className="btn-stop" onClick={onStop}>
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-send"
                    disabled={!draft.trim() || (cli !== null && !cli.ok)}
                    onClick={() => void send()}
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="footer-note">
            CLI remains first-class:{" "}
            <code style={{ fontFamily: "var(--mono)" }}>
              npm i -g zelari-code
            </code>
            . Desktop is an optional shell.
          </div>
        </div>
      </main>
    </div>
  );
}
