import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelRun,
  checkCliUpdate,
  extractDelta,
  extractToolCallId,
  extractToolName,
  extractToolResult,
  getAppConfig,
  getCliStatus,
  getPluginsStatus,
  installPlugin,
  onAgentEvent,
  onAgentStderr,
  onRunFinished,
  runTask,
  setAppConfig,
  summarizeToolArgs,
} from "./agentClient";
import { loadConversations, saveConversations } from "./chatStorage";
import { cleanAssistantContent } from "./exportSession";
import { MessageContent } from "./components/MessageContent";
import { CopyButton } from "./components/CopyButton";
import { ModeToggle } from "./components/ModeToggle";
import { PhaseToggle } from "./components/PhaseToggle";
import { KrakenGraphToggle } from "./components/KrakenGraphToggle";
import { GauntletToggle } from "./components/GauntletToggle";
import { hasGauntletLoop, stripGauntletLoop } from "./gauntletLoop";

import { ProviderModelBar } from "./components/ProviderModelBar";
import { SettingsView } from "./components/SettingsView";
import { RunActivity, type LiveToolStep } from "./components/RunActivity";
import { KrakenActivity } from "./components/KrakenActivity";
import {
  KrakenProgressCard,
  readKrakenProgress,
  readKrakenMetrics,
  type KrakenProgressView,
  type KrakenMetricsView,
} from "./components/KrakenProgressCard";
import {
  VerificationStatusCard,
  readVerificationRun,
  type VerificationRunView,
} from "./components/VerificationStatusCard";
import {
  GauntletProgressCard,
  readGauntletProgress,
  type GauntletProgressView,
} from "./components/GauntletProgressCard";
import {
  loadDesktopPrefs,
  saveDesktopPrefs,
  type DesktopPrefs,
} from "./desktopPrefs";

import { LiveTasksPanel } from "./components/LiveTasksPanel";
import { parseTodosFromUnknown } from "./sessionTodosUi";
import {
  SESSION_FOLDERS_STORAGE_KEY,
  groupSessionsByFolder,
  loadCollapsedSet,
  persistCollapsedSet,
  toggleCollapsedKey,
} from "./sessionGroups";
import {
  applySessionTasks,
  applyWorkspaceSnapshot,
  applyWorkspaceUpdate,
  brainTaskToLive,
  clearSessionTasks,
  loadWorkspaceTasks,
  mergeSessionTasks,
  normalizeCwdKey,
  toSessionTasks,
  toTodoPayload,
} from "./liveTasks";
import type { LiveTask } from "./liveTasks";
import { readRunEnvelope } from "./runs/types";
import {
  unseenResultsByConversation,
  useRunCoordinator,
} from "./runs";
import { ReplyAccordion } from "./components/ReplyAccordion";
import { friendlyToolLabel } from "./components/toolLabels";
import { scrubDisplayText } from "./components/scrubDisplayText";
import { ProjectPanel } from "./components/ProjectPanel";
import { CliSetupGuide } from "./components/CliSetupGuide";
import { TitleBar } from "./components/TitleBar";
import {
  MentionPopup,
  applyMentionInsert,
  detectMentionQuery,
} from "./components/MentionPopup";
import {
  SkillPicker,
  expandDesktopSkill,
} from "./components/SkillPicker";
import {
  readProjectText,
  type SkillEntryDto,
  type WorkspaceHit,
} from "./agentClient";
import {
  PluginInstallBanner,
  type PluginInstallError,
  type PluginStatusRow,
} from "./components/PluginInstallBanner";
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
import { checkForDesktopUpdate } from "./updater";
import { useSpeechToText } from "./hooks/useSpeechToText";
import "./App.css";

const SUGGESTIONS = [
  "Explain the architecture of this repo in plain language",
  "Find flaky tests and suggest fixes",
  "Add a unit test for the headless CLI path",
  "Review recent git changes for risk",
];

/** Per-suggestion icon (reference mock): refresh · clock · chart · shield. */
const SUGGESTION_ICONS = ["🔄", "🕒", "📊", "🛡️"];

/** Max chars of file text inlined into the agent prompt per attachment. */
const ATTACH_TEXT_MAX = 48_000;
const ATTACH_FILE_MAX_BYTES = 512_000;

type PendingAttachment = {
  id: string;
  name: string;
  size: number;
  path?: string;
  text?: string;
  note?: string;
  /** Inline vision block for dropped images (base64, sent as @path). */
  image?: { mime: string; dataBase64: string };
};

function fileNativePath(f: File): string | undefined {
  const p = (f as File & { path?: string }).path;
  return typeof p === "string" && p.trim() ? p : undefined;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function mimeFromName(name: string): string | undefined {
  const m = /\.(png|jpe?g|gif|webp|bmp)$/i.exec(name);
  if (!m) return undefined;
  const ext = m[1].toLowerCase();
  if (ext === "jpg") return "image/jpeg";
  if (ext === "jpeg") return "image/jpeg";
  return `image/${ext}`;
}

function isImageFile(file: File): boolean {
  const t = (file.type || "").toLowerCase();
  return (
    t.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)
  );
}

function isProbablyText(file: File, head: string): boolean {
  const t = (file.type || "").toLowerCase();
  if (t.startsWith("text/")) return true;
  if (
    t.includes("json") ||
    t.includes("xml") ||
    t.includes("javascript") ||
    t.includes("typescript") ||
    t.includes("svg")
  )
    return true;
  const n = file.name.toLowerCase();
  if (
    /\.(txt|md|markdown|json|jsonc|ts|tsx|js|jsx|mjs|cjs|css|scss|html|htm|xml|yml|yaml|toml|ini|cfg|conf|rs|go|py|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|ps1|sql|graphql|env|gitignore|dockerfile|makefile|cmake|lock|svg)$/i.test(
      n,
    )
  )
    return true;
  // Heuristic: no NUL in first chunk
  return !head.includes("\0") && /[\x09\x0a\x0d\x20-\x7e]/.test(head.slice(0, 200));
}

async function readFileAsAttachment(file: File): Promise<PendingAttachment> {
  const id = uid("att");
  const path = fileNativePath(file);
  const base: PendingAttachment = {
    id,
    name: file.name,
    size: file.size,
    path,
  };
  if (file.size > ATTACH_FILE_MAX_BYTES) {
    return {
      ...base,
      note: `too large (${Math.round(file.size / 1024)} KB) — path only`,
    };
  }
  if (isImageFile(file)) {
    const dataBase64 = await fileToBase64(file);
    const mime =
      (file.type || "").toLowerCase() ||
      mimeFromName(file.name) ||
      "image/png";
    return {
      ...base,
      text: `[Immagine: ${file.name}]`,
      image: { mime, dataBase64 },
    };
  }
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const head = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.slice(0, 800),
    );
    if (!isProbablyText(file, head)) {
      return { ...base, note: "binary — path only" };
    }
    let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // Strip BOM
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.length > ATTACH_TEXT_MAX) {
      text =
        text.slice(0, ATTACH_TEXT_MAX) +
        `\n\n… [truncated, ${text.length - ATTACH_TEXT_MAX} more chars]`;
    }
    return { ...base, text };
  } catch (e) {
    return {
      ...base,
      note: e instanceof Error ? e.message : "could not read file",
    };
  }
}

/**
 * Tauri invoke() rejections are plain strings, not Error instances — the old
 * `e instanceof Error ? … : "fallback"` pattern silently dropped the real CLI
 * stderr (e.g. `invalid --thinking value 'xhigh'` from an outdated CLI).
 */
function errText(e: unknown, fallback: string): string {
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return fallback;
}

function buildPromptWithAttachments(
  userText: string,
  attachments: PendingAttachment[],
): string {
  if (attachments.length === 0) return userText;
  const blocks = attachments.map((a) => {
    const label = a.path || a.name;
    if (a.image) {
      // Emit @path so the CLI's atMentions loader turns it into a vision
      // content block; without a native path we only annotate the image.
      const tag = a.path ? `@${a.path}` : "";
      return `--- Image: ${label} (${a.image.mime}) ---\n${tag}`;
    }
    if (a.text != null && a.text.length > 0) {
      return `--- File: ${label} ---\n${a.text}\n--- End file ---`;
    }
    const extra = a.note ? ` (${a.note})` : "";
    return `--- File: ${label}${extra} ---`;
  });
  return `${userText.trim()}\n\n[Attached files]\n${blocks.join("\n\n")}`;
}

const LS_DEFAULTS = "zelari-desktop-defaults-v1";
const LS_THEME = "zelari-desktop-theme-v1";

type UiTheme = "dark" | "light";

function loadTheme(): UiTheme {
  try {
    const t = localStorage.getItem(LS_THEME);
    if (t === "light" || t === "dark") return t;
  } catch {
    /* ignore */
  }
  return "dark";
}

function saveTheme(theme: UiTheme) {
  try {
    localStorage.setItem(LS_THEME, theme);
  } catch {
    /* ignore */
  }
}

function uid(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFromPrompt(prompt: string): string {
  const t = stripGauntletLoop(prompt).trim().replace(/\s+/g, " ");
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
 * Multi-turn history for headless runs — derived from the chat UI.
 *
 * The chat transcript is the source of truth (2.1 T9: the CLI history_snapshot
 * event was removed — the spine via --resume and the chat UI carry the
 * multi-turn context).
 *
 * Keep user + assistant only. Long assistant bodies keep the TAIL (plan
 * summaries / synthesis usually sit at the end). Excludes the user message
 * about to be sent (already the task).
 */
function deriveHistoryFromChat(
  messages: ChatMessage[],
  currentPrompt: string,
): AgentMessageLite[] {
  const out: AgentMessageLite[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    let content = (m.content ?? "").trim();
    if (!content) continue;
    // Skip pure thinking-only empty streams
    if (m.role === "assistant" && content.length < 8) continue;
    // Prefer end of long plans (synthesis / confirmation Q live there)
    if (content.length > 12_000) {
      content = `…${content.slice(-(12_000 - 1))}`;
    }
    out.push({
      role: m.role,
      content,
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
  return out.slice(-16);
}

function loadDefaults(): { mode: DispatchMode; phase: WorkPhase } {
  try {
    const raw = localStorage.getItem(LS_DEFAULTS);
    if (!raw) return { mode: "kraken", phase: "build" };
    const p = JSON.parse(raw) as { mode?: string; phase?: string };
    const mode =
      p.mode === "council" || p.mode === "zelari" || p.mode === "kraken"
        ? p.mode
        : "kraken";
    const phase = p.phase === "plan" ? "plan" : "build";
    return { mode, phase };
  } catch {
    return { mode: "kraken", phase: "build" };
  }
}

function saveDefaults(mode: DispatchMode, phase: WorkPhase) {
  try {
    localStorage.setItem(LS_DEFAULTS, JSON.stringify({ mode, phase }));
  } catch {
    /* ignore */
  }
}

function loadPrefs(): DesktopPrefs {
  return loadDesktopPrefs();
}

function newConversation(
  mode: DispatchMode,
  phase: WorkPhase,
  provider?: string,
  model?: string,
  cwd?: string,
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
    cwd: cwd || undefined,
    archived: false,
  };
}

interface TurnCtx {
  assistantId: string | null;
  member: { name?: string; id?: string };
  tokens: { prompt: number; completion: number; total: number };
  startedAt: number;
  toolCount: number;
  hasAssistantText: boolean;
  pendingToolNames: Map<string, string>;
}

/** Kraken selection card state: live progress + end-of-turn metrics. */
interface KrakenCardState {
  progress?: KrakenProgressView;
  metrics?: KrakenMetricsView;
}

interface VerificationCardState {
  run?: VerificationRunView;
}

export default function App() {
  const defaults = useMemo(() => loadDefaults(), []);
  const [view, setView] = useState<AppView>("chat");
  const [theme, setTheme] = useState<UiTheme>(() => loadTheme());
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
  /** Per-conversation live run UI (M2 multiplexing), keyed by conversation. */
  const [liveToolLabelByConv, setLiveToolLabelByConv] = useState<
    Record<string, string | null>
  >({});
  const [liveStepsByConv, setLiveStepsByConv] = useState<
    Record<string, LiveToolStep[]>
  >({});
  /** Kraken selection card (kraken_progress / kraken_metrics), per conv. */
  const [krakenCardByConv, setKrakenCardByConv] = useState<
    Record<string, KrakenCardState>
  >({});
  const [verificationByConv, setVerificationByConv] = useState<
    Record<string, VerificationCardState>
  >({});
  const [gauntletByConv, setGauntletByConv] = useState<
    Record<string, GauntletProgressView | undefined>
  >({});
  const [reasoningByConv, setReasoningByConv] = useState<
    Record<string, boolean>
  >({});
  const [prefs, setPrefs] = useState<DesktopPrefs>(() => loadPrefs());
  const [liveMemberNameByConv, setLiveMemberNameByConv] = useState<
    Record<string, string | null>
  >({});
  const [mode, setMode] = useState<DispatchMode>(defaults.mode);
  const [phase, setPhase] = useState<WorkPhase>(defaults.phase);
  const [krakenGraph, setKrakenGraph] = useState(false);

  const setGauntletLoop = useCallback((value: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, gauntletLoop: value };
      saveDesktopPrefs(next);
      return next;
    });
    if (value) setKrakenGraph(false);
  }, []);
  const setGraphMode = useCallback((value: boolean) => {
    setKrakenGraph(value);
    if (value) {
      setPrefs((prev) => {
        if (!prev.gauntletLoop) return prev;
        const next = { ...prev, gauntletLoop: false };
        saveDesktopPrefs(next);
        return next;
      });
    }
  }, []);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [config, setConfig] = useState<DesktopConfig | null>(null);
  const [statusLine, setStatusLine] = useState("Connecting…");
  // Last opened workspace (persisted). Since M1 the effective folder is
  // per-conversation (Conversation.cwd); this remains the default for new
  // chats and the legacy migration source. Null = inherit process cwd.
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
  /** Optional plugins (Playwright, etc.) missing in the current workdir. */
  const [pluginRows, setPluginRows] = useState<PluginStatusRow[]>([]);
  const [pluginBannerDismissed, setPluginBannerDismissed] = useState(false);
  const [installingPluginId, setInstallingPluginId] = useState<string | null>(
    null,
  );
  /** Last failed plugin install — real npm error + output, shown in banner. */
  const [pluginError, setPluginError] = useState<PluginInstallError | null>(
    null,
  );
  /** Live tool activity line (no per-tool cards in the stream). */
  /** Session tasks live on each Conversation (sessionTasks, liveTasks module). */
  /** Plan id captured from the last `--plan-only` run; the next "build" phase
   * in Kraken graph mode executes it via `--run-plan`. */
  const [krakenPlanId, setKrakenPlanId] = useState<string | null>(null);
  /**
   * After assistant_text_loop, offer a one-click tool-only resume prompt.
   * Cleared when the user sends anything or starts a new chat.
   */
  const [textLoopRecovery, setTextLoopRecovery] = useState(false);

  /** When true, chat auto-scrolls with the stream; user scroll-up detaches. */
  const [followStream, setFollowStream] = useState(true);
  const followStreamRef = useRef(true);
  followStreamRef.current = followStream;
  /** Ignore scroll events caused by programmatic stick-to-bottom. */
  const programmaticScrollRef = useRef(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  /** @-mention autocomplete (path after @). */
  const [mention, setMention] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionHits, setMentionHits] = useState<WorkspaceHit[]>([]);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  /** When set, next send expands this skill around the user draft. */
  const [pendingSkill, setPendingSkill] = useState<SkillEntryDto | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** Per-conversation turn context (M2): replaces the single-run refs so
   * concurrent background runs cannot contaminate each other's stats. */
  const turnsRef = useRef<Map<string, TurnCtx>>(new Map());
  const turnFor = (convId: string): TurnCtx => {
    let t = turnsRef.current.get(convId);
    if (!t) {
      t = {
        assistantId: null,
        member: {},
        tokens: { prompt: 0, completion: 0, total: 0 },
        startedAt: 0,
        toolCount: 0,
        hasAssistantText: false,
        pendingToolNames: new Map(),
      };
      turnsRef.current.set(convId, t);
    }
    return t;
  };
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const toolLabelTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const modeRef = useRef(mode);
  const phaseRef = useRef(phase);
  modeRef.current = mode;
  phaseRef.current = phase;


  // Persist chats
  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  // Theme: persist + sync color-scheme for native form controls
  useEffect(() => {
    saveTheme(theme);
    document.documentElement.style.colorScheme = theme;
    document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
  }, [theme]);

  const onThemeChange = useCallback((next: UiTheme) => {
    setTheme(next);
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

  /** Workspace of the active conversation (per-chat cwd, M1). */
  const activeCwd = active?.cwd ?? null;
  /** Session tasks of the active conversation (todo_write mirror). */
  const sessionTasks = active?.sessionTasks ?? [];
  /**
   * Workspace project tasks per cwd (`.zelari/plan.json`, ADR-0018).
   * Keyed by normalized cwd so every conversation on the same workspace
   * shares the same project list. Runtime-only: never persisted.
   */
  const [workspaceTasksByCwd, setWorkspaceTasksByCwd] = useState<
    Record<string, LiveTask[]>
  >({});
  const projectTasks = activeCwd
    ? workspaceTasksByCwd[normalizeCwdKey(activeCwd)] ?? []
    : [];
  /** Re-read plan.json of a workspace (initial load + reconciliation). */
  const reloadWorkspaceTasks = useCallback(async (cwd: string) => {
    const tasks = await loadWorkspaceTasks(cwd);
    setWorkspaceTasksByCwd((prev) =>
      applyWorkspaceSnapshot(prev, normalizeCwdKey(cwd), tasks),
    );
  }, []);
  // M3: surface project tasks of the open workspace immediately and on
  // every workspace switch (repo with plan.json -> tasks shown with no
  // run in flight; app restart -> re-read from plan.json).
  useEffect(() => {
    if (!activeCwd) return;
    void reloadWorkspaceTasks(activeCwd);
  }, [activeCwd, reloadWorkspaceTasks]);
  // Stale-snapshot guard: `.zelari/plan.json` can change while the
  // window is unfocused (CLI council runs, manual normalizations).
  // Re-read the active workspace plan on focus so the Project panel
  // never lags behind the file on disk.
  useEffect(() => {
    const onFocus = () => {
      if (activeCwd) void reloadWorkspaceTasks(activeCwd);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeCwd, reloadWorkspaceTasks]);

  /** Run registry: multiplexed runs across conversations (M2). */
  const runCoordinator = useRunCoordinator();
  /** Composer/Stop state is per-conversation now, never global. */
  const running = runCoordinator.isRunning(active?.id ?? "");
  const liveToolLabel = liveToolLabelByConv[active?.id ?? ""] ?? null;
  const liveSteps = liveStepsByConv[active?.id ?? ""] ?? [];
  const krakenCard = krakenCardByConv[active?.id ?? ""];
  const liveMemberName = liveMemberNameByConv[active?.id ?? ""] ?? null;
  const runningRef = useRef(running);
  runningRef.current = running;

  const setLiveToolLabelFor = useCallback(
    (convId: string, v: string | null) => {
      setLiveToolLabelByConv((prev) => ({ ...prev, [convId]: v }));
    },
    [],
  );
  const setLiveStepsFor = useCallback(
    (
      convId: string,
      updater:
        | LiveToolStep[]
        | ((prev: LiveToolStep[]) => LiveToolStep[]),
    ) => {
      setLiveStepsByConv((prev) => ({
        ...prev,
        [convId]:
          typeof updater === "function"
            ? updater(prev[convId] ?? [])
            : updater,
      }));
    },
    [],
  );
  const setLiveMemberNameFor = useCallback(
    (convId: string, v: string | null) => {
      setLiveMemberNameByConv((prev) => ({ ...prev, [convId]: v }));
    },
    [],
  );
  const clearToolLabelTimer = useCallback((convId: string) => {
    const t = toolLabelTimersRef.current.get(convId);
    if (t) {
      clearTimeout(t);
      toolLabelTimersRef.current.delete(convId);
    }
  }, []);

  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => loadCollapsedSet(SESSION_FOLDERS_STORAGE_KEY),
  );

  const visibleSessions = useMemo(() => {
    return conversations.filter((c) =>
      sessionFilter === "archived" ? c.archived : !c.archived,
    );
  }, [conversations, sessionFilter]);

  const sessionGroups = useMemo(
    () => groupSessionsByFolder(visibleSessions),
    [visibleSessions],
  );

  const toggleSessionFolder = useCallback((key: string) => {
    setCollapsedFolders((prev) => {
      const next = toggleCollapsedKey(prev, key);
      persistCollapsedSet(SESSION_FOLDERS_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const unseenByConv = useMemo(
    () => unseenResultsByConversation(runCoordinator.state),
    [runCoordinator.state],
  );

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
        errText(e, "Failed to query CLI status"),
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
        errText(e, "Failed to load provider config"),
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
              `CLI is v${r.installed} (npm ${r.channel ?? "latest"} v${r.npmLatest}) — Settings → Updates`,
            );
          }
        } catch {
          /* offline */
        }
      })();
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  const NEAR_BOTTOM_PX = 96;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    // Clear flag after layout settles (smooth needs a longer grace)
    window.setTimeout(
      () => {
        programmaticScrollRef.current = false;
      },
      behavior === "smooth" ? 400 : 50,
    );
  }, []);

  const reattachStream = useCallback(() => {
    setFollowStream(true);
    followStreamRef.current = true;
    // Double rAF so DOM (new deltas / accordions) is painted first
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToBottom("smooth"));
    });
  }, [scrollToBottom]);

  // Content fingerprint so every streaming delta re-triggers stick-to-bottom
  const streamTick = useMemo(() => {
    const msgs = active?.messages ?? [];
    let n = 0;
    let chars = 0;
    for (const m of msgs) {
      if (m.role === "tool") continue;
      n += 1;
      chars += m.content?.length ?? 0;
      if (m.streaming) chars += 1;
    }
    return `${n}:${chars}:${running ? 1 : 0}:${liveToolLabel ?? ""}:${liveMemberName ?? ""}`;
  }, [active?.messages, running, liveToolLabel, liveMemberName]);

  // Stick to bottom only while following the stream
  useEffect(() => {
    if (!followStream) return;
    scrollToBottom("auto");
  }, [streamTick, followStream, scrollToBottom]);

  // ResizeObserver: keep pinned when accordion/body height grows mid-stream
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followStream) return;
    const ro = new ResizeObserver(() => {
      if (!followStreamRef.current) return;
      scrollToBottom("auto");
    });
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [followStream, scrollToBottom, activeId]);

  // User scroll / wheel: detach when leaving bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (programmaticScrollRef.current) return;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance > NEAR_BOTTOM_PX) {
        if (followStreamRef.current) {
          setFollowStream(false);
          followStreamRef.current = false;
        }
      }
      // Do not auto re-attach on scroll-to-bottom: only the button does.
      // (avoids fighting the user while they skim near the end)
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && followStreamRef.current) {
        // Explicit scroll up → detach immediately
        setFollowStream(false);
        followStreamRef.current = false;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  // New chat: always re-follow
  useEffect(() => {
    setFollowStream(true);
    followStreamRef.current = true;
  }, [activeId]);

  const speech = useSpeechToText({
    disabled: running,
    onFinal: (piece) => {
      setDraft((prev) => (prev ? `${prev.trimEnd()} ${piece}` : piece));
    },
  });

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const u1 = await onAgentEvent((ev) => {
        if (cancelled) return;
        // M2 invariant: run events carry their own conversation identity;
        // activeIdRef is only a legacy fallback for un-enveloped events.
        const convId =
          readRunEnvelope(ev).conversationId ?? activeIdRef.current;
        // M3 (ADR-0018): first-class workspace task events route by the
        // run envelope's cwd - never by the currently open chat - so a
        // task_update of a background run never contaminates another
        // workspace's panel.
        if (ev.type === "task_update" || ev.type === "task_snapshot") {
          const taskEv = ev as {
            source?: unknown;
            task?: unknown;
            tasks?: unknown;
          };
          if (taskEv.source === "workspace_plan") {
            const envCwd =
              readRunEnvelope(ev).cwd ??
              conversationsRef.current.find((c) => c.id === convId)?.cwd;
            if (envCwd) {
              const cwdKey = normalizeCwdKey(envCwd);
              if (ev.type === "task_update") {
                const live = taskEv.task
                  ? brainTaskToLive(taskEv.task)
                  : null;
                if (live) {
                  setWorkspaceTasksByCwd((prev) =>
                    applyWorkspaceUpdate(prev, cwdKey, live),
                  );
                }
              } else if (Array.isArray(taskEv.tasks)) {
                const lives = (taskEv.tasks as unknown[])
                  .map((t) => brainTaskToLive(t))
                  .filter((t): t is LiveTask => t !== null);
                setWorkspaceTasksByCwd((prev) =>
                  applyWorkspaceSnapshot(prev, cwdKey, lives),
                );
              }
            }
          }
          return;
        }
        const turn = turnFor(convId);
        const setStatusLineIfActive = (s: string) => {
          if (convId === activeIdRef.current) setStatusLine(s);
        };

        if (ev.type === "log") {
          const msg =
            typeof (ev as { message?: string }).message === "string"
              ? (ev as { message: string }).message
              : "";
          if (msg) setStatusLineIfActive(msg.replace(/^\[.*?\]\s*/, "").slice(0, 140));
          // Capture the plan id emitted by `--plan-only` so the next build
          // phase can re-run it via `--run-plan`.
          const planIdMatch = /plan_only_id=([0-9a-f-]+)/i.exec(msg);
          if (planIdMatch) setKrakenPlanId(planIdMatch[1]);
          // Do not surface routine headless bootstrap lines in the chat UI
          // (mode/phase/provider line, MCP registration count, etc.).
          const hideFromChat =
            /^\[headless\]\s*mode=/i.test(msg) ||
            /^\[headless\]\s*MCP tools:/i.test(msg) ||
            /^\[headless\]\s*MCP tools\s*:/i.test(msg);
          if (
            !hideFromChat &&
            (msg.startsWith("[zelari]") || msg.startsWith("[headless]"))
          ) {
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

        // v1.10.0: collect rolling history for the next runTask. Prefer
        // user/assistant pairs only (tool tails blow the budget and caused
        // plan→build amnesia). Merge with chat-derived when richer.
        // E1.4: capture the 2.0 spine session id emitted at run start; the
        // next runTask resumes the same event log (--resume) so multi-turn
        // context comes from the spine instead of the 1.x history replay.
        if (ev.type === "session_started") {
          const sid = (ev as { sessionId?: string }).sessionId;
          if (sid && sid.trim().length > 0) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId && c.sessionId !== sid
                  ? { ...c, sessionId: sid }
                  : c,
              ),
            );
          }
          return;
        }

        /** True if a/b refer to the same council member (id preferred, else name). */
        const isSameMember = (
          a: { name?: string; id?: string },
          b: { name?: string; id?: string },
        ) => {
          if (a.id && b.id) return a.id === b.id;
          if (a.name && b.name)
            return a.name.localeCompare(b.name, undefined, {
              sensitivity: "accent",
            }) === 0;
          // Only one side known → cannot prove switch; treat as same only if both empty
          if (!a.id && !a.name && !b.id && !b.name) return true;
          // One known, other empty → keep current bubble (tools mid-turn)
          if ((!a.id && !a.name) || (!b.id && !b.name)) return true;
          return false;
        };

        const switchToMember = (next: {
          name?: string;
          id?: string;
        }) => {
          const prev = turn.member;
          const hasNext = Boolean(next.name || next.id);
          if (!hasNext) return;
          const changed =
            Boolean(prev.name || prev.id) && !isSameMember(prev, next);
          turn.member = {
            name: next.name ?? prev.name,
            id: next.id ?? prev.id,
          };
          if (next.name) {
            setLiveMemberNameFor(convId, next.name);
            setStatusLineIfActive(`${next.name} speaking…`);
          }
          if (changed) {
            const prevAid = turn.assistantId;
            if (prevAid) {
              setConversations((prevC) =>
                prevC.map((c) =>
                  c.id !== convId
                    ? c
                    : {
                        ...c,
                        messages: c.messages.map((m) =>
                          m.id === prevAid
                            ? { ...m, streaming: false }
                            : m,
                        ),
                      },
                ),
              );
            }
            // Force a new accordion for the new member
            turn.assistantId = null;
          }
        };

        if (ev.type === "agent_start") {
          const anyEv = ev as {
            memberName?: string;
            memberId?: string;
          };
          if (anyEv.memberName || anyEv.memberId) {
            switchToMember({
              name: anyEv.memberName,
              id: anyEv.memberId,
            });
          }
          return;
        }

        if (ev.type === "message_start") {
          const anyEv = ev as { memberName?: string; memberId?: string };
          // Only switch on *explicit* member fields — never invent from prev
          if (anyEv.memberName || anyEv.memberId) {
            switchToMember({
              name: anyEv.memberName,
              id: anyEv.memberId,
            });
          }
          return;
        }

        if (ev.type === "member_cost") {
          const cost = (ev as {
            cost?: {
              name?: string;
              id?: string;
              promptTokens?: number;
              completionTokens?: number;
              totalTokens?: number;
            };
          }).cost;
          if (cost) {
            if (cost.name || cost.id) {
              switchToMember({ name: cost.name, id: cost.id });
            }
            turn.tokens.prompt += cost.promptTokens ?? 0;
            turn.tokens.completion += cost.completionTokens ?? 0;
            turn.tokens.total += cost.totalTokens ?? 0;
            const who = cost.name ?? "member";
            const tok = cost.totalTokens ?? 0;
            if (tok > 0) {
              setStatusLineIfActive(
                `${who} · ${tok.toLocaleString()} tokens (turn ${turn.tokens.total.toLocaleString()})`,
              );
            }
          }
          return;
        }

        // Proprietary CoT: never surface thinking_delta body. Use it only as
        // a heartbeat so the spinner can say "Reasoning · 2m 14s".
        if (ev.type === "thinking_delta") {
          setReasoningByConv((prev) =>
            prev[convId] ? prev : { ...prev, [convId]: true },
          );
          return;
        }
        if (ev.type === "gauntlet_progress") {
          const progress = readGauntletProgress(ev);
          if (progress) {
            setGauntletByConv((prev) => ({ ...prev, [convId]: progress }));
            setStatusLineIfActive(
              `gauntlet · ${progress.phase} · ${progress.pieceLabel} · r${progress.round}/${progress.maxRounds}`,
            );
          }
          return;
        }

        if (ev.type === "message_delta") {
          const delta = extractDelta(ev);
          if (!delta) return;
          turn.hasAssistantText = true;
          const evMember = ev as {
            memberName?: string;
            memberId?: string;
          };
          // Prefer event attribution; fall back to active member from agent_start
          if (evMember.memberName || evMember.memberId) {
            switchToMember({
              name: evMember.memberName,
              id: evMember.memberId,
            });
          }
          const memberName =
            evMember.memberName ?? turn.member.name;
          const memberId = evMember.memberId ?? turn.member.id;
          if (memberName) setLiveMemberNameFor(convId, memberName);
          // Text is streaming — clear tool line so member focus shows.
          clearToolLabelTimer(convId);
          setLiveToolLabelFor(convId, null);

          const matchesMember = (m: ChatMessage) => {
            if (m.role !== "assistant") return false;
            return isSameMember(
              { name: m.memberName, id: m.memberId },
              { name: memberName, id: memberId },
            );
          };

          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              const messages = [...c.messages];
              let aid: string | null = turn.assistantId;
              const open = aid ? messages.find((m) => m.id === aid) : undefined;

              // Open bubble is a different member → close it for a new card
              if (open && !matchesMember(open)) {
                aid = null;
                turn.assistantId = null;
              }

              // Resume only the *current turn* assistant card:
              // - ref still points at this turn's bubble, or
              // - the latest non-tool message is still that assistant
              //   (multi-part stream / after tools — no user msg after it).
              // Never append onto an older reply after a new user message.
              if (!aid || !messages.some((m) => m.id === aid)) {
                const last = [...messages]
                  .reverse()
                  .find((m) => m.role !== "tool");
                if (
                  last?.role === "assistant" &&
                  matchesMember(last)
                ) {
                  aid = last.id;
                  turn.assistantId = aid;
                } else {
                  aid = uid("asst");
                  turn.assistantId = aid;
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
              }

              return {
                ...c,
                updatedAt: Date.now(),
                messages: messages.map((m) =>
                  m.id === aid
                    ? {
                        ...m,
                        // Keep raw stream while live — scrub only closed tool
                        // blocks so unclosed tags cannot delete later prose.
                        content: scrubDisplayText(m.content + delta, {
                          streaming: true,
                        }),
                        streaming: true,
                        memberName: memberName ?? m.memberName,
                        memberId: memberId ?? m.memberId,
                      }
                    : m,
                ),
              };
            }),
          );
          return;
        }

        if (ev.type === "kraken_progress") {
          const p = readKrakenProgress(ev);
          if (p) {
            setKrakenCardByConv((prev) => ({
              ...prev,
              [convId]: { ...(prev[convId] ?? {}), progress: p },
            }));
          }
          return;
        }
        if (ev.type === "kraken_metrics") {
          const m = readKrakenMetrics(ev);
          if (m) {
            setKrakenCardByConv((prev) => ({
              ...prev,
              [convId]: { ...(prev[convId] ?? {}), metrics: m },
            }));
          }
          return;
        }
        if (ev.type === "verification_run") {
          const run = readVerificationRun(ev);
          if (run) {
            setVerificationByConv((prev) => ({
              ...prev,
              [convId]: { run },
            }));
          }
          return;
        }

        if (ev.type === "message_end" || ev.type === "agent_end") {
          const aid = turn.assistantId;
          const usage =
            ev.type === "message_end"
              ? (ev as { usage?: {
                  promptTokens?: number;
                  completionTokens?: number;
                  totalTokens?: number;
                } }).usage
              : undefined;
          if (usage) {
            turn.tokens.prompt += usage.promptTokens ?? 0;
            turn.tokens.completion += usage.completionTokens ?? 0;
            turn.tokens.total +=
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
                        // Final scrub: drop trailing unclosed tool scaffolding
                        content: scrubDisplayText(m.content, {
                          streaming: false,
                        }),
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
          const callId = extractToolCallId(ev) ?? `anon-${turn.toolCount}`;
          const anyEv = ev as { args?: Record<string, unknown> };
          const toolSummary = summarizeToolArgs(name, anyEv.args);
          turn.toolCount += 1;
          turn.pendingToolNames.set(callId, name);
          // Do not append tool cards — rotate a single live activity line
          // plus a persistent this-turn step list.
          clearToolLabelTimer(convId);
          setLiveToolLabelFor(convId, friendlyToolLabel(name, toolSummary));
          setLiveStepsFor(convId, (prev) => [
            ...prev,
            { id: callId, name, summary: toolSummary, status: "running" },
          ]);
          // todo_write args already carry the list — paint it immediately.
          if (name === "todo_write") {
            const parsed = parseTodosFromUnknown(anyEv.args);
            if (parsed) {
              const merge = anyEv.args?.merge === true;
              setConversations((prev) =>
                applySessionTasks(prev, convId, (prevTasks) =>
                  merge
                    ? mergeSessionTasks(prevTasks, toSessionTasks(parsed))
                    : toSessionTasks(parsed),
                ),
              );
            }
          }
          return;
        }

        if (ev.type === "tool_execution_end") {
          const callId = extractToolCallId(ev);
          const endName =
            (callId && turn.pendingToolNames.get(callId)) ||
            extractToolName(ev);
          if (callId) turn.pendingToolNames.delete(callId);
          // Brief hold, then fade back to thinking phrases.
          clearToolLabelTimer(convId);
          toolLabelTimersRef.current.set(
            convId,
            setTimeout(() => {
              setLiveToolLabelFor(convId, null);
              toolLabelTimersRef.current.delete(convId);
            }, 900),
          );
          const isErr = !!(ev as { isError?: boolean }).isError;
          setLiveStepsFor(convId, (prev) =>
            prev.map((s) =>
              callId && s.id === callId
                ? { ...s, status: isErr ? "error" : "done" }
                : s,
            ),
          );
          // End events omit toolName — look it up from the start event.
          // The in-process CLI todo store is not shared across Desktop's
          // per-message CLI spawns, so we mirror from the tool payload.
          if (
            (endName === "todo_write" || endName === "todo_read") &&
            !isErr
          ) {
            const raw =
              typeof (ev as { result?: unknown }).result === "string"
                ? (ev as { result: string }).result
                : extractToolResult(ev) || (ev as { result?: unknown }).result;
            const parsed = parseTodosFromUnknown(raw);
            if (parsed) {
              setConversations((prev) =>
                applySessionTasks(prev, convId, toSessionTasks(parsed)),
              );
            }
          }
          return;
        }

        if (ev.type === "error") {
          const msg =
            (typeof ev.message === "string" && ev.message) ||
            (typeof (ev as { error?: string }).error === "string" &&
              (ev as { error?: string }).error) ||
            "Unknown error";
          const code =
            typeof (ev as { code?: string }).code === "string"
              ? (ev as { code?: string }).code
              : undefined;
          if (code === "assistant_text_loop") {
            setTextLoopRecovery(true);
            setStatusLineIfActive(
              "Text loop stopped — use “Continue with tools” (inspect disk → one write).",
            );
          }
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
                        content:
                          code === "assistant_text_loop"
                            ? `${msg}\n\n→ Click “Continue with tools” below, or send a short tool-only request (list_files → one write_file).`
                            : msg,
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

      const u2 = await onAgentStderr((payload) => {
        if (cancelled) return;
        const convId = payload.conversationId ?? activeIdRef.current;
        if (
          convId === activeIdRef.current &&
          /error|fail|missing|no api key/i.test(payload.line)
        ) {
          setStatusLine(payload.line);
        }
      });
      if (cancelled) u2();
      else unsubs.push(u2);

      const u3 = await onRunFinished((payload) => {
        if (cancelled) return;
        const { exitCode, cancelled: wasCancelled } = payload;
        const convId = payload.conversationId ?? activeIdRef.current;
        const turn = turnsRef.current.get(convId) ?? turnFor(convId);
        const isActiveConv = convId === activeIdRef.current;
        runCoordinator.finished(
          { ...payload, conversationId: convId },
          activeIdRef.current,
        );
        // M3: plan.json is the source of truth once the run settles -
        // re-read it to reconcile optimistic task updates (ADR-0018).
        if (payload.cwd) void reloadWorkspaceTasks(payload.cwd);
        setLiveToolLabelFor(convId, null);
        setLiveMemberNameFor(convId, null);
        clearToolLabelTimer(convId);
        const durationMs = Date.now() - (turn.startedAt || Date.now());
        const tools = turn.toolCount;
        const tokens = turn.tokens;
        const aid = turn.assistantId;
        turn.assistantId = null;
        turn.member = {};

        // Attach light stats to last assistant message
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== convId) return c;
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
                      content: scrubDisplayText(m.content, {
                        streaming: false,
                      }),
                      stats: {
                        ...m.stats,
                        durationMs,
                        toolCount: tools,
                        charCount: scrubDisplayText(m.content, {
                          streaming: false,
                        }).length,
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
        if (wasCancelled && isActiveConv) setStatusLine("Run cancelled");
        else if (exitCode === 0) {
          // Detect incomplete-looking finals (many tools, little clean prose)
          const lastAsst = [...(conversationsRef.current.find(
            (x) => x.id === convId,
          )?.messages ?? [])]
            .reverse()
            .find((m) => m.role === "assistant");
          const cleanLen = scrubDisplayText(lastAsst?.content ?? "", {
            streaming: false,
          }).length;
          const thin =
            tools >= 12 && cleanLen > 0 && cleanLen < 400;
          if (isActiveConv) {
            setStatusLine(
              thin
                ? `Completed · ${(durationMs / 1000).toFixed(1)}s · ${tools} tools${tokPart} · reply looks thin — try “continue”`
                : `Completed · ${(durationMs / 1000).toFixed(1)}s · ${tools} tools${tokPart}`,
            );
          }
        } else if (isActiveConv) {
          setStatusLine(`Finished with exit code ${exitCode}${tokPart}`);
        }
        setGitRefreshKey((k) => k + 1);
        void refreshCli();
        turnsRef.current.delete(convId);
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

  const refreshPlugins = useCallback(async () => {
    try {
      const snap = await getPluginsStatus(activeCwd ?? undefined);
      setPluginRows(
        (snap.plugins ?? []).map((p) => ({
          id: p.id,
          label: p.label,
          present: p.present,
          description: p.description,
          postInstallHint: p.postInstallHint,
        })),
      );
    } catch {
      // Older CLI without --plugins-status — ignore silently.
      setPluginRows([]);
    }
  }, [activeCwd]);

  useEffect(() => {
    setPluginBannerDismissed(false);
    void refreshPlugins();
  }, [activeCwd, refreshPlugins]);

  const onInstallPlugin = useCallback(
    async (id: string) => {
      setInstallingPluginId(id);
      setPluginError(null);
      setStatusLine(`Installing plugin ${id}…`);
      try {
        const res = await installPlugin(id, activeCwd ?? undefined);
        if (res.ok) {
          setStatusLine(
            res.message ||
              `Installed ${id}` +
                (res.postInstallHint ? ` — ${res.postInstallHint}` : ""),
          );
          await refreshPlugins();
        } else {
          const message = res.message || `Install failed for ${id}`;
          setStatusLine(message);
          setPluginError({ id, message, output: res.output });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setStatusLine(message);
        setPluginError({ id, message });
      } finally {
        setInstallingPluginId(null);
      }
    },
    [activeCwd, refreshPlugins],
  );

  const startNewChat = () => {
    setFollowStream(true);
    followStreamRef.current = true;
    const c = newConversation(
      mode,
      phase,
      provider,
      model,
      activeCwd ?? workdir ?? undefined,
    );
    setConversations((prev) => [c, ...prev]);
    setActiveId(c.id);
    setSessionFilter("active");
    setDraft("");
    setTextLoopRecovery(false);
    taRef.current?.focus();
  };

  /** User-facing recovery prompt after assistant_text_loop (keep in sync with core TEXT_LOOP_RECOVERY_USER_PROMPT). */
  const TEXT_LOOP_CONTINUE =
    "Continue from the text-loop stop. Inspect disk, apply at most one missing piece with tools if needed, " +
    "then either mark DONE with a short verify list OR give a brief resoconto and ask if I want you to continue. " +
    "No status theater, no full rewrite.";

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

  const onProviderChange = async (id: string) => {
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
    try {
      await setAppConfig({
        provider: id,
        ...(nextModel ? { model: nextModel } : {}),
      });
      await refreshConfig();
    } catch (e) {
      setStatusLine(
        errText(e, "Failed to persist provider"),
      );
    }
  };

  const onModelChange = async (id: string) => {
    setModel(id);
    setConversations((prev) =>
      prev.map((c) => (c.id === activeId ? { ...c, model: id } : c)),
    );
    if (!provider) return;
    try {
      await setAppConfig({ provider, model: id });
      await refreshConfig();
    } catch (e) {
      setStatusLine(
        errText(e, "Failed to persist model"),
      );
    }
  };

  const onThinkingChange = async (spec: string) => {
    if (!provider) return;
    setStatusLine(`Setting thinking effort for ${provider}…`);
    try {
      await setAppConfig({ provider, thinking: spec });
      await refreshConfig();
      setStatusLine(`Thinking effort: ${spec}`);
    } catch (e) {
      let msg = errText(e, "Failed to set thinking effort");
      if (/invalid --thinking/i.test(msg)) {
        msg +=
          " — installed CLI is older than the app. Update it (Settings → CLI package) or run: npm i -g zelari-code@latest";
      }
      setStatusLine(msg);
    }
  };

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f && f.size >= 0);
    if (list.length === 0) return;
    const next = await Promise.all(list.map((f) => readFileAsAttachment(f)));
    setAttachments((prev) => {
      const names = new Set(
        prev.map((p) => (p.path || p.name).toLowerCase()),
      );
      const merged = [...prev];
      for (const a of next) {
        const key = (a.path || a.name).toLowerCase();
        if (names.has(key)) continue;
        names.add(key);
        merged.push(a);
      }
      return merged.slice(0, 12);
    });
    setStatusLine(
      next.length === 1
        ? `Attached ${next[0].name}`
        : `Attached ${next.length} files`,
    );
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const attachWorkspacePath = useCallback(
    async (hit: WorkspaceHit) => {
      try {
        const res = await readProjectText({
          path: hit.absolute || hit.path,
          cwd: activeCwd,
        });
        const att: PendingAttachment = {
          id: uid("att"),
          name: hit.name || res.path.split("/").pop() || res.path,
          size: res.size || 0,
          path: res.absolute || hit.absolute,
          text: res.text ?? undefined,
          note: res.note ?? (res.isDir ? "directory" : undefined),
        };
        setAttachments((prev) => {
          const key = (att.path || att.name).toLowerCase();
          if (prev.some((p) => (p.path || p.name).toLowerCase() === key)) {
            return prev;
          }
          return [...prev, att].slice(0, 12);
        });
        setStatusLine(`Tagged ${res.path}`);
      } catch (e) {
        setStatusLine(e instanceof Error ? e.message : String(e));
      }
    },
    [activeCwd],
  );

  const onPickMention = useCallback(
    (hit: WorkspaceHit) => {
      const ta = taRef.current;
      const caret = ta?.selectionStart ?? draft.length;
      const det = mention ?? detectMentionQuery(draft, caret);
      if (!det) return;
      const { text, caret: nextCaret } = applyMentionInsert(
        draft,
        det.start,
        caret,
        hit.path,
      );
      setDraft(text);
      setMention(null);
      void attachWorkspacePath(hit);
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [draft, mention, attachWorkspacePath],
  );

  const onDraftChange = useCallback(
    (value: string, caret?: number) => {
      setDraft(value);
      const c = caret ?? value.length;
      const det = detectMentionQuery(value, c);
      setMention(det);
      if (!det) setMentionIndex(0);
    },
    [],
  );

  const onSelectSkill = useCallback((skill: SkillEntryDto) => {
    setPendingSkill(skill);
    setStatusLine(`Skill selected: ${skill.id} — type a task and send`);
    taRef.current?.focus();
  }, []);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    if (e.dataTransfer?.types?.includes("Files")) setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setDragOver(false);
      if (running) return;
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) void addFiles(files);
    },
    [addFiles, running],
  );

  const send = async (text?: string) => {
    const convId = active.id;
    const turn = turnFor(convId);
    const fromSpeech = [draft, speech.interim].filter(Boolean).join(" ").trim();
    let base = (text ?? fromSpeech).trim();
    if ((!base && attachments.length === 0 && !pendingSkill) || running) return;
    speech.stop();
    setTextLoopRecovery(false);
    setMention(null);

    if (cli && !cli.ok) {
      setStatusLine(cli.message);
      return;
    }

    const skillForSend = pendingSkill;
    if (skillForSend) {
      base = expandDesktopSkill(skillForSend, base);
      setPendingSkill(null);
    }

    const userVisible =
      base ||
      (attachments.length === 1
        ? `Please review: ${attachments[0].name}`
        : `Please review the attached files (${attachments.length})`);
    // Full prompt (with file bodies) is stored so multi-turn history keeps context.
    // Gauntlet is a CLI flag, not a prompt append (P2).
    const prompt = buildPromptWithAttachments(userVisible, attachments);

    const userMsg: ChatMessage = {
      id: uid("user"),
      role: "user",
      content: prompt,
      createdAt: Date.now(),
    };

    turn.assistantId = null;
    turn.member = {};
    turn.hasAssistantText = false;
    turn.toolCount = 0;
    setLiveToolLabelFor(convId, null);
    setLiveStepsFor(convId, []);
    setKrakenCardByConv((prev) => ({ ...prev, [convId]: {} }));
    setVerificationByConv((prev) => ({ ...prev, [convId]: {} }));
    setGauntletByConv((prev) => ({ ...prev, [convId]: undefined }));
    setReasoningByConv((prev) => ({ ...prev, [convId]: false }));
    turn.pendingToolNames.clear();
    setLiveMemberNameFor(convId, null);
    setFollowStream(true);
    followStreamRef.current = true;
    turn.tokens = { prompt: 0, completion: 0, total: 0 };
    turn.startedAt = Date.now();
    setDraft("");
    setAttachments([]);
    runCoordinator.request(convId, activeCwd ?? undefined);
    setStatusLine(
      krakenGraph
        ? "kraken graph running…"
        : `${mode} · ${phase}${prefs.gauntletLoop ? " · gauntlet" : ""} running…`,
    );

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
      // Chat UI is the source of truth for multi-turn (survives phase plan→build
      // and mode swaps). Read from ref so we always see the latest transcript
      // even if this handler closed over a stale `active`.
      const live =
        conversationsRef.current.find((c) => c.id === activeIdRef.current) ??
        active;
      const fromChat = deriveHistoryFromChat(live?.messages ?? [], prompt);
      const fromSnap = (live?.history ?? []).filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim().length > 0,
      );
      const historyForRun =
        fromChat.length > 0 ? fromChat : fromSnap.slice(-16);

      // Kraken graph plan→build wiring: the plan phase writes the plan to
      // disk (`--plan-only`) and captures its id; the build phase re-runs it
      // (`--run-plan`). Non-graph modes ignore these flags on the CLI side.
      const planOnly = krakenGraph && phase === "plan";
      const runPlan =
        krakenGraph && phase === "build" ? (krakenPlanId ?? undefined) : undefined;
      if (planOnly) setKrakenPlanId(null);

      const runId = await runTask({
        prompt,
        mode,
        phase,
        provider: provider || undefined,
        model: model || undefined,
        cwd: activeCwd ?? undefined,
        conversationId: convId,
        // Replay rolling history so the headless agent/council keeps multi-turn
        // context (answers "procedi" / "sì" instead of amnesia).
        history: historyForRun,
        // E1.4: resume the conversation spine (--resume <id>); history
        // above stays as fallback for legacy chats and degraded spines.
        sessionId: live?.sessionId,

        todos: toTodoPayload(live?.sessionTasks ?? []),
        krakenGraph: krakenGraph || undefined,
        planOnly: planOnly || undefined,
        runPlan,
        profile: prefs.profile,
        strictDone: prefs.strictDone,
        missionStrict: prefs.missionStrict,
        verifyPack: prefs.verifyPack,
        verifierReview: prefs.verifierReview ?? undefined,
        bonAlpha: prefs.bonAlpha,
        gauntletLoop: prefs.gauntletLoop,
        krakenExploreModel: prefs.krakenExploreModel || undefined,
        krakenGeneralModel: prefs.krakenGeneralModel || undefined,
        krakenVerifyModel: prefs.krakenVerifyModel || undefined,
        krakenPlannerModel: prefs.krakenPlannerModel || undefined,
      });
      runCoordinator.started({
        runId,
        conversationId: convId,
        cwd: activeCwd ?? undefined,
      });
    } catch (e) {
      runCoordinator.dispatchFailed(convId);
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
    const rid = runCoordinator.state.runIdByConversation[active?.id ?? ""];
    if (!rid) return;
    try {
      await cancelRun({ runId: rid });
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
        void onStop();
        return;
      }
      if (mod && !e.shiftKey && e.code === "KeyN") {
        e.preventDefault();
        const c = newConversation(
          modeRef.current,
          phaseRef.current,
          provider,
          model,
          conversationsRef.current.find((x) => x.id === activeIdRef.current)
            ?.cwd,
        );
        setConversations((prev) => [c, ...prev]);
        setActiveId(c.id);
        setSessionFilter("active");
        setDraft("");
        taRef.current?.focus();
        return;
      }
      if (mod && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        e.stopPropagation();
        const order: DispatchMode[] = ["kraken", "council", "zelari"];
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
    if (mention) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) =>
          mentionHits.length ? (i + 1) % mentionHits.length : 0,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) =>
          mentionHits.length
            ? (i - 1 + mentionHits.length) % mentionHits.length
            : 0,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        const hit = mentionHits[mentionIndex];
        if (hit) {
          e.preventDefault();
          onPickMention(hit);
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const pickFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        // Persist as "last opened workspace" AND bind it to the active
        // conversation, so each chat keeps its own folder (M1).
        setWorkdir(selected);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeId
              ? { ...c, cwd: selected, updatedAt: Date.now() }
              : c,
          ),
        );
        setStatusLine(`Cartella: ${selected}`);
      }
    } catch (e) {
      setStatusLine(e instanceof Error ? e.message : String(e));
    }
  };

  const messages = active?.messages ?? [];
  const empty = messages.length === 0;

  const aurora = (
    <div className="aurora" aria-hidden>
      <div className="blob b1" />
      <div className="blob b2" />
      <div className="blob b3" />
      <div className="blob b4" />
      <div className="grain" />
    </div>
  );

  if (view === "settings") {
    return (
      <div
        className="app app-chrome app-settings"
        data-mode={mode}
        data-theme={theme}
      >
        {aurora}
        <TitleBar />
        <div className="app-settings-body">
          <SettingsView
            config={config}
            cli={cli}
            defaultMode={defaultMode}
            defaultPhase={defaultPhase}
            prefs={prefs}
            workdir={workdir}
            theme={theme}
            onThemeChange={onThemeChange}
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
              saveDesktopPrefs(args.prefs);
              setPrefs(args.prefs);
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
    <div
      className={`app app-chrome${dragOver ? " is-drag-over" : ""}`}
      data-mode={mode}
      data-theme={theme}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {aurora}
      <TitleBar />
      {dragOver && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-card glass-capsule">
            <div className="drop-overlay-title">Drop files to attach</div>
            <div className="drop-overlay-sub">
              Text is inlined into the next message · max{" "}
              {Math.round(ATTACH_FILE_MAX_BYTES / 1024)} KB each
            </div>
          </div>
        </div>
      )}
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
          {sessionGroups.map((g) => {
            const groupCollapsed = collapsedFolders.has(g.key);
            return (
              <div key={g.key} className="session-group">
                <button
                  type="button"
                  className="session-group-head"
                  title={g.path || undefined}
                  aria-expanded={!groupCollapsed}
                  onClick={() => toggleSessionFolder(g.key)}
                >
                  <span className="session-group-chevron" aria-hidden>
                    {groupCollapsed ? "▸" : "▾"}
                  </span>
                  <span className="session-group-name">{g.label}</span>
                  <span className="session-group-count">
                    {g.sessions.length}
                  </span>
                </button>
                {!groupCollapsed &&
                  g.sessions.map((c) => (
            <div
              key={c.id}
              className={`session-item-wrap${c.id === activeId ? " active" : ""}`}
            >
              <button
                type="button"
                className="session-item"
                onClick={() => {
                  runCoordinator.markSeen(c.id);
                  setActiveId(c.id);
                  setMode(c.mode);
                  setPhase(c.phase);
                  if (c.provider) setProvider(c.provider);
                  if (c.model) setModel(c.model);
                }}
              >
                <span className="session-title">{c.title}</span>
                {runCoordinator.isRunning(c.id) ? (
                  <span
                    className="session-run-badge"
                    title="Run in corso"
                    aria-label="Run in corso"
                  >
                    ●
                  </span>
                ) : unseenByConv[c.id] ? (
                  <span
                    className="session-run-badge is-done"
                    title="Run completata"
                    aria-label="Run completata"
                  >
                    ✓
                  </span>
                ) : (
                  <span className="session-bubble" aria-hidden>
                    💬
                  </span>
                )}
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
            );
          })}
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
        <header className="topbar glass-capsule">
          <div className="topbar-left">
            <div className="model-chip">
              <span
                className={`model-live-dot${cli?.ok ? " ok" : ""}`}
                aria-hidden
              />
              <ProviderModelBar
                config={config}
                provider={provider}
                model={model}
                disabled={running}
                onProviderChange={onProviderChange}
                onModelChange={onModelChange}
                onThinkingChange={onThinkingChange}
                onConfigRefresh={setConfig}
                onStatus={setStatusLine}
              />
            </div>
            <div className="topbar-title" title={active?.title ?? "Zelari"}>
              {active?.title ?? "Zelari"}
            </div>
            {sessionTasks.length > 0 ? (
              <span className="todo-chip" title="Session tasks from agent">
                {sessionTasks.filter((t) => t.status === "completed").length}/
                {sessionTasks.length} todos
              </span>
            ) : null}
          </div>
          <div className="topbar-right">
            <ModeToggle
              value={mode}
              disabled={running || krakenGraph}
              onChange={onModeChange}
            />
            <PhaseToggle
              value={phase}
              disabled={running}
              onChange={onPhaseChange}
            />
            <KrakenGraphToggle
              value={krakenGraph}
              disabled={running}
              onChange={setGraphMode}
            />
            <GauntletToggle
              value={prefs.gauntletLoop}
              disabled={running}
              onChange={setGauntletLoop}
            />

            <button
              type="button"
              className="btn-ghost topbar-folder"
              onClick={() => void pickFolder()}
              title={
                activeCwd
                  ? `${activeCwd} — click per cambiare cartella`
                  : "Apri una cartella di lavoro"
              }
            >
              📁 {activeCwd ? activeCwd.replace(/.*[\\/]/, "") : "Folder"}
            </button>
          </div>
        </header>

        <div className="chat-scroll-shell">
          {sessionTasks.length > 0 || projectTasks.length > 0 ? (
            <LiveTasksPanel
              tasks={sessionTasks}
              projectTasks={projectTasks}
              onClear={() =>
                setConversations((prev) => clearSessionTasks(prev, active.id))
              }
            />
          ) : null}
          <div className="chat-scroll" ref={scrollRef}>
            {!pluginBannerDismissed &&
              (pluginRows.some((p) => !p.present) || pluginError) && (
                <div className="chat-inner" style={{ paddingBottom: 0 }}>
                  <PluginInstallBanner
                    plugins={pluginRows}
                    installingId={installingPluginId}
                    onInstall={(id) => void onInstallPlugin(id)}
                    onDismiss={() => setPluginBannerDismissed(true)}
                    error={pluginError}
                    onClearError={() => setPluginError(null)}
                  />
                </div>
              )}
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
                  {SUGGESTIONS.map((s, i) => (
                    <button
                      key={s}
                      type="button"
                      className="suggestion"
                      onClick={() => void send(s)}
                      disabled={running || (cli !== null && !cli.ok)}
                    >
                      <span className="suggestion-icon" aria-hidden>
                        {SUGGESTION_ICONS[i] ?? "✦"}
                      </span>
                      <span className="suggestion-text">{s}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chat-inner">
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
                    m.role === "assistant" ? (
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
                              m.streaming &&
                              m.meta === "thinking" &&
                              !m.content.trim()
                            }
                            clarificationDisabled={running}
                            onClarificationChoose={(choice) => {
                              if (running) return;
                              void send(choice);
                            }}
                          />
                        </ReplyAccordion>
                      </div>
                    ) : (
                      <div key={m.id} className={`message ${m.role}`}>
                        {m.role === "user" ? (
                          <>
                            <div className="bubble user-bubble">
                              {hasGauntletLoop(m.content) ? (
                                <>
                                  <span className="gauntlet-badge">Gauntlet</span>
                                  {stripGauntletLoop(m.content) ||
                                    "Gauntlet Loop"}
                                </>
                              ) : (
                                m.content
                              )}
                            </div>
                            <div className="bubble-actions">
                              <CopyButton
                                getText={() => m.content}
                                title="Copy message"
                              />
                            </div>
                          </>
                        ) : (
                          <div className="bubble system-bubble">{m.content}</div>
                        )}
                      </div>
                    ),
                  )}
                {running && (
                  <RunActivity
                    running={running}
                    mode={mode}
                    memberName={
                      liveMemberName ||
                turnsRef.current.get(active?.id ?? "")?.member.name ||
                null
                    }
                    toolLabel={liveToolLabel}
                    steps={liveSteps}
                    startedAt={
                      turnsRef.current.get(active?.id ?? "")?.startedAt
                    }
                    reasoning={Boolean(reasoningByConv[active?.id ?? ""])}
                  />
                )}
                {gauntletByConv[active?.id ?? ""] ? (
                  <GauntletProgressCard
                    progress={gauntletByConv[active?.id ?? ""] ?? null}
                  />
                ) : null}
                {krakenCard ? (
                  <KrakenProgressCard
                    progress={krakenCard.progress ?? null}
                    metrics={krakenCard.metrics ?? null}
                  />
                ) : null}
                <KrakenActivity />
                {verificationByConv[active?.id ?? ""]?.run ? (
                  <VerificationStatusCard
                    run={verificationByConv[active?.id ?? ""].run ?? null}
                  />
                ) : null}
              </div>
            )}
          </div>
          {!followStream && (!empty || running) && (
            <button
              type="button"
              className={`btn-follow-stream${running ? " is-live" : ""}`}
              onClick={reattachStream}
              title="Jump back to the live stream and keep scrolling"
            >
              <span className="btn-follow-stream-icon" aria-hidden>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {/* Pin / re-attach to live stream */}
                  <path d="M12 5v10" />
                  <path d="m7 11 5 5 5-5" />
                  <path d="M5 19h14" />
                </svg>
              </span>
              <span className="btn-follow-stream-label">
                <span className="btn-follow-stream-kicker">
                  {running ? "Live" : "Chat"}
                </span>
                <span className="btn-follow-stream-text">
                  {running ? "Follow stream" : "Jump to latest"}
                </span>
              </span>
            </button>
          )}
        </div>

        <div className="composer-wrap">
          {textLoopRecovery && !running && (
            <div className="text-loop-recovery" role="status">
              <span className="text-loop-recovery-label">
                Generation stopped (text loop). Resume: tools if needed, then
                finish or report and ask to continue:
              </span>
              <button
                type="button"
                className="btn-primary text-loop-recovery-btn"
                onClick={() => void send(TEXT_LOOP_CONTINUE)}
              >
                Continue with tools
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setTextLoopRecovery(false)}
              >
                Dismiss
              </button>
            </div>
          )}
          {prefs.gauntletLoop && (
            <div className="pending-skill-chip gauntlet-chip" role="status">
              <span>
                <strong>Gauntlet Loop</strong>
                <span className="muted">
                  {" "}
                  — next send runs a capped builder/critic loop (not Graph)
                </span>
              </span>
              <button
                type="button"
                className="btn-ghost"
                disabled={running}
                onClick={() => setGauntletLoop(false)}
              >
                Off
              </button>
            </div>
          )}
          {pendingSkill && (
            <div className="pending-skill-chip" role="status">
              <span>
                Skill: <strong>{pendingSkill.id}</strong>
                <span className="muted"> — will expand on send</span>
              </span>
              <button
                type="button"
                className="btn-ghost"
                disabled={running}
                onClick={() => setPendingSkill(null)}
              >
                Clear
              </button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="attach-strip" aria-label="Attached files">
              {attachments.map((a) => (
                <div key={a.id} className="attach-chip" title={a.path || a.name}>
                  <span className="attach-chip-icon" aria-hidden>
                    📄
                  </span>
                  <span className="attach-chip-meta">
                    <span className="attach-chip-name">{a.name}</span>
                    <span className="attach-chip-sub">
                      {a.text != null
                        ? `${Math.round(a.size / 1024) || 1} KB · text`
                        : a.note || `${Math.round(a.size / 1024) || 1} KB`}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="attach-chip-remove"
                    title="Remove"
                    disabled={running}
                    onClick={() => removeAttachment(a.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-stack">
          {mention && (
            <MentionPopup
              cwd={activeCwd}
              query={mention.query}
              open
              onPick={onPickMention}
              onClose={() => setMention(null)}
              activeIndex={mentionIndex}
              onActiveIndexChange={setMentionIndex}
              onHitsChange={setMentionHits}
            />
          )}
          <div
            className={`composer glass-capsule${speech.listening ? " is-listening" : ""}`}
          >
            <button
              type="button"
              className="btn-skill-pick"
              title="List & select a skill"
              aria-label="Skills"
              disabled={running}
              onClick={() => setSkillPickerOpen(true)}
            >
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
                <path
                  fill="currentColor"
                  d="M12 2l2.4 7.2H22l-6 4.4 2.3 7.2L12 16.8 5.7 20.8 8 13.6 2 9.2h7.6L12 2z"
                />
              </svg>
            </button>
            <button
              type="button"
              className={`btn-mic${speech.listening ? " is-on" : ""}${!speech.speechOk ? " is-unavailable" : ""}`}
              title={
                !speech.speechOk
                  ? "Speech recognition not available in this WebView"
                  : speech.listening
                    ? "Stop listening"
                    : "Speech to text"
              }
              aria-label="Speech to text"
              aria-pressed={speech.listening}
              disabled={!speech.speechOk || running}
              onClick={() => speech.toggle()}
            >
              {speech.listening ? (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
                  />
                </svg>
              )}
            </button>
            <div className="composer-input-wrap">
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => {
                  const el = e.target;
                  onDraftChange(el.value, el.selectionStart ?? el.value.length);
                }}
                onClick={(e) => {
                  const el = e.currentTarget;
                  onDraftChange(el.value, el.selectionStart ?? el.value.length);
                }}
                onKeyUp={(e) => {
                  const el = e.currentTarget;
                  if (
                    e.key === "ArrowLeft" ||
                    e.key === "ArrowRight" ||
                    e.key === "Home" ||
                    e.key === "End"
                  ) {
                    onDraftChange(
                      el.value,
                      el.selectionStart ?? el.value.length,
                    );
                  }
                }}
                onKeyDown={onKeyDown}
                placeholder={
                  speech.listening
                    ? "Listening… speak now"
                    : mode === "zelari"
                      ? "Describe the mission… (@file to tag)"
                      : mode === "council"
                        ? "Ask the council… (@file · Skills ★)"
                        : "Message the agent… (@file to tag paths)"
                }
                rows={1}
                disabled={running}
              />
              {speech.interim ? (
                <div className="speech-interim" aria-live="polite">
                  {speech.interim}
                </div>
              ) : null}
              {speech.error ? (
                <div className="speech-error" role="status">
                  {speech.error}
                </div>
              ) : null}
            </div>
            <div className="composer-actions">
              {running ? (
                <button
                  type="button"
                  className="btn-stop"
                  onClick={() => void onStop()}
                  title="Stop"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-send"
                  disabled={
                    (!(draft.trim() || speech.interim.trim()) &&
                      attachments.length === 0 &&
                      !pendingSkill) ||
                    (cli !== null && !cli.ok)
                  }
                  onClick={() => void send()}
                  title="Send"
                  aria-label="Send"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="17"
                    height="17"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          </div>
          <div className="composer-hint">
            Enter to send · @tag files · Skills ★ · drop to attach · {phase}{" "}
            · {mode}
            {prefs.gauntletLoop ? " · Gauntlet ON" : ""}
            {provider ? ` · ${provider}` : ""}
            {model ? ` / ${model}` : ""}
          </div>
        </div>
        <SkillPicker
          open={skillPickerOpen}
          workdir={activeCwd}
          onClose={() => setSkillPickerOpen(false)}
          onSelect={onSelectSkill}
        />
      </main>

      <ProjectPanel
        cwd={activeCwd}
        refreshKey={gitRefreshKey}
        collapsed={gitCollapsed}
        onToggle={() => setGitCollapsed((v) => !v)}
        onStatus={setStatusLine}
        onTagPath={(hit) => {
          setDraft((d) => {
            const tag = `@${hit.path} `;
            return d.trim() ? `${d.replace(/\s*$/, " ")}${tag}` : tag;
          });
          void attachWorkspacePath(hit);
        }}
      />
      </div>
      </div>
    </div>
  );
}
