import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelRun,
  extractDelta,
  extractToolName,
  getAppConfig,
  getCliStatus,
  onAgentEvent,
  onAgentStderr,
  onRunFinished,
  runTask,
  setAppConfig,
} from "./agentClient";
import { ModeToggle } from "./components/ModeToggle";
import { PhaseToggle } from "./components/PhaseToggle";
import { ProviderModelBar } from "./components/ProviderModelBar";
import { SettingsView } from "./components/SettingsView";
import type {
  AppView,
  ChatMessage,
  CliStatus,
  Conversation,
  DesktopConfig,
  DispatchMode,
  WorkPhase,
} from "./types";
import "./App.css";

const SUGGESTIONS = [
  "Explain the architecture of this repo in plain language",
  "Find flaky tests and suggest fixes",
  "Add a unit test for the headless CLI path",
  "Review recent git changes for risk",
];

const LS_DEFAULTS = "zelari-desktop-defaults-v1";

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

function loadDefaults(): { mode: DispatchMode; phase: WorkPhase } {
  try {
    const raw = localStorage.getItem(LS_DEFAULTS);
    if (!raw) return { mode: "agent", phase: "build" };
    const p = JSON.parse(raw) as { mode?: string; phase?: string };
    const mode =
      p.mode === "council" || p.mode === "zelari" || p.mode === "agent"
        ? p.mode
        : "agent";
    const phase = p.phase === "plan" ? "plan" : "build";
    return { mode, phase };
  } catch {
    return { mode: "agent", phase: "build" };
  }
}

function saveDefaults(mode: DispatchMode, phase: WorkPhase) {
  try {
    localStorage.setItem(LS_DEFAULTS, JSON.stringify({ mode, phase }));
  } catch {
    /* ignore */
  }
}

function newConversation(
  mode: DispatchMode,
  phase: WorkPhase,
  provider?: string,
  model?: string,
): Conversation {
  const now = Date.now();
  return {
    id: uid("conv"),
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
    mode,
    phase,
    provider,
    model,
  };
}

export default function App() {
  const defaults = useMemo(() => loadDefaults(), []);
  const [view, setView] = useState<AppView>("chat");
  const [defaultMode, setDefaultMode] = useState<DispatchMode>(defaults.mode);
  const [defaultPhase, setDefaultPhase] = useState<WorkPhase>(defaults.phase);

  const [conversations, setConversations] = useState<Conversation[]>(() => [
    newConversation(defaults.mode, defaults.phase),
  ]);
  const [activeId, setActiveId] = useState(() => conversations[0].id);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<DispatchMode>(defaults.mode);
  const [phase, setPhase] = useState<WorkPhase>(defaults.phase);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [config, setConfig] = useState<DesktopConfig | null>(null);
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
        s.ok ? `CLI ${s.cliVersion ?? "ready"} · ${s.message}` : s.message,
      );
    } catch (e) {
      setCli(null);
      setStatusLine(
        e instanceof Error ? e.message : "Failed to query CLI status",
      );
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const c = await getAppConfig();
      setConfig(c);
      setProvider((prev) => prev || c.activeProviderId);
      setModel(
        (prev) =>
          prev ||
          c.modelByProvider[c.activeProviderId] ||
          c.providers.find((p) => p.id === c.activeProviderId)?.defaultModel ||
          "",
      );
    } catch (e) {
      setStatusLine(
        e instanceof Error ? e.message : "Failed to load provider config",
      );
    }
  }, []);

  useEffect(() => {
    void refreshCli();
    void refreshConfig();
  }, [refreshCli, refreshConfig]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active?.messages, running]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const u1 = await onAgentEvent((ev) => {
        if (cancelled) return;
        const convId = activeIdRef.current;

        if (ev.type === "log") {
          const msg =
            typeof (ev as { message?: string }).message === "string"
              ? (ev as { message: string }).message
              : "";
          if (msg) setStatusLine(msg.replace(/^\[.*?\]\s*/, "").slice(0, 120));
          if (msg.startsWith("[zelari]") || msg.startsWith("[headless]")) {
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
          return;
        }

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
                  messages[i] = { ...messages[i], content: `✓ ${name}` };
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
        if (/error|fail|missing|no api key/i.test(line)) {
          setStatusLine(line);
        }
      });
      if (!cancelled) unsubs.push(u2);

      const u3 = await onRunFinished(({ exitCode, cancelled: wasCancelled }) => {
        if (cancelled) return;
        setRunning(false);
        assistantIdRef.current = null;
        if (wasCancelled) setStatusLine("Run cancelled");
        else if (exitCode === 0) setStatusLine("Completed");
        else setStatusLine(`Finished with exit code ${exitCode}`);
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
    const c = newConversation(mode, phase, provider, model);
    setConversations((prev) => [c, ...prev]);
    setActiveId(c.id);
    setDraft("");
    assistantIdRef.current = null;
    taRef.current?.focus();
  };

  const onModeChange = (m: DispatchMode) => {
    setMode(m);
    setConversations((prev) =>
      prev.map((c) => (c.id === activeId ? { ...c, mode: m } : c)),
    );
  };

  const onPhaseChange = (p: WorkPhase) => {
    setPhase(p);
    setConversations((prev) =>
      prev.map((c) => (c.id === activeId ? { ...c, phase: p } : c)),
    );
  };

  const onProviderChange = (id: string) => {
    setProvider(id);
    const p = config?.providers.find((x) => x.id === id);
    const nextModel =
      config?.modelByProvider[id] || p?.defaultModel || p?.models[0] || "";
    setModel(nextModel);
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeId
          ? { ...c, provider: id, model: nextModel }
          : c,
      ),
    );
  };

  const onModelChange = (id: string) => {
    setModel(id);
    setConversations((prev) =>
      prev.map((c) => (c.id === activeId ? { ...c, model: id } : c)),
    );
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
    setStatusLine(`${mode} · ${phase} running…`);

    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== activeId) return c;
        const isFirst = c.messages.length === 0;
        return {
          ...c,
          title: isFirst ? titleFromPrompt(prompt) : c.title,
          mode,
          phase,
          provider,
          model,
          updatedAt: Date.now(),
          messages: [...c.messages, userMsg],
        };
      }),
    );

    try {
      await runTask({
        prompt,
        mode,
        phase,
        provider: provider || undefined,
        model: model || undefined,
      });
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

  if (view === "settings") {
    return (
      <div className="app app-settings">
        <SettingsView
          config={config}
          cli={cli}
          defaultMode={defaultMode}
          defaultPhase={defaultPhase}
          onBack={() => setView("chat")}
          onRefresh={async () => {
            await refreshConfig();
            await refreshCli();
          }}
          onSave={async (args) => {
            await setAppConfig({
              provider: args.provider,
              model: args.model,
            });
            setDefaultMode(args.defaultMode);
            setDefaultPhase(args.defaultPhase);
            saveDefaults(args.defaultMode, args.defaultPhase);
            setProvider(args.provider);
            setModel(args.model);
            setMode(args.defaultMode);
            setPhase(args.defaultPhase);
            await refreshConfig();
          }}
        />
      </div>
    );
  }

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
                  setMode(c.mode);
                  setPhase(c.phase);
                  if (c.provider) setProvider(c.provider);
                  if (c.model) setModel(c.model);
                }
              }}
            >
              <span className="session-title">{c.title}</span>
              <span className="session-meta">
                {c.mode} · {c.phase} · {formatTime(c.updatedAt)}
              </span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <button
            type="button"
            className="btn-settings"
            onClick={() => setView("settings")}
          >
            ⚙ Settings
          </button>
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
          <button
            type="button"
            className="btn-ghost topbar-settings"
            onClick={() => setView("settings")}
            title="Settings"
          >
            ⚙
          </button>
        </header>

        <div className="control-bar">
          <div className="control-row">
            <span className="control-label">Mode</span>
            <ModeToggle
              value={mode}
              disabled={running}
              onChange={onModeChange}
            />
            <span className="control-label">Phase</span>
            <PhaseToggle
              value={phase}
              disabled={running}
              onChange={onPhaseChange}
            />
          </div>
          <ProviderModelBar
            config={config}
            provider={provider}
            model={model}
            disabled={running}
            onProviderChange={onProviderChange}
            onModelChange={onModelChange}
          />
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {empty ? (
            <div className="empty-state">
              <div className="brand-mark" style={{ width: 40, height: 40 }}>
                Z
              </div>
              <h1>What should we build?</h1>
              <p>
                Agent · Council · Zelari with Plan/Build phases — same controls
                as the CLI TUI, via{" "}
                <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                  --headless
                </code>
                .
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
                mode === "zelari"
                  ? "Describe the mission… (Enter to send)"
                  : mode === "council"
                    ? "Ask the council… (Enter to send)"
                    : "Message the agent… (Enter to send)"
              }
              rows={2}
              disabled={running}
            />
            <div className="composer-bar">
              <div className="composer-hints">
                {phase} · {mode}
                {provider ? ` · ${provider}` : ""}
                {model ? ` / ${model}` : ""}
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
          </div>
        </div>
      </main>
    </div>
  );
}
