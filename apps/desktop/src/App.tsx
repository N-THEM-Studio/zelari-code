import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelRun,
  checkCliUpdate,
  extractDelta,
  extractToolName,
  getAppConfig,
  getCliStatus,
  onAgentEvent,
  onAgentStderr,
  onRunFinished,
  runTask,
  setAppConfig,
  updateCli,
} from "./agentClient";
import { loadConversations, saveConversations } from "./chatStorage";
import { MessageContent, ThinkingIndicator } from "./components/MessageContent";
import { ModeToggle } from "./components/ModeToggle";
import { PhaseToggle } from "./components/PhaseToggle";
import { ProviderModelBar } from "./components/ProviderModelBar";
import { SettingsView } from "./components/SettingsView";
import type {
  AgentMessageLite,
  AppView,
  ChatMessage,
  CliStatus,
  Conversation,
  DesktopConfig,
  DispatchMode,
  SessionFilter,
  WorkPhase,
} from "./types";
import zelariLogo from "./assets/zelari-logo.png";
import {
  UpdateBarButton,
  type PendingDesktopUpdate,
} from "./components/UpdateBarButton";
import { checkForDesktopUpdate } from "./updater";
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
    archived: false,
  };
}

export default function App() {
  const defaults = useMemo(() => loadDefaults(), []);
  const [view, setView] = useState<AppView>("chat");
  const [defaultMode, setDefaultMode] = useState<DispatchMode>(defaults.mode);
  const [defaultPhase, setDefaultPhase] = useState<WorkPhase>(defaults.phase);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("active");

  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const stored = loadConversations();
    if (stored && stored.length > 0) return stored;
    return [newConversation(defaults.mode, defaults.phase)];
  });
  const [activeId, setActiveId] = useState(
    () => conversations.find((c) => !c.archived)?.id ?? conversations[0].id,
  );
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<DispatchMode>(defaults.mode);
  const [phase, setPhase] = useState<WorkPhase>(defaults.phase);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [config, setConfig] = useState<DesktopConfig | null>(null);
  const [statusLine, setStatusLine] = useState("Connecting…");
  const [pendingUpdate, setPendingUpdate] =
    useState<PendingDesktopUpdate | null>(null);
  const [cliNpmLatest, setCliNpmLatest] = useState<string | null>(null);
  const [cliNeedsUpdate, setCliNeedsUpdate] = useState(false);
  const [cliUpdating, setCliUpdating] = useState(false);
  // Working folder chosen via "Open Folder". Global to the app (one window =
  // one folder, like VSCode). Persisted across restarts. Null = inherit the
  // Tauri process cwd.
  const [workdir, setWorkdir] = useState<string | null>(
    () => localStorage.getItem("zelari-desktop-workdir") || null,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const assistantIdRef = useRef<string | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const runStartedAtRef = useRef<number>(0);
  const toolCountRef = useRef(0);
  const hasAssistantTextRef = useRef(false);

  // Persist chats
  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  // Persist the chosen working folder
  useEffect(() => {
    if (workdir) localStorage.setItem("zelari-desktop-workdir", workdir);
    else localStorage.removeItem("zelari-desktop-workdir");
  }, [workdir]);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? conversations[0],
    [conversations, activeId],
  );

  const visibleSessions = useMemo(() => {
    return conversations.filter((c) =>
      sessionFilter === "archived" ? c.archived : !c.archived,
    );
  }, [conversations, sessionFilter]);

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

  const runDesktopUpdateCheck = useCallback(async (quiet = false) => {
    if (!quiet) setStatusLine("Checking for desktop updates…");
    try {
      const { update, current } = await checkForDesktopUpdate();
      if (!update) {
        setPendingUpdate(null);
        if (!quiet) setStatusLine(`Desktop up to date (v${current})`);
        return;
      }
      setPendingUpdate({
        version: update.version,
        current,
        update,
      });
      setStatusLine(
        `Update available: v${update.version} (you have v${current}) — click Update`,
      );
    } catch (e) {
      if (!quiet) {
        setStatusLine(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  // Quiet desktop + CLI update checks on launch.
  useEffect(() => {
    const t = window.setTimeout(() => {
      void runDesktopUpdateCheck(true);
      void (async () => {
        try {
          const r = await checkCliUpdate();
          setCliNpmLatest(r.npmLatest ?? null);
          setCliNeedsUpdate(!!r.updateAvailable);
          if (r.updateAvailable && r.installed && r.npmLatest) {
            setStatusLine(
              `CLI is v${r.installed} (npm latest v${r.npmLatest}) — Update CLI in Settings or top bar`,
            );
          }
        } catch {
          /* offline */
        }
      })();
    }, 2500);
    return () => window.clearTimeout(t);
  }, [runDesktopUpdateCheck]);

  const runCliUpdate = useCallback(async () => {
    setCliUpdating(true);
    setStatusLine("Updating CLI via npm…");
    try {
      const r = await updateCli({
        version: cliNpmLatest ?? "latest",
      });
      setStatusLine(
        r.installed
          ? `CLI updated to v${r.installed}`
          : "CLI update finished — re-check version",
      );
      setCliNeedsUpdate(false);
      await refreshCli();
      try {
        const chk = await checkCliUpdate();
        setCliNeedsUpdate(!!chk.updateAvailable);
        setCliNpmLatest(chk.npmLatest ?? null);
      } catch {
        /* ignore */
      }
    } catch (e) {
      setStatusLine(e instanceof Error ? e.message : String(e));
    } finally {
      setCliUpdating(false);
    }
  }, [cliNpmLatest, refreshCli]);

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
          if (msg) setStatusLine(msg.replace(/^\[.*?\]\s*/, "").slice(0, 140));
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

        // v1.10.0: collect the rolling provider-side history so the next
        // runTask can replay it (--history) and the agent keeps multi-turn
        // context. Emitted once at end-of-turn by the headless CLI.
        if (ev.type === "history_snapshot") {
          const msgs = (ev as { messages?: AgentMessageLite[] }).messages;
          if (Array.isArray(msgs)) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId
                  ? {
                      ...c,
                      history: [
                        ...(c.history ?? []),
                        ...msgs,
                      ].slice(-24), // cap to keep argv/context window bounded
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
          if (!isThinking) hasAssistantTextRef.current = true;
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
                        meta: isThinking ? "thinking" : m.meta === "thinking" && !isThinking ? undefined : m.meta,
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
          toolCountRef.current += 1;
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
        const durationMs = Date.now() - (runStartedAtRef.current || Date.now());
        const tools = toolCountRef.current;
        const aid = assistantIdRef.current;
        assistantIdRef.current = null;

        // Attach light stats to last assistant message
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== activeIdRef.current) return c;
            const messages = [...c.messages];
            const targetId =
              aid ??
              [...messages].reverse().find((m) => m.role === "assistant")?.id;
            if (!targetId) return c;
            return {
              ...c,
              messages: messages.map((m) =>
                m.id === targetId
                  ? {
                      ...m,
                      streaming: false,
                      stats: {
                        durationMs,
                        toolCount: tools,
                        charCount: m.content.length,
                      },
                    }
                  : m,
              ),
            };
          }),
        );

        if (wasCancelled) setStatusLine("Run cancelled");
        else if (exitCode === 0)
          setStatusLine(
            `Completed · ${(durationMs / 1000).toFixed(1)}s · ${tools} tools`,
          );
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
    setSessionFilter("active");
    setDraft("");
    assistantIdRef.current = null;
    taRef.current?.focus();
  };

  const archiveChat = (id: string) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, archived: true, archivedAt: Date.now(), updatedAt: Date.now() }
          : c,
      ),
    );
    if (activeId === id) {
      const next = conversations.find((c) => c.id !== id && !c.archived);
      if (next) {
        setActiveId(next.id);
        setMode(next.mode);
        setPhase(next.phase);
      } else {
        startNewChat();
      }
    }
  };

  const unarchiveChat = (id: string) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, archived: false, archivedAt: undefined, updatedAt: Date.now() }
          : c,
      ),
    );
  };

  const deleteChat = (id: string) => {
    if (!window.confirm("Delete this chat permanently?")) return;
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (next.length === 0) {
        const fresh = newConversation(mode, phase, provider, model);
        setActiveId(fresh.id);
        return [fresh];
      }
      if (activeId === id) {
        const pick = next.find((c) => !c.archived) ?? next[0];
        setActiveId(pick.id);
        setMode(pick.mode);
        setPhase(pick.phase);
      }
      return next;
    });
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
        c.id === activeId ? { ...c, provider: id, model: nextModel } : c,
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
    hasAssistantTextRef.current = false;
    toolCountRef.current = 0;
    runStartedAtRef.current = Date.now();
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
          archived: false,
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
        cwd: workdir ?? undefined,
        // Replay rolling history so the headless agent keeps multi-turn
        // context (answers "procedi" / "sì" instead of amnesia).
        history: active?.history,
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

  const pickFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        setWorkdir(selected);
        setStatusLine(`Cartella: ${selected}`);
      }
    } catch (e) {
      setStatusLine(e instanceof Error ? e.message : String(e));
    }
  };

  const messages = active?.messages ?? [];
  const empty = messages.length === 0;
  const showGlobalThinking =
    running && !hasAssistantTextRef.current && !messages.some((m) => m.streaming);

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
            <div className="brand-mark" aria-hidden>
              <img src={zelariLogo} alt="" className="brand-logo" />
            </div>
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
          <div className="session-filter">
            <button
              type="button"
              className={sessionFilter === "active" ? "active" : ""}
              onClick={() => setSessionFilter("active")}
            >
              Active
            </button>
            <button
              type="button"
              className={sessionFilter === "archived" ? "active" : ""}
              onClick={() => setSessionFilter("archived")}
            >
              Archived
            </button>
          </div>
        </div>

        <div className="session-list">
          <div className="session-label">Sessions</div>
          {visibleSessions.length === 0 && (
            <div className="session-empty">
              {sessionFilter === "archived"
                ? "No archived chats"
                : "No active chats"}
            </div>
          )}
          {visibleSessions.map((c) => (
            <div
              key={c.id}
              className={`session-item-wrap${c.id === activeId ? " active" : ""}`}
            >
              <button
                type="button"
                className="session-item"
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
              <div className="session-actions">
                {c.archived ? (
                  <button
                    type="button"
                    title="Unarchive"
                    onClick={() => unarchiveChat(c.id)}
                  >
                    ↩
                  </button>
                ) : (
                  <button
                    type="button"
                    title="Archive"
                    onClick={() => archiveChat(c.id)}
                  >
                    ⬇
                  </button>
                )}
                <button
                  type="button"
                  title="Delete"
                  className="danger"
                  onClick={() => deleteChat(c.id)}
                >
                  ×
                </button>
              </div>
            </div>
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
            </div>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">{active?.title ?? "Zelari"}</div>
          <div className="topbar-actions">
            <button
              type="button"
              className="btn-ghost topbar-folder"
              disabled={running}
              onClick={() => void pickFolder()}
              title={
                workdir
                  ? `${workdir} — click per cambiare cartella`
                  : "Apri una cartella di lavoro"
              }
            >
              📁 {workdir ? workdir.replace(/.*[\\/]/, "") : "Open Folder"}
            </button>
            {cliNeedsUpdate && (
              <button
                type="button"
                className="btn-update btn-update-cli"
                disabled={running || cliUpdating}
                title="Install latest zelari-code from npm (Desktop installer does not update the CLI)"
                onClick={() => void runCliUpdate()}
              >
                {cliUpdating
                  ? "Updating CLI…"
                  : `Update CLI${cliNpmLatest ? ` v${cliNpmLatest}` : ""}`}
              </button>
            )}
            <UpdateBarButton
              pending={pendingUpdate}
              busy={running || cliUpdating}
              onCheck={() => void runDesktopUpdateCheck(false)}
              onProgress={setStatusLine}
              onError={setStatusLine}
              onInstalled={() => {
                setPendingUpdate(null);
                setStatusLine("Update installed — restarting…");
              }}
            />
            <button
              type="button"
              className="btn-ghost topbar-settings"
              onClick={() => setView("settings")}
              title="Settings"
            >
              ⚙
            </button>
          </div>
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
            onConfigRefresh={setConfig}
            onStatus={setStatusLine}
          />
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {empty && !running ? (
            <div className="empty-state">
              <div className="brand-mark lg" aria-hidden>
                <img src={zelariLogo} alt="Zelari" className="brand-logo" />
              </div>
              <h1>What should we build?</h1>
              <p>
                Agent · Council · Zelari with Plan/Build — clean reply layout,
                tools, and light stats.
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
                  {m.role === "assistant" ? (
                    <MessageContent
                      content={m.content}
                      streaming={m.streaming}
                      thinking={m.meta === "thinking"}
                      showThinking={
                        m.streaming &&
                        m.meta === "thinking" &&
                        !m.content.trim()
                      }
                      stats={m.stats}
                    />
                  ) : m.role === "user" ? (
                    <div className="bubble user-bubble">{m.content}</div>
                  ) : (
                    <div className="bubble tool-bubble">{m.content}</div>
                  )}
                </div>
              ))}
              {showGlobalThinking && (
                <div className="message assistant">
                  <div className="message-role">
                    Zelari <span className="badge">thinking</span>
                  </div>
                  <ThinkingIndicator
                    label={
                      mode === "zelari"
                        ? "Mission running"
                        : mode === "council"
                          ? "Council deliberating"
                          : "Thinking"
                    }
                  />
                </div>
              )}
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
        </div>
      </main>
    </div>
  );
}
