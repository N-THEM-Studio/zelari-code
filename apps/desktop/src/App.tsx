import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelRun,
  checkCliUpdate,
  extractDelta,
  extractToolCallId,
  extractToolDurationMs,
  extractToolIsError,
  extractToolName,
  extractToolResult,
  getAppConfig,
  getCliStatus,
  onAgentEvent,
  onAgentStderr,
  onRunFinished,
  runTask,
  setAppConfig,
  summarizeToolArgs,
  truncateToolPreview,
} from "./agentClient";
import { loadConversations, saveConversations } from "./chatStorage";
import { MessageContent, ThinkingIndicator } from "./components/MessageContent";
import { ModeToggle } from "./components/ModeToggle";
import { PhaseToggle } from "./components/PhaseToggle";
import { ProviderModelBar } from "./components/ProviderModelBar";
import { SettingsView } from "./components/SettingsView";
import { ToolCallCard } from "./components/ToolCallCard";
import { ProjectPanel } from "./components/ProjectPanel";
import { CliSetupGuide } from "./components/CliSetupGuide";
import { TitleBar } from "./components/TitleBar";
import {
  exportConversationJson,
  exportConversationMarkdown,
} from "./components/exportChat";
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
import { ensureOverlayOpenAtMin } from "./overlayWindow";
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

/**
 * Fallback multi-turn history when the CLI never emitted history_snapshot
 * (legacy council runs). Keep user + assistant only, last ~12 messages.
 * Excludes the user message just about to be sent (already the task).
 */
function deriveHistoryFromChat(
  messages: ChatMessage[],
  currentPrompt: string,
): AgentMessageLite[] {
  const out: AgentMessageLite[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = (m.content ?? "").trim();
    if (!content) continue;
    // Skip pure thinking-only empty streams
    if (m.role === "assistant" && content.length < 8) continue;
    out.push({
      role: m.role,
      content:
        content.length > 6000 ? `${content.slice(0, 5999)}…` : content,
    });
  }
  // Drop trailing user if it equals the message we're about to send
  // (send() appends userMsg before runTask, so it may already be in messages).
  if (out.length > 0) {
    const last = out[out.length - 1];
    if (
      last.role === "user" &&
      last.content.trim() === currentPrompt.trim()
    ) {
      out.pop();
    }
  }
  return out.slice(-12);
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
  // Working folder chosen via "Open Folder". Global to the app (one window =
  // one folder, like VSCode). Persisted across restarts. Null = inherit the
  // Tauri process cwd.
  const [workdir, setWorkdir] = useState<string | null>(
    () => localStorage.getItem("zelari-desktop-workdir") || null,
  );
  const [gitCollapsed, setGitCollapsed] = useState(
    () => localStorage.getItem("zelari-desktop-git-collapsed") === "1",
  );
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  /** User dismissed the missing-CLI setup overlay for this session. */
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [cliStatusLoading, setCliStatusLoading] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const assistantIdRef = useRef<string | null>(null);
  const activeMemberRef = useRef<{ name?: string; id?: string }>({});
  const turnTokensRef = useRef({
    prompt: 0,
    completion: 0,
    total: 0,
  });
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const runStartedAtRef = useRef<number>(0);
  const toolCountRef = useRef(0);
  const hasAssistantTextRef = useRef(false);
  const modeRef = useRef(mode);
  const phaseRef = useRef(phase);
  modeRef.current = mode;
  phaseRef.current = phase;
  const runningRef = useRef(running);
  runningRef.current = running;

  // Persist chats
  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  // Floating HUD: open once at minimum size when Desktop starts
  useEffect(() => {
    void ensureOverlayOpenAtMin().catch(() => undefined);
  }, []);

  // Persist the chosen working folder
  useEffect(() => {
    if (workdir) localStorage.setItem("zelari-desktop-workdir", workdir);
    else localStorage.removeItem("zelari-desktop-workdir");
  }, [workdir]);

  useEffect(() => {
    localStorage.setItem(
      "zelari-desktop-git-collapsed",
      gitCollapsed ? "1" : "0",
    );
  }, [gitCollapsed]);

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
      if (s.ok) setSetupDismissed(false);
    } catch (e) {
      setCli(null);
      setStatusLine(
        e instanceof Error ? e.message : "Failed to query CLI status",
      );
    } finally {
      setCliStatusLoading(false);
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

  // Quiet update checks on launch — only status line; install lives in Settings.
  useEffect(() => {
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const { update, current } = await checkForDesktopUpdate();
          if (update) {
            setStatusLine(
              `Desktop update available: v${update.version} (you have v${current}) — Settings → Updates`,
            );
            return;
          }
        } catch {
          /* offline / non-tauri */
        }
        try {
          const r = await checkCliUpdate();
          if (r.updateAvailable && r.installed && r.npmLatest) {
            setStatusLine(
              `CLI is v${r.installed} (npm latest v${r.npmLatest}) — Settings → Updates`,
            );
          }
        } catch {
          /* offline */
        }
      })();
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

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

        if (ev.type === "agent_start") {
          const anyEv = ev as {
            memberName?: string;
            memberId?: string;
          };
          if (anyEv.memberName || anyEv.memberId) {
            activeMemberRef.current = {
              name: anyEv.memberName,
              id: anyEv.memberId,
            };
            if (anyEv.memberName) {
              setStatusLine(`${anyEv.memberName} speaking…`);
            }
          }
          return;
        }

        if (ev.type === "message_start") {
          const anyEv = ev as { memberName?: string; memberId?: string };
          if (anyEv.memberName || anyEv.memberId) {
            activeMemberRef.current = {
              name: anyEv.memberName ?? activeMemberRef.current.name,
              id: anyEv.memberId ?? activeMemberRef.current.id,
            };
          }
          // Start a fresh assistant bubble per council member turn
          assistantIdRef.current = null;
          return;
        }

        if (ev.type === "member_cost") {
          const cost = (ev as {
            cost?: {
              name?: string;
              promptTokens?: number;
              completionTokens?: number;
              totalTokens?: number;
            };
          }).cost;
          if (cost) {
            turnTokensRef.current.prompt += cost.promptTokens ?? 0;
            turnTokensRef.current.completion += cost.completionTokens ?? 0;
            turnTokensRef.current.total += cost.totalTokens ?? 0;
            const who = cost.name ?? "member";
            const tok = cost.totalTokens ?? 0;
            if (tok > 0) {
              setStatusLine(
                `${who} · ${tok.toLocaleString()} tokens (turn ${turnTokensRef.current.total.toLocaleString()})`,
              );
            }
          }
          return;
        }

        // Proprietary CoT: never surface thinking_delta body in the product UI.
        // Spinner uses showGlobalThinking while running with no assistant text yet.
        if (ev.type === "thinking_delta") {
          return;
        }

        if (ev.type === "message_delta") {
          const delta = extractDelta(ev);
          if (!delta) return;
          hasAssistantTextRef.current = true;
          const memberName =
            (ev as { memberName?: string }).memberName ??
            activeMemberRef.current.name;
          const memberId =
            (ev as { memberId?: string }).memberId ??
            activeMemberRef.current.id;
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
                  memberName,
                  memberId,
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
                        memberName: m.memberName ?? memberName,
                        memberId: m.memberId ?? memberId,
                      }
                    : m,
                ),
              };
            }),
          );          return;
        }

        if (ev.type === "message_end" || ev.type === "agent_end") {
          const aid = assistantIdRef.current;
          const usage =
            ev.type === "message_end"
              ? (ev as { usage?: {
                  promptTokens?: number;
                  completionTokens?: number;
                  totalTokens?: number;
                } }).usage
              : undefined;
          if (usage) {
            turnTokensRef.current.prompt += usage.promptTokens ?? 0;
            turnTokensRef.current.completion += usage.completionTokens ?? 0;
            turnTokensRef.current.total +=
              usage.totalTokens ??
              (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
          }
          if (!aid) return;
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === aid
                    ? {
                        ...m,
                        streaming: false,
                        stats: usage
                          ? {
                              ...m.stats,
                              promptTokens: usage.promptTokens,
                              completionTokens: usage.completionTokens,
                              totalTokens:
                                usage.totalTokens ??
                                (usage.promptTokens ?? 0) +
                                  (usage.completionTokens ?? 0),
                            }
                          : m.stats,
                      }
                    : m,
                ),
              };
            }),
          );
          return;
        }

        if (ev.type === "tool_execution_start") {
          const name = extractToolName(ev);
          const toolCallId = extractToolCallId(ev);
          const anyEv = ev as { args?: Record<string, unknown> };
          const toolSummary = summarizeToolArgs(name, anyEv.args);
          toolCountRef.current += 1;
          const toolMsg: ChatMessage = {
            id: uid("tool"),
            role: "tool",
            content: "",
            toolName: name,
            toolCallId,
            toolStatus: "running",
            toolSummary: toolSummary || undefined,
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
          const toolCallId = extractToolCallId(ev);
          const isError = extractToolIsError(ev);
          const durationMs = extractToolDurationMs(ev);
          const resultPreview = truncateToolPreview(extractToolResult(ev));
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              const messages = [...c.messages];
              let idx = -1;
              if (toolCallId) {
                idx = messages.findIndex(
                  (m) =>
                    m.role === "tool" &&
                    m.toolCallId === toolCallId &&
                    m.toolStatus !== "done",
                );
              }
              if (idx < 0) {
                for (let i = messages.length - 1; i >= 0; i--) {
                  if (
                    messages[i].role === "tool" &&
                    messages[i].toolStatus !== "done" &&
                    (messages[i].toolName === name ||
                      messages[i].content.endsWith("…"))
                  ) {
                    idx = i;
                    break;
                  }
                }
              }
              if (idx >= 0) {
                messages[idx] = {
                  ...messages[idx],
                  toolStatus: "done",
                  toolOk: !isError,
                  toolDurationMs: durationMs,
                  content: resultPreview,
                  toolName: messages[idx].toolName || name,
                };
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
      // If cleanup already ran (StrictMode remount), drop the listener
      // immediately — otherwise orphan handlers double-append deltas ("CCiao").
      if (cancelled) u1();
      else unsubs.push(u1);

      const u2 = await onAgentStderr((line) => {
        if (cancelled) return;
        if (/error|fail|missing|no api key/i.test(line)) {
          setStatusLine(line);
        }
      });
      if (cancelled) u2();
      else unsubs.push(u2);

      const u3 = await onRunFinished(({ exitCode, cancelled: wasCancelled }) => {
        if (cancelled) return;
        setRunning(false);
        const durationMs = Date.now() - (runStartedAtRef.current || Date.now());
        const tools = toolCountRef.current;
        const tokens = turnTokensRef.current;
        const aid = assistantIdRef.current;
        assistantIdRef.current = null;
        activeMemberRef.current = {};

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
                        ...m.stats,
                        durationMs,
                        toolCount: tools,
                        charCount: m.content.length,
                        promptTokens:
                          m.stats?.promptTokens ??
                          (tokens.prompt > 0 ? tokens.prompt : undefined),
                        completionTokens:
                          m.stats?.completionTokens ??
                          (tokens.completion > 0
                            ? tokens.completion
                            : undefined),
                        totalTokens:
                          m.stats?.totalTokens ??
                          (tokens.total > 0 ? tokens.total : undefined),
                      },
                    }
                  : m,
              ),
            };
          }),
        );

        const tokPart =
          tokens.total > 0
            ? ` · ${tokens.total.toLocaleString()} tokens`
            : "";
        if (wasCancelled) setStatusLine("Run cancelled");
        else if (exitCode === 0)
          setStatusLine(
            `Completed · ${(durationMs / 1000).toFixed(1)}s · ${tools} tools${tokPart}`,
          );
        else setStatusLine(`Finished with exit code ${exitCode}${tokPart}`);
        setGitRefreshKey((k) => k + 1);
        void refreshCli();
      });
      if (cancelled) u3();
      else unsubs.push(u3);
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
      unsubs.length = 0;
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
    activeMemberRef.current = {};
    hasAssistantTextRef.current = false;
    toolCountRef.current = 0;
    turnTokensRef.current = { prompt: 0, completion: 0, total: 0 };
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
      // Prefer CLI history_snapshot chain; if missing (older council runs),
      // derive user/assistant turns from the chat UI so "procedi" keeps context.
      const historyForRun =
        active?.history && active.history.length > 0
          ? active.history
          : deriveHistoryFromChat(active?.messages ?? [], prompt);

      await runTask({
        prompt,
        mode,
        phase,
        provider: provider || undefined,
        model: model || undefined,
        cwd: workdir ?? undefined,
        // Replay rolling history so the headless agent/council keeps multi-turn
        // context (answers "procedi" / "sì" instead of amnesia).
        history: historyForRun,
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

  // Global shortcuts — use e.code (layout-stable). Ctrl+Shift+M is stolen by
  // Chromium/WebView2 (device mode), so mode cycles with Ctrl+Shift+D.
  useEffect(() => {
    const onGlobalKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "Escape" && runningRef.current) {
        e.preventDefault();
        void cancelRun()
          .then(() => setStatusLine("Cancelling…"))
          .catch((err) =>
            setStatusLine(err instanceof Error ? err.message : String(err)),
          );
        return;
      }
      if (mod && !e.shiftKey && e.code === "KeyN") {
        e.preventDefault();
        if (!runningRef.current) {
          const c = newConversation(
            modeRef.current,
            phaseRef.current,
            provider,
            model,
          );
          setConversations((prev) => [c, ...prev]);
          setActiveId(c.id);
          setSessionFilter("active");
          setDraft("");
          assistantIdRef.current = null;
          taRef.current?.focus();
        }
        return;
      }
      if (mod && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        e.stopPropagation();
        const order: DispatchMode[] = ["agent", "council", "zelari"];
        const cur = modeRef.current;
        const next = order[(order.indexOf(cur) + 1) % order.length];
        setMode(next);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeIdRef.current ? { ...c, mode: next } : c,
          ),
        );
        setStatusLine(`Mode · ${next}`);
        return;
      }
      if (mod && e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        e.stopPropagation();
        const next: WorkPhase =
          phaseRef.current === "plan" ? "build" : "plan";
        setPhase(next);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeIdRef.current ? { ...c, phase: next } : c,
          ),
        );
        setStatusLine(`Phase · ${next}`);
        return;
      }
    };
    window.addEventListener("keydown", onGlobalKey, true);
    return () => window.removeEventListener("keydown", onGlobalKey, true);
    // provider/model only for new-chat defaults
  }, [provider, model]);

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
      <div className="app app-chrome app-settings">
        <TitleBar />
        <div className="app-settings-body">
          <SettingsView
            config={config}
            cli={cli}
            defaultMode={defaultMode}
            defaultPhase={defaultPhase}
            workdir={workdir}
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
      </div>
    );
  }

  const showCliSetup =
    !setupDismissed && !cliStatusLoading && cli !== null && !cli.ok;

  return (
    <div className="app app-chrome">
      <TitleBar />
      {showCliSetup && (
        <CliSetupGuide
          cli={cli}
          loading={cliStatusLoading}
          onRefresh={refreshCli}
          onOpenSettings={() => setView("settings")}
          onDismiss={() => setSetupDismissed(true)}
        />
      )}
      <div className="app-body">
      <aside className="sidebar">
        <div className="sidebar-top">
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

      <div className="workspace">
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
            {active && messages.length > 0 && (
              <div className="export-menu">
                <button
                  type="button"
                  className="btn-ghost"
                  title="Export chat as Markdown"
                  disabled={running}
                  onClick={() => exportConversationMarkdown(active)}
                >
                  ⬇ MD
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  title="Export chat as JSON"
                  disabled={running}
                  onClick={() => exportConversationJson(active)}
                >
                  ⬇ JSON
                </button>
              </div>
            )}
          </div>
        </header>

        <div className="control-bar">
          <div className="control-cluster control-cluster-run">
            <ModeToggle
              value={mode}
              disabled={running}
              onChange={onModeChange}
            />
            <PhaseToggle
              value={phase}
              disabled={running}
              onChange={onPhaseChange}
            />
          </div>
          <div className="control-divider" aria-hidden />
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
              {messages.map((m) =>
                m.role === "tool" ? (
                  <div key={m.id} className="message tool">
                    <ToolCallCard message={m} />
                  </div>
                ) : (
                  <div key={m.id} className={`message ${m.role}`}>
                    <div className="message-role">
                      {m.role === "user"
                        ? "You"
                        : m.role === "assistant"
                          ? m.memberName || "Zelari"
                          : "System"}
                      {m.role === "assistant" && m.memberName && (
                        <span className="badge badge-member">council</span>
                      )}
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
                      <div className="bubble system-bubble">{m.content}</div>
                    )}
                  </div>
                ),
              )}
              {showGlobalThinking && (
                <div className="message assistant">
                  <div className="message-role">
                    {activeMemberRef.current.name || "Zelari"}{" "}
                    <span className="badge">thinking</span>
                  </div>
                  <ThinkingIndicator
                    label={
                      mode === "zelari"
                        ? "Mission running"
                        : mode === "council"
                          ? activeMemberRef.current.name
                            ? `${activeMemberRef.current.name} working`
                            : "Council deliberating"
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
                <span className="composer-shortcuts" title="Keyboard shortcuts">
                  {" "}
                  · Esc stop · ⌘/Ctrl+N new · ⌘/Ctrl+Shift+D mode · ⌘/Ctrl+Shift+P phase
                </span>
              </div>
              <div className="composer-actions">
                {running ? (
                  <button type="button" className="btn-stop" onClick={() => void onStop()}>
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

      <ProjectPanel
        cwd={workdir}
        refreshKey={gitRefreshKey}
        collapsed={gitCollapsed}
        onToggle={() => setGitCollapsed((v) => !v)}
        onStatus={setStatusLine}
      />
      </div>
      </div>
    </div>
  );
}
