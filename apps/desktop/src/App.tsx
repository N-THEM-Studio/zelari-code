import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
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
  getCliDoctorCheck,
  getPluginsStatus,
  installPlugin,
  onAgentEvent,
  onAgentStderr,
  onRunFinished,
  onSidecarLog,
  onSidecarStatus,
  type SidecarStatusPayload,
  permissionRespond,
  askUserRespond,
  runTask,
  setAppConfig,
  summarizeToolArgs,
} from "./agentClient";
import {
  ChatTranscript,
  type PermissionDecision,
} from "./components/ChatTranscript";
import {
  applyAskUserSettled,
  applyPermissionSettled,
  askUserAskFromEvent,
  permissionAskFromEvent,
} from "./inChatAsk";
import { loadConversations, saveConversations } from "./chatStorage";
import { ChatComposer, type ChatComposerHandle } from "./components/ChatComposer";
import { stripGauntletLoop } from "./gauntletLoop";
import {
  controlEvent,
  sendControl,
  supportsControl,
  type ProtocolInfoEvent,
} from "./controlClient";
import "./steer.css";

import { planFolderSwitch } from "./folderSwitch";
import { parseSteerSendResult } from "./steerRecovery";
import { classifyLiveSend, shouldAutoSendFollowUp } from "./liveSend";
import {
  isSidecarErrorLine,
  pushSidecarLogLine,
  sidecarLogLineFromPayload,
} from "./sidecarLog";

import { SettingsShell } from "./components/settings/SettingsShell";
import { RunActivity, type LiveToolStep } from "./components/RunActivity";
import { KrakenActivity } from "./components/KrakenActivity";
import { Sidebar } from "./components/Sidebar";
import {
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
  KrakenContextPanel,
  type LiveCtxStats,
} from "./components/KrakenContextPanel";
import {
  GauntletProgressCard,
  readGauntletProgress,
  type GauntletProgressView,
} from "./components/GauntletProgressCard";
import {
  loadDesktopPrefs,
  patchDesktopPrefs,
  saveDesktopPrefs,
  type DesktopPrefs,
} from "./desktopPrefs";

import { LiveTasksPanel } from "./components/LiveTasksPanel";
import { parseTodosFromUnknown } from "./sessionTodosUi";
import { extractImagePathsFromToolResult } from "./toolImages";
import {
  SESSION_FOLDERS_STORAGE_KEY,
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
  loadMissionState,
  loadWorkspaceTasks,
  mergeSessionTasks,
  normalizeCwdKey,
  toSessionTasks,
  toTodoPayload,
} from "./liveTasks";
import {
  shouldAutoResumeMission,
  autoResumeHint,
  type LiveTask,
  type MissionStateView,
} from "./liveTasks";
import { useRunActivity, type ActivityAgent } from "./activity";
import { readRunEnvelope } from "./runs/types";
import {
  activeRunCount,
  unseenResultsByConversation,
  useRunCoordinator,
} from "./runs";
import { TentacleTracePanel } from "./components/TentacleTracePanel";
import { RunsDashboard } from "./components/RunsDashboard";
import { RunsTrigger } from "./components/RunsTrigger";
import { QueuedFollowUps } from "./components/QueuedFollowUps";
import { readMissionVerdict } from "./components/tentacleVerdict";
import { friendlyToolLabel } from "./components/toolLabels";
import { scrubDisplayText } from "./components/scrubDisplayText";
import { ProjectPanel } from "./components/ProjectPanel";
import { CliSetupGuide } from "./components/CliSetupGuide";
import { DoctorGate } from "./components/DoctorGate";
import { TitleBar } from "./components/TitleBar";
import {
  SkillPicker,
  expandDesktopSkill,
} from "./components/SkillPicker";
import {
  importUserFile,
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
import { checkForDesktopUpdate } from "./updater";
import { useSpeechToText } from "./hooks/useSpeechToText";
import {
  flushSidecarBatches,
  useBatchedState,
} from "./hooks/useSidecarBatch";
import { applyBaffettiTheme } from "./theme/baffetti";
import "./App.css";
import "./theme/baffetti.css";

/**
 * SLICE1(composer-isolation): stable identity for a render-scoped handler.
 *
 * ChatComposer is wrapped in `React.memo`, but App re-creates several of the
 * handlers it hands down on every render (plain `function` declarations, e.g.
 * `onStop` or the pill handlers). Passing those directly would change a prop
 * identity on every App render — including every streaming delta — and defeat
 * the memo. The wrapper keeps one identity for the lifetime of the component
 * and always calls the latest closure.
 */
function useStableHandler<A extends unknown[]>(
  fn: (...args: A) => unknown,
): (...args: A) => void {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => {
    void ref.current(...args);
  }, []);
}

const SUGGESTIONS = [
  "Explain the architecture of this repo in plain language",
  "Find flaky tests and suggest fixes",
  "Add a unit test for the headless CLI path",
  "Review recent git changes for risk",
];

/** Per-suggestion icon (reference mock): refresh · clock · chart · shield. */
const SUGGESTION_ICONS = ["🔄", "🕒", "📊", "🛡️"];

/** Tools whose results may carry local image paths rendered in chat. */
const IMAGE_PRODUCING_TOOLS = new Set(["screenshot", "browser_check"]);

/** Sidebar sizing (2.35): default 234px = 20% narrower than the old 292px;
 * draggable between these bounds, persisted per device. */
const SIDEBAR_DEFAULT_W = 234;
const SIDEBAR_MIN_W = 180;
const SIDEBAR_MAX_W = 480;
const LS_SIDEBAR_W = "zelari-desktop-sidebar-w";

/** Prompt sent when the operator resumes a mission from the Live Tasks pill.
 * It must be non-empty (the sidecar rejects an empty `task`) but the CLI
 * ignores it while resuming: brief, slice and iteration come from
 * `.zelari/mission-state.json` (zelariMission.resumeZelariMission). */
const RESUME_MISSION_PROMPT = "Riprendi la missione.";

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

/**
 * Event types already reported as un-routable (M2 conversation isolation).
 * Module-level so the warning fires once per type per session, not once per
 * event: a permanently un-attributed stream stays visible in the console
 * without flooding it while a run is streaming.
 */
const warnedUnroutedTypes = new Set<string>();

/**
 * Drop path for an `agent-event` whose run envelope carries no conversationId.
 * The router NEVER guesses the active conversation: an un-attributed event
 * would land in whichever chat is on screen, which is exactly the A→B
 * cross-talk this guard closes. Warning is one-shot per event type.
 */
function warnUnroutedEvent(type: string): void {
  if (warnedUnroutedTypes.has(type)) return;
  warnedUnroutedTypes.add(type);
  console.warn(
    `[desktop] dropping "${type}" agent-event: the run envelope carries no conversationId (never routed to the active chat).`,
  );
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
  // SLICE1(composer-isolation): the draft no longer lives here. ChatComposer
  // owns the text (and the @-mention state); App reads/prefills/clears it
  // through this handle, so a keystroke re-renders the capsule only.
  const composerRef = useRef<ChatComposerHandle | null>(null);
  /** Sidebar width: draggable, persisted; default is 20% narrower (2.35). */
  const [sidebarW, setSidebarW] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(LS_SIDEBAR_W));
      if (
        Number.isFinite(saved) &&
        saved >= SIDEBAR_MIN_W &&
        saved <= SIDEBAR_MAX_W
      ) {
        return saved;
      }
    } catch {
      /* ignore */
    }
    return SIDEBAR_DEFAULT_W;
  });
  const sidebarWRef = useRef(sidebarW);
  sidebarWRef.current = sidebarW;
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onSidebarResizeStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    sidebarDragRef.current = { startX: e.clientX, startW: sidebarWRef.current };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("is-dragging");
  };

  const onSidebarResizeMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = sidebarDragRef.current;
    if (!drag) return;
    const next = Math.min(
      SIDEBAR_MAX_W,
      Math.max(SIDEBAR_MIN_W, drag.startW + (e.clientX - drag.startX)),
    );
    setSidebarW(next);
  };

  const onSidebarResizeEnd = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!sidebarDragRef.current) return;
    sidebarDragRef.current = null;
    e.currentTarget.classList.remove("is-dragging");
    try {
      localStorage.setItem(LS_SIDEBAR_W, String(sidebarWRef.current));
    } catch {
      /* ignore */
    }
  };

  const resetSidebarWidth = (): void => {
    setSidebarW(SIDEBAR_DEFAULT_W);
    try {
      localStorage.removeItem(LS_SIDEBAR_W);
    } catch {
      /* ignore */
    }
  };
  /**
   * SLICE3(sidecar-batching): these five slices are written by the sidecar
   * event burst and only READ by the render body (the tool carousel, the
   * kraken/verification/gauntlet cards) — nothing branches on their current
   * value mid-stream. They go through the coalescing holder so a burst of
   * tentacle/tool/progress events produces ONE app commit instead of one per
   * event. `setLiveToolLabelFor` / `setLiveStepsFor` below wrap these setters,
   * so their call sites inherit the batching untouched.
   */
  const [liveToolLabelByConv, setLiveToolLabelByConv] = useBatchedState<
    Record<string, string | null>
  >({});
  const [liveStepsByConv, setLiveStepsByConv] = useBatchedState<
    Record<string, LiveToolStep[]>
  >({});
  /** Kraken selection card (kraken_progress / kraken_metrics), per conv. */
  const [krakenCardByConv, setKrakenCardByConv] = useBatchedState<
    Record<string, KrakenCardState>
  >({});
  const [verificationByConv, setVerificationByConv] = useBatchedState<
    Record<string, VerificationCardState>
  >({});
  const [gauntletByConv, setGauntletByConv] = useBatchedState<
    Record<string, GauntletProgressView | undefined>
  >({});
  const [reasoningByConv, setReasoningByConv] = useState<
    Record<string, boolean>
  >({});
  const [prefs, setPrefs] = useState<DesktopPrefs>(() => loadPrefs());

  // Baffetti theme: master color + two intensity variants, scoped to the brand mark.
  useEffect(() => {
    applyBaffettiTheme(prefs.mustacheColor);
  }, [prefs.mustacheColor]);
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
  /** 2.32 B5 — doctor gate: first red from `--doctor --json` (null = green). */
  const [doctorRed, setDoctorRed] = useState<{ name: string; message: string } | null>(null);
  /** User clicked "Continue anyway" on the doctor gate (session-scoped). */
  const [doctorDismissed, setDoctorDismissed] = useState(false);
  const [cliStatusLoading, setCliStatusLoading] = useState(true);
  /** Optional plugins (Playwright, etc.) missing in the current workdir. */
  const [pluginRows, setPluginRows] = useState<PluginStatusRow[]>([]);
  const [pluginBannerDismissed, setPluginBannerDismissed] = useState(false);
  /**
   * Harness sidecar health notice ("Backend CLI: …"). Until now the backend
   * emitted harness-sidecar-status with no frontend listener, so a failed
   * node/CLI spawn or restart exhaustion looked like "the model never
   * answers". Non-ready statuses surface here as a banner; "ready" clears;
   * "log" lines are informational child stdout and ignored.
   */
  const [sidecarNotice, setSidecarNotice] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onSidecarStatus((payload: SidecarStatusPayload) => {
      if (disposed) return;
      if (payload.status === "ready") {
        setSidecarNotice(null);
      } else if (payload.status === "log") {
        // Informational child-stdout line (non-JSON): the sidecar process is
        // alive — not a health signal, keep the current notice as is.
        return;
      } else {
        setSidecarNotice(
          `${payload.message} (status: ${payload.status}) — details in logs/zelari-sidecar.log`,
        );
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // No Tauri backend reachable (e.g. dev browser) — nothing to surface.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * Sidecar stderr ring buffer (diagnostics panel): the child's stderr lines
   * arrive on harness-sidecar-log; keep the newest 200 for the collapsible
   * panel rendered at the top of the chat view.
   */
  const [sidecarLogLines, setSidecarLogLines] = useBatchedState<string[]>([]);
  const [sidecarLogOpen, setSidecarLogOpen] = useState(false);
  const sidecarLogPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onSidecarLog((payload) => {
      if (disposed) return;
      const line = sidecarLogLineFromPayload(payload);
      if (!line) return;
      setSidecarLogLines((prev) => pushSidecarLogLine(prev, line));
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // No Tauri backend reachable (e.g. dev browser) — nothing to surface.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  // Auto-scroll to the newest line while the panel is open.
  useEffect(() => {
    if (!sidecarLogOpen) return;
    const el = sidecarLogPanelRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sidecarLogLines, sidecarLogOpen]);

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
  /** Stream ticks that landed below the viewport while detached; shown as
   *  a pill on the follow button so the user knows what they jumped back to. */
  const [missedBelow, setMissedBelow] = useState(0);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  // SLICE1(composer-isolation): `mention`, `mentionIndex` and `mentionHits`
  // moved INTO ChatComposer — they only ever drove its popover and its caret.
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
  /**
   * SLICE4(model-sync): true once the user picked a provider/model IN THIS
   * SESSION (chat model bar, Settings → Models & Providers, or binding another
   * conversation). Until then `refreshConfig` may re-align the chat bar with
   * the CLI config; after an explicit pick it must never clobber it.
   */
  const userPickedModelRef = useRef(false);


  // Persist chats. The ACTIVE conversation is guaranteed a storage slot
  // (cap-aware selection in chatStorage); quota failures surface on the
  // status line instead of being swallowed — in-memory data stays intact.
  useEffect(() => {
    const res = saveConversations(conversations, {
      activeId: activeIdRef.current,
    });
    if (!res.ok) {
      console.warn("[zelari] chat save failed:", res.error);
      setStatusLine(
        `Chats not saved (local storage full) — ${res.error ?? "unknown error"}`,
      );
    }
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

  // Ctrl/Cmd+, opens Settings from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setView((v) => (v === "chat" ? "settings" : v));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
  /** Queued follow-ups of the active conversation (§24, persisted — D). */
  const pendingFollowUps = active?.pendingFollowUps ?? [];
  const oldestPendingFollowUp = pendingFollowUps[0];
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

  /**
   * Zelari mission of the active workspace (`.zelari/mission-state.json`,
   * 2.37 resume): drives the Live Tasks mission pill + Riprendi. Keyed by
   * normalized cwd like the plan (every chat on the same workspace shares the
   * mission) and runtime-only. `null` = no mission on disk → no pill.
   */
  const [missionByCwd, setMissionByCwd] = useState<
    Record<string, MissionStateView | null>
  >({});
  const mission = activeCwd
    ? missionByCwd[normalizeCwdKey(activeCwd)] ?? null
    : null;
  /** Re-read mission-state.json of a workspace (switch + run reconciliation). */
  const reloadMission = useCallback(async (cwd: string) => {
    const view = await loadMissionState(cwd);
    setMissionByCwd((prev) => {
      const key = normalizeCwdKey(cwd);
      // Unchanged file → same reference (signature cache): no re-render.
      if (prev[key] === view) return prev;
      return { ...prev, [key]: view };
    });
  }, []);
  // Same lifecycle as the project tasks: a mission persisted by the CLI (or by
  // an earlier session) shows up on workspace switch with no run in flight.
  useEffect(() => {
    if (!activeCwd) return;
    void reloadMission(activeCwd);
  }, [activeCwd, reloadMission]);
  // t63: the backend watches `.zelari/plan.json` per workspace and
  // emits `plan-changed` on out-of-band writes (CLI/council running
  // while this window is unfocused — the focus guard above only fires
  // when the user returns). Fail-open: outside the Tauri shell, or with
  // a bundle that lacks the command, the invoke rejects and the
  // switch+focus refresh paths keep working unchanged.
  useEffect(() => {
    if (!activeCwd) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("watch_plan_changes", { cwd: activeCwd });
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<{ cwd: string }>("plan-changed", (e) => {
          void reloadWorkspaceTasks(e.payload.cwd);
        });
        if (cancelled) off();
        else unlisten = off;
      } catch {
        /* not in Tauri shell: focus/switch reload still applies */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [activeCwd, reloadWorkspaceTasks]);

  /** Run registry: multiplexed runs across conversations (M2). */
  const runCoordinator = useRunCoordinator();
  /** Kraken activity stream: kept here for the live row of the open trace
   *  panel - the sidebar renders none of it any more. Same `agent-event`
   *  channel KrakenActivity already consumes - no new channel, no new IPC.
   *  Conversation isolation: the hook routes by run envelope only, so a run
   *  in another chat never lands in this one (M2 routing parity with the
   *  onAgentEvent block below); events with no envelope id are dropped. */
  const activity = useRunActivity({ conversationId: active?.id });
  /**
   * F2: tentacle whose live trace is open in the side panel. Only App owns
   * this state; the panel reads the file.
   */
  const [tracedAgent, setTracedAgent] = useState<ActivityAgent | null>(null);
  /**
   * F4: global runs dashboard. Same drawer pattern as the trace panel: App
   * owns the flag because the run registry (`runCoordinator`) is hook-local
   * here and cannot be imported by a child.
   */
  const [dashboardOpen, setDashboardOpen] = useState(false);
  /** F4: runs in flight across ALL conversations — badge of the topbar trigger. */
  const runsActive = activeRunCount(runCoordinator.state);
  /** Live row when the run still knows it, captured row once it is gone. */
  const tracedLive: ActivityAgent | null = tracedAgent
    ? activity.agents[tracedAgent.id] ?? tracedAgent
    : null;
  /** Conversations that just finished a run and should flush the follow-up queue. */
  const autoSendAfterRunRef = useRef<Set<string>>(new Set());
  /** Composer/Stop state is per-conversation now, never global. */
  const running = runCoordinator.isRunning(active?.id ?? "");
  // Restore persisted follow-ups as composer prefill only when idle — while
  // a run is live the queue is shown as chips, not dumped into the draft.
  useEffect(() => {
    if (!oldestPendingFollowUp || running) return;
    // SLICE1(composer-isolation): prefill the capsule through the handle.
    composerRef.current?.setText((prev) =>
      prev.trim() ? prev : oldestPendingFollowUp,
    );
  }, [activeId, oldestPendingFollowUp, running]);
  // Auto-dispatch the oldest follow-up AFTER React applies run-finished.
  // The Tauri handler must not call send() in the same tick: `running` and
  // `isRunning()` are still stale, so the follow-up was re-steered / dropped.
  useEffect(() => {
    const convId = activeId;
    if (!convId || !autoSendAfterRunRef.current.has(convId)) return;
    if (runCoordinator.isRunning(convId)) return;
    const queued = conversations.find((c) => c.id === convId)?.pendingFollowUps?.[0];
    // SLICE1(composer-isolation): the live draft comes from the capsule.
    const draftNow = composerRef.current?.getText() ?? "";
    const text = shouldAutoSendFollowUp({
      queued,
      draft: draftNow,
      wasCancelled: false,
    });
    if (!text) {
      if (queued && draftNow.trim() && draftNow.trim() !== queued.trim()) {
        autoSendAfterRunRef.current.delete(convId);
      }
      return;
    }
    autoSendAfterRunRef.current.delete(convId);
    void sendRef.current(text);
  }, [activeId, conversations, runCoordinator.state]);
  const [liveSendMode, setLiveSendMode] = useState<"steer" | "queue">("steer");
  useEffect(() => {
    if (!running) setLiveSendMode("steer");
  }, [running, activeId]);
  const liveToolLabel = liveToolLabelByConv[active?.id ?? ""] ?? null;
  const liveSteps = liveStepsByConv[active?.id ?? ""] ?? [];
  const krakenCard = krakenCardByConv[active?.id ?? ""];
  const liveMemberName = liveMemberNameByConv[active?.id ?? ""] ?? null;
  const runningRef = useRef(running);

  /**
   * Realtime context stats for the Kraken panel (KrakenContextPanel):
   * recomputed on every message delta, so the meter breathes with the
   * stream. ctxTokens is the labeled-ESTIMATE numerator only — best proxy
   * (chars/4, measured turn tokens, last context size reported by the
   * CLI). The authoritative readout is the spine budget event, resolved
   * by computeContextMeter; this value only feeds its fallback.
   */
  const liveCtx = useMemo((): LiveCtxStats => {
    const msgs = active?.messages ?? [];
    let chars = 0;
    for (const m of msgs) {
      if (m.role === "tool") continue;
      chars += m.content?.length ?? 0;
    }
    const t = turnsRef.current.get(active?.id ?? "");
    const tok = t?.tokens;
    const measured = tok ? tok.prompt + tok.completion : 0;
    // Best available signal wins: chars/4 proxy < measured turn tokens <
    // the context size the CLI last reported for a completed model call.
    let reported = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "assistant" && (m.stats?.contextTokens ?? 0) > 0) {
        reported = m.stats?.contextTokens ?? 0;
        break;
      }
    }
    return {
      ctxTokens: Math.max(Math.round(chars / 4), measured, reported),
      turnTokens: tok?.total ?? 0,
      promptTokens: tok?.prompt ?? 0,
      completionTokens: tok?.completion ?? 0,
      toolCount: t?.toolCount ?? 0,
      elapsedMs: t?.startedAt ? Date.now() - t.startedAt : null,
      streaming: running,
    };
  }, [active?.messages, active?.id, running]);
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
      // 2.32 B5: CLI resolves → run the doctor too; the first red gates chat.
      if (s.ok) {
        try {
          const d = await getCliDoctorCheck();
          setDoctorRed(
            d.healthy
              ? null
              : (d.firstRed ?? { name: "doctor", message: "unknown red check" }),
          );
        } catch {
          setDoctorRed(null); // doctor unavailable → never block the front door
        }
      } else {
        setDoctorRed(null);
      }
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
      // SLICE4(model-sync): anti-sticky. The old `prev ||` fill kept the very
      // first value forever — a model changed anywhere else (CLI, Settings →
      // Models & Providers, another panel writing provider.json) never reached
      // the chat bar, so chat and Settings disagreed permanently. Now the CLI
      // config wins UNTIL the user picks something in this session
      // (`userPickedModelRef`), and an explicit pick still wins over it.
      const cfgModel =
        c.modelByProvider[c.activeProviderId] ||
        c.providers.find((p) => p.id === c.activeProviderId)?.defaultModel ||
        "";
      const picked = userPickedModelRef.current;
      setProvider((prev) =>
        picked ? prev || c.activeProviderId : c.activeProviderId || prev,
      );
      setModel((prev) => (picked ? prev || cfgModel : cfgModel || prev));
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

  // t66: folder-trust gate — poll the companion serve for a parked
  // awaiting_trust run and pop the trust modal (vanilla overlay; it installs
  // its own DOM). Fail-open outside the Tauri shell: invoke rejects and the
  // poller simply never fires.
  useEffect(() => {
    let disposed = false;
    let uninstall: (() => void) | undefined;
    void (async () => {
      try {
        const gate = await import("./components/trustGate");
        if (disposed) return;
        gate.installTrustGate();
        uninstall = gate.uninstallTrustGate;
      } catch {
        /* trustGate unavailable (non-Tauri) — non-fatal */
      }
    })();
    return () => {
      disposed = true;
      uninstall?.();
    };
  }, []);

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

  // Directional scroll model (fix for "can't scroll up while it
  // generates"): detach when the user moves up beyond a small dead-zone…
  const NEAR_BOTTOM_PX = 32;
  // …and re-attach only when they are truly back at the very bottom.
  const REATTACH_PX = 8;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    // Hard gate: once the user detached, NO code path may pull the view
    // down (defence in depth — effects already check followStreamRef).
    // reattachStream flips the ref back to true before calling this.
    if (!followStreamRef.current) return;
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
    setMissedBelow(0);
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

  // While detached during a live run, count stream ticks so the follow
  // button can badge how much new content landed below the fold.
  useEffect(() => {
    if (followStream || !running) return;
    setMissedBelow((n) => n + 1);
  }, [streamTick, followStream, running]);

  // User scroll: directional detach + bottom re-attach.
  //
  // Fix for "I can't scroll up while it generates, it keeps pulling me
  // down": the old guard (`programmaticScrollRef`, 50ms grace) stayed
  // true while deltas arrived faster than the grace period, so user
  // scrolls via scrollbar drag, trackpad natural scrolling or keyboard
  // were swallowed and stick-to-bottom kept winning. Direction beats
  // timing: programmatic stick-to-bottom only ever INCREASES scrollTop,
  // so any real decrease is the user. No wheel handler needed.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastScrollTop = el.scrollTop;
    let lastHeight = el.scrollHeight;
    // Cumulative upward intent: trackpad/smooth-wheel scrolling emits a
    // burst of tiny upward deltas; each one alone stays under the 32px
    // dead-zone while stick-to-bottom keeps re-pinning to the bottom, so
    // the user can never detach. Programmatic scrolls only ever move
    // DOWN, so every upward delta is the user — sum them inside a short
    // window and detach on sustained intent (≥24px in ≤500ms), on top of
    // the instant rule for full notch scrolls (distance > 32px).
    let upAccum = 0;
    let upWindowStart = 0;
    const UP_INTENT_PX = 24;
    const UP_INTENT_MS = 500;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const goingUp = el.scrollTop < lastScrollTop - 2;
      const goingDown = el.scrollTop > lastScrollTop + 2;
      // A shrunken scrollHeight means React re-laid-out the list (refresh),
      // not that the user moved — a collapsed viewport briefly reads
      // "distance ≤ 8" and must NEVER auto-reattach.
      const collapsed = el.scrollHeight < lastHeight - 8;
      if (goingUp) {
        const now = performance.now();
        if (now - upWindowStart > UP_INTENT_MS) {
          upWindowStart = now;
          upAccum = 0;
        }
        upAccum += lastScrollTop - el.scrollTop;
      }
      lastScrollTop = el.scrollTop;
      lastHeight = el.scrollHeight;
      if (
        followStreamRef.current &&
        goingUp &&
        (distance > NEAR_BOTTOM_PX || upAccum >= UP_INTENT_PX)
      ) {
        upAccum = 0;
        followStreamRef.current = false;
        setFollowStream(false);
      } else if (
        goingDown &&
        !collapsed &&
        distance <= REATTACH_PX &&
        !followStreamRef.current
      ) {
        // Explicit "back to live": a USER-driven downward scroll that
        // lands on the true bottom (≤8px). While skimming above the end
        // this can't fire, and layout collapses are excluded above.
        upAccum = 0;
        followStreamRef.current = true;
        setFollowStream(true);
        setMissedBelow(0);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
    // Rebind per conversation: the scroller node can be swapped when the
    // active chat changes, and a stale (detached) listener would die
    // silently with the old node.
  }, [activeId]);

  // New chat: always re-follow
  useEffect(() => {
    setFollowStream(true);
    followStreamRef.current = true;
    setMissedBelow(0);
  }, [activeId]);

  // Control plane (§35): per-conversation capability handshake emitted by
  // the CLI at run start. The composer's steer mode is gated on it so an
  // old CLI keeps the previous behaviour (disabled while running).
  const [controlInfoByConv, setControlInfoByConv] = useState<
    Record<string, ProtocolInfoEvent>
  >({});
  const controlInfoRef = useRef<Record<string, ProtocolInfoEvent>>({});
  /** Sidecar boot handshake — not per-chat. Boot protocol_info often has
   * no conversationId, so keying only by conv locked the composer. */
  const [sidecarProtocol, setSidecarProtocol] =
    useState<ProtocolInfoEvent | null>(null);
  const sidecarProtocolRef = useRef<ProtocolInfoEvent | null>(null);
  const steeredThisRunRef = useRef<Record<string, boolean>>({});
  const sendRef = useRef<(text?: string) => Promise<void>>(async () => {});
  const steerSupported = supportsControl(
    sidecarProtocol ?? controlInfoByConv[active?.id ?? ""],
    "steer",
  );

  const speech = useSpeechToText({
    disabled: running,
    onFinal: (piece) => {
      // SLICE1(composer-isolation): final transcript lands in the capsule.
      composerRef.current?.setText((prev) =>
        prev ? `${prev.trimEnd()} ${piece}` : piece,
      );
    },
  });

  // SLICE1(composer-isolation): the capsule takes the wording as a plain
  // string, so App needs no <textarea> placeholder logic of its own.
  const composerPlaceholder = speech.listening
    ? "Listening… speak now"
    : running
      ? liveSendMode === "steer" && steerSupported
        ? "Steer the running agent… (applied at the next tool boundary)"
        : "Queue a follow-up… (sends when this run ends)"
      : mode === "zelari"
        ? "Describe the mission… (@file to tag)"
        : mode === "council"
          ? "Ask the council… (@file · Skills ★)"
          : "Message the agent… (@file to tag paths)";

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const u1 = await onAgentEvent((ev) => {
        if (cancelled) return;
        // M2 invariant (hardened): every BrainEvent carries its OWN
        // conversation identity in the run envelope — Rust stamps it per
        // RECEIVING run, broadcast residue included. There is NO fallback to
        // the active conversation any more: an id-less line is never guessed
        // into whichever chat is open (that was the A→B cross-talk: messages,
        // reasoning, tentacle activity and the spine sessionId of a run
        // started in A landing in B's panel).
        const envelopeConv = readRunEnvelope(ev).conversationId;
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
              conversationsRef.current.find((c) => c.id === envelopeConv)?.cwd;
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
        // Control plane (§35): handshake + steering acks. protocol_info
        // gates the composer's steer mode; acks advance the bubble state
        // (sent → accepted → applied — never assume stdin writes, §24).
        // protocol_info is the ONE event handled before the identity gate:
        // it is the sidecar's run-capability handshake, not conversation
        // state (Rust: "sidecar boot handshake — not per-chat"), and the
        // global protocol object must stay settable for any CLI build. Its
        // per-conversation projection is written ONLY for an enveloped event.
        if (ev.type === "protocol_info") {
          const info = ev as { version?: unknown; capabilities?: unknown };
          const next: ProtocolInfoEvent = {
            type: "protocol_info",
            version: typeof info.version === "number" ? info.version : 0,
            capabilities: Array.isArray(info.capabilities)
              ? (info.capabilities as string[])
              : [],
          };
          sidecarProtocolRef.current = next;
          setSidecarProtocol(next);
          if (envelopeConv) {
            controlInfoRef.current = {
              ...controlInfoRef.current,
              [envelopeConv]: next,
            };
            setControlInfoByConv((prev) => ({ ...prev, [envelopeConv]: next }));
          }
          return;
        }
        // Routing gate (M2): from here on the handler only ever touches the
        // conversation named by the envelope. No identity → drop the event
        // (one-shot console warning); never attribute it to the open chat.
        if (!envelopeConv) {
          warnUnroutedEvent(ev.type);
          return;
        }
        const convId = envelopeConv;
        if (ev.type === "permission.request") {
          const ask = permissionAskFromEvent(ev as unknown as Record<string, unknown>);
          if (ask) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId
                  ? {
                      ...c,
                      updatedAt: Date.now(),
                      messages: [
                        ...c.messages,
                        {
                          id: uid("perm"),
                          role: "system",
                          content: `Allow tool "${ask.tool}"?`,
                          createdAt: Date.now(),
                          permissionAsk: ask,
                        },
                      ],
                    }
                  : c,
              ),
            );
          }
          return;
        }
        if (ev.type === "permission.settled") {
          const requestId =
            typeof (ev as { requestId?: unknown }).requestId === "string"
              ? (ev as { requestId: string }).requestId
              : "";
          const decision =
            typeof (ev as { decision?: unknown }).decision === "string"
              ? (ev as { decision: string }).decision
              : "deny";
          const timedOut = (ev as { timedOut?: unknown }).timedOut === true;
          if (requestId) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId
                  ? {
                      ...c,
                      messages: applyPermissionSettled(
                        c.messages,
                        requestId,
                        decision,
                        timedOut,
                      ),
                    }
                  : c,
              ),
            );
          }
          return;
        }
        if (ev.type === "ask_user.request") {
          const ask = askUserAskFromEvent(ev as unknown as Record<string, unknown>);
          if (ask) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId
                  ? {
                      ...c,
                      updatedAt: Date.now(),
                      messages: [
                        ...c.messages,
                        {
                          id: uid("ask"),
                          role: "system",
                          content: ask.question,
                          createdAt: Date.now(),
                          askUserAsk: ask,
                        },
                      ],
                    }
                  : c,
              ),
            );
          }
          return;
        }
        if (ev.type === "ask_user.settled") {
          const requestId =
            typeof (ev as { requestId?: unknown }).requestId === "string"
              ? (ev as { requestId: string }).requestId
              : "";
          const rawAnswer = (ev as { answer?: unknown }).answer;
          const answer = typeof rawAnswer === "string" ? rawAnswer : null;
          const timedOut = (ev as { timedOut?: unknown }).timedOut === true;
          if (requestId) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId
                  ? {
                      ...c,
                      messages: applyAskUserSettled(
                        c.messages,
                        requestId,
                        answer,
                        timedOut,
                      ),
                    }
                  : c,
              ),
            );
          }
          return;
        }
        if (
          ev.type === "control_accepted" ||
          ev.type === "control_applied" ||
          ev.type === "control_rejected"
        ) {
          const controlId =
            typeof (ev as { controlId?: unknown }).controlId === "string"
              ? (ev as { controlId: string }).controlId
              : "";
          if (controlId) {
            const state: "accepted" | "applied" | "rejected" =
              ev.type === "control_accepted"
                ? "accepted"
                : ev.type === "control_applied"
                  ? "applied"
                  : "rejected";
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId
                  ? {
                      ...c,
                      messages: c.messages.map((m) =>
                        m.steer?.id === controlId
                          ? { ...m, steer: { id: controlId, state } }
                          : m,
                      ),
                    }
                  : c,
              ),
            );
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
          // Late steers become follow-ups at run end (§24): surface the
          // queued text in chat and prefill the composer — only when the
          // user hasn't typed something else meanwhile.
          const followUpMatch = /^follow_up_queued:\s*([\s\S]+)$/.exec(msg);
          if (followUpMatch && followUpMatch[1].trim()) {
            const followUpText = followUpMatch[1].trim();
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId
                  ? {
                      ...c,
                      // Persist the queued follow-up (§24/D): restored as
                      // composer prefill on reload/switch until dispatched.
                      pendingFollowUps: [
                        ...(c.pendingFollowUps ?? []),
                        followUpText,
                      ],
                      messages: [
                        ...c.messages,
                        {
                          id: uid("sys"),
                          role: "system",
                          content: `Follow-up ready: ${followUpText}`,
                          createdAt: Date.now(),
                        },
                      ],
                    }
                  : c,
              ),
            );
            if (convId === activeIdRef.current) {
              // SLICE1(composer-isolation): prefill only if untouched.
              composerRef.current?.setText((prev) =>
                prev.trim() ? prev : followUpText,
              );
            }
            // Run may already have finished (log vs run-finished ordering).
            // Arm so the idle auto-send effect dispatches instead of parking
            // the chip as "Next 1/1".
            autoSendAfterRunRef.current.add(convId);
            setStatusLineIfActive("Follow-up ready — sending next…");
            return;
          }
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
        // M2 (cross-talk fix): the id is written into the conversation the
        // ENVELOPE names — `convId` is `envelopeConv` past the routing gate —
        // and never into the active conversation. Writing B's sessionId into
        // A made A resume B's spine on its next turn (wrong event log).
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
          // SLICE3(sidecar-batching): a message boundary is a natural paint
          // point — land every pending batched sidecar update in the SAME
          // commit as the settled row instead of waiting for the window.
          flushSidecarBatches();
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
          // Screenshot-in-chat: when an image-producing tool (screenshot,
          // browser_check) returns local image paths, persist them as a
          // visual card in the conversation — pixels the user asked to see,
          // not a JSON wall. Tool-gated so a plain list of .png files never
          // renders as images.
          if (!isErr && endName && IMAGE_PRODUCING_TOOLS.has(endName)) {
            const rawResult =
              typeof (ev as { result?: unknown }).result === "string"
                ? (ev as { result: string }).result
                : extractToolResult(ev);
            const imagePaths = extractImagePathsFromToolResult(rawResult);
            if (imagePaths.length > 0) {
              setConversations((prev) =>
                prev.map((c) =>
                  c.id === convId
                    ? {
                        ...c,
                        messages: [
                          ...c.messages,
                          {
                            id: uid("img"),
                            role: "assistant" as const,
                            content: "",
                            imagePaths,
                            createdAt: Date.now(),
                          },
                        ],
                      }
                    : c,
                ),
              );
            }
          }
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
        // Run-scoped payload: no identity → no attribution (never the active
        // chat). Rust stamps `agent-stderr` with the run's conversationId.
        const convId = payload.conversationId ?? "";
        if (
          convId &&
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
        // Run-scoped payload: the registry is keyed by runId, so a missing
        // conversationId still settles the run — it only stops the desk from
        // guessing WHICH chat the run belonged to (no fallback to active).
        const convId = payload.conversationId ?? "";
        const turn = turnsRef.current.get(convId) ?? turnFor(convId);
        const isActiveConv = convId === activeIdRef.current;
        runCoordinator.finished(
          { ...payload, conversationId: convId },
          activeIdRef.current,
        );
        // M3: plan.json is the source of truth once the run settles -
        // re-read it to reconcile optimistic task updates (ADR-0018).
        if (payload.cwd) void reloadWorkspaceTasks(payload.cwd);
        // 2.37: the mission advances one iteration per run — re-read its
        // resume state so the Live Tasks pill leaves "in corso" on settle.
        if (payload.cwd) void reloadMission(payload.cwd);
        setLiveToolLabelFor(convId, null);
        setLiveMemberNameFor(convId, null);
        clearToolLabelTimer(convId);
        // SLICE3(sidecar-batching): the run settled — force the pending batch
        // so the final live state (cleared label, finished step list) is on
        // screen with the stats below, never 180ms late.
        flushSidecarBatches();
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
                        // Context proxy for the compaction meter: the last
                        // prompt size is the best context signal the Desktop
                        // receives today (no usage events yet).
                        contextTokens:
                          m.stats?.contextTokens ??
                          (tokens.prompt > 0 ? tokens.prompt : undefined),
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
        steeredThisRunRef.current[convId] = false;
        if (!wasCancelled) autoSendAfterRunRef.current.add(convId);
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
    // SLICE1(composer-isolation): a new chat starts with an empty capsule.
    composerRef.current?.setText("");
    setTextLoopRecovery(false);
    taRef.current?.focus();
  };

  /** Sidebar selection (F1): body of the inline handler it replaces - clears
   *  the unseen badge, then rebinds mode/phase/provider/model to that chat. */
  const onSelectSession = (c: Conversation) => {
    runCoordinator.markSeen(c.id);
    setActiveId(c.id);
    setMode(c.mode);
    setPhase(c.phase);
    if (c.provider) setProvider(c.provider);
    if (c.model) setModel(c.model);
    // SLICE4(model-sync): a conversation carries its own provider/model. Before
    // this, rebinding another chat changed the bar but left provider.json on
    // the previous chat's model — so Settings → Agents kept showing the old one
    // and the CLI spawned the old one. Push the newly active model through the
    // same writer (fire-and-forget: no await, no UI block).
    userPickedModelRef.current = true;
    const nextProvider = c.provider || provider;
    const nextModel = c.model || model;
    if (nextModel) void persistChatModel(nextProvider, nextModel);
  };

  /** User-facing recovery prompt after assistant_text_loop (keep in sync with core TEXT_LOOP_RECOVERY_USER_PROMPT). */
  const TEXT_LOOP_CONTINUE =
    "Continue from the text-loop stop. Inspect disk, apply at most one missing piece with tools if needed, " +
    "then either mark DONE with a short verify list OR give a brief resoconto and ask if I want you to continue. " +
    "No status theater, no full rewrite.";

  /**
   * grok-round: rename a conversation in place. Exactly the archive/delete
   * shape — `setConversations` map by id, persistence handled by the existing
   * save effect (localStorage, cap 80). The title arrives already trimmed and
   * non-empty from the sidebar; the guard here is the second line of defence
   * so a nameless row can never be stored. `updatedAt` is deliberately NOT
   * touched: renaming is metadata, not activity, and must not re-sort a list
   * that is ordered by `updatedAt` (sessionGroups).
   */
  const renameChat = (id: string, title: string) => {
    const next = title.trim();
    if (!next) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: next } : c)),
    );
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

  /**
   * SLICE4(model-sync): chat → CLI config. The single writer for every place
   * the CHAT model changes (chat model bar, provider switch, conversation
   * switch). It goes through the SAME sidecar command the Settings panels
   * already use — `set_app_config` (agentClient's `setAppConfig`) → the
   * provider.json the CLI reads at spawn time — so no new IPC is invented.
   * A failing write lands on the status line and never blocks the chat;
   * Settings → Agents surfaces the drift with a retry.
   */
  const persistChatModel = async (
    nextProvider: string,
    nextModel: string,
    what: "provider" | "model" = "model",
  ): Promise<boolean> => {
    if (!nextProvider) return false;
    try {
      await setAppConfig({
        provider: nextProvider,
        ...(nextModel ? { model: nextModel } : {}),
      });
      return true;
    } catch (e) {
      setStatusLine(errText(e, `Failed to persist ${what}`));
      return false;
    }
  };

  const onProviderChange = async (id: string) => {
    // SLICE4(model-sync): an explicit pick — refreshConfig must not undo it.
    userPickedModelRef.current = true;
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
    // SLICE4(model-sync): the provider switch carries its model to
    // provider.json, exactly like the Settings → Models & Providers picker.
    if (!(await persistChatModel(id, nextModel, "provider"))) return;
    await refreshConfig();
  };

  const onModelChange = async (id: string) => {
    // SLICE4(model-sync): an explicit pick — refreshConfig must not undo it.
    userPickedModelRef.current = true;
    setModel(id);
    setConversations((prev) =>
      prev.map((c) => (c.id === activeId ? { ...c, model: id } : c)),
    );
    if (!provider) return;
    // SLICE4(model-sync): chat model → provider.json, so the Agents view and
    // the CLI agree with what the chat bar shows.
    if (!(await persistChatModel(provider, id))) return;
    await refreshConfig();
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
    const next = await Promise.all(
      list.map(async (f) => {
        const native = fileNativePath(f);
        if (native && activeCwd) {
          try {
            const res = await importUserFile({ path: native, cwd: activeCwd });
            const base = await readFileAsAttachment(f);
            return {
              ...base,
              path: res.rel || res.imported,
              text: res.text ?? base.text,
              note: res.note ?? base.note,
              size: res.size || base.size,
            };
          } catch {
            return readFileAsAttachment(f);
          }
        }
        return readFileAsAttachment(f);
      }),
    );
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
  }, [activeCwd]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const onPickExternalFiles = useCallback(async () => {
    try {
      const selected = await open({ multiple: true });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const atts: PendingAttachment[] = [];
      for (const p of paths) {
        if (typeof p !== "string" || !p.trim()) continue;
        try {
          const res = await importUserFile({ path: p, cwd: activeCwd });
          const name =
            res.rel.split(/[\\/]/).pop() ||
            res.original.split(/[\\/]/).pop() ||
            "file";
          atts.push({
            id: uid("att"),
            name,
            size: res.size,
            path: res.rel || res.imported,
            text: res.text ?? undefined,
            note: res.note ?? undefined,
          });
        } catch (e) {
          setStatusLine(errText(e, "Could not attach file"));
        }
      }
      if (atts.length === 0) return;
      setAttachments((prev) => {
        const names = new Set(prev.map((x) => (x.path || x.name).toLowerCase()));
        const merged = [...prev];
        for (const a of atts) {
          const key = (a.path || a.name).toLowerCase();
          if (names.has(key)) continue;
          names.add(key);
          merged.push(a);
        }
        return merged.slice(0, 12);
      });
      setStatusLine(
        atts.length === 1
          ? `Attached ${atts[0]!.name}`
          : `Attached ${atts.length} files`,
      );
    } catch (e) {
      setStatusLine(errText(e, "File picker failed"));
    }
  }, [activeCwd]);

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

  // SLICE1(composer-isolation): `onPickMention` and `onDraftChange` (the
  // @-mention insert + detection pair) moved into ChatComposer.tsx, together
  // with the `draft`/`mention` state they read.

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
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) void addFiles(files);
    },
    [addFiles],
  );

  /**
   * Steering (control plane §30–§35): while a run is live on a v2 CLI, the
   * composer sends steer events instead of queuing a new task. The bubble
   * tracks the ack cycle; "sent" is NOT "steered" until applied (§24).
   */
  const steerActiveRun = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const convId = activeIdRef.current;
    const run = runCoordinator.getRun(convId);
    if (!run || (run.status !== "running" && run.status !== "starting")) {
      setStatusLine("No active run to steer.");
      return;
    }
    if (!supportsControl(controlInfoRef.current[convId], "steer")) {
      setStatusLine("Steering needs a newer CLI — update zelari-code.");
      return;
    }
    const ev = controlEvent("steer", { text: trimmed });
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              updatedAt: Date.now(),
              messages: [
                ...c.messages,
                {
                  id: uid("steer"),
                  role: "user" as const,
                  content: trimmed,
                  createdAt: Date.now(),
                  steer: { id: ev.id, state: "sent" as const },
                },
              ],
            }
          : c,
      ),
    );
    // SLICE1(composer-isolation): the capsule clears through the handle.
    composerRef.current?.setText("");
    setAttachments([]);
    setFollowStream(true);
    followStreamRef.current = true;
    setStatusLine("Steer queued — applies at the next turn boundary…");
    try {
      const raw = await sendControl(run.runId, ev);
      const result = parseSteerSendResult(raw);
      if (result?.status === "already_finished") {
        // The run ended before the steer could be queued: never leave the
        // bubble stuck on "sent" — mark it and hand the text back to the
        // composer (noop-recovery).
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.steer?.id === ev.id
                      ? {
                          ...m,
                          steer: { id: ev.id, state: "not_applied" as const },
                        }
                      : m,
                  ),
                }
              : c,
          ),
        );
        // SLICE1(composer-isolation): hand the text back to the capsule.
        composerRef.current?.setText((prev) =>
          prev.trim() ? prev : trimmed,
        );
        setStatusLine(
          "Steer not applied — run already finished; text restored to composer",
        );
        return;
      }
      if (result?.status === "follow_up_queued") {
        setStatusLine(
          "Steer converted to follow-up — queued for the next run",
        );
      }
    } catch (e) {
      const failMsg = e instanceof Error ? e.message : String(e);
      setStatusLine(`Steer failed: ${failMsg}`);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.steer?.id === ev.id
                    ? {
                        ...m,
                        steer: { id: ev.id, state: "rejected" as const },
                      }
                    : m,
                ),
              }
            : c,
        ),
      );
    }
  };

  /**
   * F3: take a queued follow-up out of the queue and hand its text back to the
   * composer. Removing a chip never sends anything and never drops the text
   * (the same contract the inline handler had, now shared with the chip UI).
   */
  const removeQueuedFollowUp = (index: number) => {
    const convId = active?.id;
    if (!convId) return;
    const queued = pendingFollowUps[index];
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              pendingFollowUps: (c.pendingFollowUps ?? []).filter((_x, idx) => idx !== index),
            }
          : c,
      ),
    );
    if (index === 0 && queued) {
      // SLICE1(composer-isolation): a chip returning text edits the capsule.
      composerRef.current?.setText((prev) =>
        prev.trim() === queued.trim() ? "" : prev,
      );
    }
  };

  const send = async (text?: string, opts?: { resumeMission?: boolean }) => {
    const convId = active.id;
    const turn = turnFor(convId);
    // SLICE1(composer-isolation): the text comes from the capsule (its textarea
    // state) instead of App's old top-level `draft`; a caller that passes an
    // explicit text (suggestion chip, plan choice, mission resume) still wins.
    const fromSpeech = [
      composerRef.current?.getText() ?? "",
      speech.interim,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    let base = (text ?? fromSpeech).trim();
    if (!base && attachments.length === 0 && !pendingSkill) return;
    // A dispatched prefilled follow-up (§24/D) leaves the queue: the exact
    // match against the oldest entry guards against dropping a queued
    // follow-up the user never sent.
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        const head = c.pendingFollowUps?.[0]?.trim();
        if (!head || head !== base.trim()) return c;
        return { ...c, pendingFollowUps: c.pendingFollowUps?.slice(1) };
      }),
    );

    const liveRunning = runCoordinator.isRunning(convId);
    const skillForSend = pendingSkill;
    if (skillForSend && !liveRunning) {
      base = expandDesktopSkill(skillForSend, base);
      setPendingSkill(null);
    }

    const userVisible =
      base ||
      (attachments.length === 1
        ? `Please review: ${attachments[0].name}`
        : `Please review the attached files (${attachments.length})`);
    const prompt = buildPromptWithAttachments(userVisible, attachments);

    if (liveRunning) {
      const kind = classifyLiveSend({
        running: true,
        steerSupported,
        alreadySteeredThisRun: Boolean(steeredThisRunRef.current[convId]),
      });
      if (kind === "steer") {
        steeredThisRunRef.current[convId] = true;
        setLiveSendMode("queue");
        void steerActiveRun(prompt);
        return;
      }
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                pendingFollowUps: [...(c.pendingFollowUps ?? []), prompt],
              }
            : c,
        ),
      );
      // SLICE1(composer-isolation): queued follow-up clears the capsule.
      composerRef.current?.setText("");
      setAttachments([]);
      setStatusLine("Queued follow-up — sends when this run ends");
      return;
    }
    speech.stop();
    setTextLoopRecovery(false);
    composerRef.current?.clearMention();

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
    // SLICE3(sidecar-batching): a new turn starts — paint the reset now
    // instead of letting the previous run's last batch sit in the window.
    flushSidecarBatches();
    setFollowStream(true);
    followStreamRef.current = true;
    turn.tokens = { prompt: 0, completion: 0, total: 0 };
    turn.startedAt = Date.now();
    // SLICE1(composer-isolation): the capsule is cleared only HERE — the
    // `cli.ok` bail-out above deliberately keeps the typed text, exactly the
    // order the pre-slice `setDraft("")` had.
    composerRef.current?.setText("");
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
        // 2.37 / 2.4: resume .zelari/mission-state.json. Explicit "Riprendi"
        // always sets the flag; follow-up turns in zelari mode auto-resume
        // when a non-success mission exists (first prompt of a conversation
        // still starts fresh). Inline predicate so this send() path does not
        // depend on a new liveTasks import in this constrained pass.
        resumeMission:
          opts?.resumeMission ||
          (mode === "zelari" &&
            mission != null &&
            mission.status !== "success" &&
            (active.messages ?? []).some((m) => m.role === "user")) ||
          undefined,

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
        // Per-tentacle thinking effort (ADR-0017), same per-kind keys as the
        // models above and the same composer popover edits. Empty = inherit.
        krakenExploreThinking: prefs.krakenExploreThinking || undefined,
        krakenGeneralThinking: prefs.krakenGeneralThinking || undefined,
        krakenVerifyThinking: prefs.krakenVerifyThinking || undefined,
        krakenDelegation:
          prefs.krakenDelegation !== "automatic" ? prefs.krakenDelegation : undefined,
        permissionPreset: prefs.permissionPreset,
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

  sendRef.current = send;

  /**
   * Live Tasks "Riprendi": resume the persisted mission of this workspace.
   * Reuses the normal send path (history / spine / todos replay) with the
   * mission flag — the CLI keeps iteration, current slice and budget state in
   * `.zelari/mission-state.json`, so nothing here has to replay them.
   */
  const onResumeMission = () => {
    void send(RESUME_MISSION_PROMPT, { resumeMission: true });
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

  // SLICE1(composer-isolation): ChatComposer is memoised, so every prop it
  // receives must keep its identity across App renders or the memo is dead.
  // `send`/`onStop` and the five pill handlers are render-scoped plain
  // functions (unlike the useCallback helpers around them), so the capsule
  // gets stable wrappers that always call the latest closure.
  const onComposerSend = useCallback((text: string) => {
    void sendRef.current(text);
  }, []);
  const onComposerStop = useStableHandler(onStop);
  const onComposerProviderChange = useStableHandler(onProviderChange);
  const onComposerModelChange = useStableHandler(onModelChange);
  const onComposerThinkingChange = useStableHandler(onThinkingChange);
  const onComposerModeChange = useStableHandler(onModeChange);
  const onComposerPhaseChange = useStableHandler(onPhaseChange);
  const onOpenSkillPicker = useCallback(() => setSkillPickerOpen(true), []);

  // SLICE2(transcript-memo): ChatTranscript is memoised and MessageContent
  // compares its props by value, so the handlers it receives must keep their
  // identity across App renders (= every streaming delta). `send`, `running`
  // and `active?.id` are all render-scoped, hence the stable wrappers below:
  // the decision logic stays in App, the transcript only forwards the events.
  const onTranscriptClarification = useStableHandler((choice: string) => {
    if (runningRef.current) return;
    void sendRef.current(choice);
  });
  /** Conversation the transcript belongs to — stable primitive, not App state. */
  const activeConvId = active?.id;
  const onTranscriptPermissionDecide = useCallback(
    (requestId: string, decision: PermissionDecision) => {
      void (async () => {
        try {
          await permissionRespond(requestId, decision);
        } catch {
          // Sidecar never saw the answer — leave the card pending (CLI
          // deny-timeout is authority).
          return;
        }
        if (!activeConvId) return;
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeConvId
              ? {
                  ...c,
                  messages: applyPermissionSettled(
                    c.messages,
                    requestId,
                    decision,
                  ),
                }
              : c,
          ),
        );
      })();
    },
    [activeConvId],
  );
  const onTranscriptAskUserChoose = useCallback(
    (requestId: string, choice: string) => {
      void askUserRespond(requestId, choice);
      if (!activeConvId) return;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConvId
            ? {
                ...c,
                messages: applyAskUserSettled(c.messages, requestId, choice),
              }
            : c,
        ),
      );
    },
    [activeConvId],
  );

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
        // SLICE1(composer-isolation): Ctrl+N starts with an empty capsule.
        composerRef.current?.setText("");
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

  // SLICE1(composer-isolation): the textarea key handling — @-mention
  // navigation (Escape/Arrow/Tab) and Enter-to-send — moved into ChatComposer
  // together with the `mention`/`mentionHits`/`mentionIndex` state it reads.

  const pickFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        // t66: trust gate for new folders — the same modal the companion
        // path uses; once approved the folder persists in the trusted set.
        const gate = await import("./components/trustGate");
        if (!(await gate.requestDesktopTrust(selected))) {
          setStatusLine("Cartella non attendibile — apertura annullata");
          return;
        }
        // Persist as "last opened workspace" (unchanged) AND switch chats by
        // folder-switch semantics (P0): a virgin chat is rebound in place; a
        // chat with context KEEPS its cwd and a NEW chat is opened on the
        // folder, so a project's spine/history is never contaminated.
        setWorkdir(selected);
        const plan = planFolderSwitch(
          conversationsRef.current,
          activeIdRef.current,
          selected,
        );
        setConversations(plan.conversations);
        if (plan.nextActiveId !== activeIdRef.current) {
          setActiveId(plan.nextActiveId);
          // SLICE1(composer-isolation): a folder switch starts clean.
          composerRef.current?.setText("");
        }
        setStatusLine(
          plan.reboundInPlace
            ? `Cartella: ${selected}`
            : `Cartella: ${selected} — nuova chat su questa cartella`,
        );
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
          <SettingsShell
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
            onDefaultsChange={(nextMode, nextPhase) => {
              setDefaultMode(nextMode);
              setDefaultPhase(nextPhase);
              saveDefaults(nextMode, nextPhase);
              setMode(nextMode);
              setPhase(nextPhase);
            }}
            onProviderModelChange={(nextProvider, nextModel) => {
              // SLICE4(model-sync): Settings → Models & Providers wrote
              // provider.json already (ProviderSection), so this is the chat
              // side of the same change: mark it as an explicit pick so
              // refreshConfig does not revert it, and carry it onto the ACTIVE
              // conversation so re-opening that chat in the sidebar cannot
              // resurrect the old model.
              userPickedModelRef.current = true;
              setProvider(nextProvider);
              setModel(nextModel);
              setConversations((prev) =>
                prev.map((c) =>
                  c.id === activeId
                    ? { ...c, provider: nextProvider, model: nextModel }
                    : c,
                ),
              );
            }}
            activeChatModel={model}
            onPrefsChange={(partial) => {
              setPrefs((prev) => patchDesktopPrefs(prev, partial));
              if (partial.gauntletLoop === true) setKrakenGraph(false);
            }}
          />
        </div>
      </div>
    );
  }

  const showCliSetup =
    !setupDismissed && !cliStatusLoading && cli !== null && !cli.ok;
  // 2.32 B5 — same contract as the TUI first-run gate: CLI ok but doctor
  // red stops the chat until fixed, or until an explicit "Continue anyway".
  const showDoctorGate =
    !showCliSetup && !doctorDismissed && cli?.ok === true && doctorRed !== null;

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
      {showDoctorGate && doctorRed && (
        <DoctorGate
          red={doctorRed}
          onRecheck={refreshCli}
          onContinueAnyway={() => setDoctorDismissed(true)}
        />
      )}
      <div className="app-body" style={{ "--sidebar-w": `${sidebarW}px` } as CSSProperties}>
      <Sidebar
        sessions={visibleSessions}
        filter={sessionFilter}
        activeId={activeId}
        isRunning={runCoordinator.isRunning}
        unseenByConv={unseenByConv}
        collapsedFolders={collapsedFolders}
        onToggleFolder={toggleSessionFolder}
        onNewChat={startNewChat}
        newChatDisabled={running}
        onSelect={onSelectSession}
        onArchive={archiveChat}
        onUnarchive={unarchiveChat}
        onDelete={deleteChat}
        onRename={renameChat}
        onFilterChange={setSessionFilter}
        onOpenSettings={() => setView("settings")}
        cliOk={Boolean(cli?.ok)}
        statusLine={statusLine}
        resizer={{
          onPointerDown: onSidebarResizeStart,
          onPointerMove: onSidebarResizeMove,
          onPointerUp: onSidebarResizeEnd,
          onDoubleClick: resetSidebarWidth,
        }}
        missionVerdictFor={(id) => readMissionVerdict(verificationByConv[id]?.run?.verdict ?? null)}
      />
      <TentacleTracePanel
        agent={tracedLive}
        cwd={activeCwd}
        sessionId={active?.sessionId ?? null}
        onClose={() => setTracedAgent(null)}
      />
      {/* F4: global runs dashboard. The registry is hook-local here, so the
          drawer receives it as a prop; a row only carries an id, and the
          selection handler needs the Conversation (markSeen + mode/phase). */}
      <RunsDashboard
        open={dashboardOpen}
        state={runCoordinator.state}
        conversations={conversations}
        unseenByConv={unseenByConv}
        onSelectSession={(id) => {
          const conv = conversations.find((c) => c.id === id);
          // Run of a deleted chat: nothing to select, the drawer still closes.
          if (conv) onSelectSession(conv);
        }}
        onClose={() => setDashboardOpen(false)}
      />

      <div className="workspace">
      <main className={`main${empty && !running ? " is-empty" : ""}`}>
        <header className="topbar glass-capsule">
          <div className="topbar-left">
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
            {/* F4: the drawer trigger sits here so button and drawer share the
                same (right) corner of the window. App owns `dashboardOpen`. */}
            <RunsTrigger
              activeCount={runsActive}
              onOpen={() => setDashboardOpen(true)}
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
          {sessionTasks.length > 0 || projectTasks.length > 0 || mission ? (
            <LiveTasksPanel
              tasks={sessionTasks}
              projectTasks={projectTasks}
              mission={mission}
              // One run per workspace (host policy): while a run holds it the
              // button is not offered instead of steering the in-flight run.
              onResumeMission={running ? undefined : onResumeMission}
              onClear={() =>
                setConversations((prev) => clearSessionTasks(prev, active.id))
              }
            />
          ) : null}
          <div className="sidecar-diagnostics">
            <button
              type="button"
              className="sidecar-log-toggle"
              aria-expanded={sidecarLogOpen}
              title="Backend CLI stderr (harness sidecar)"
              onClick={() => {
            // SLICE3(sidecar-batching): the diagnostics panel renders the
            // buffered stderr ring — land the pending batch before it opens.
            flushSidecarBatches();
            setSidecarLogOpen((v) => !v);
          }}
            >
              <span aria-hidden>▣</span> Sidecar log
              {sidecarLogLines.length > 0 ? (
                <span className="sidecar-log-count">
                  {sidecarLogLines.length}
                </span>
              ) : null}
            </button>
            {sidecarLogOpen ? (
              <div
                className="sidecar-log-panel"
                ref={sidecarLogPanelRef}
                role="log"
              >
                {sidecarLogLines.length === 0 ? (
                  <div className="sidecar-log-empty">
                    No sidecar stderr captured yet.
                  </div>
                ) : (
                  sidecarLogLines.map((line, i) => (
                    <div
                      key={i}
                      className={
                        isSidecarErrorLine(line)
                          ? "sidecar-log-line is-error"
                          : "sidecar-log-line"
                      }
                    >
                      {line}
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
          <div className="chat-scroll" ref={scrollRef}>
            {sidecarNotice ? (
              <div className="chat-inner" style={{ paddingBottom: 0 }}>
                <div
                  role="alert"
                  style={{
                    border: "1px solid #b00020",
                    background: "#2a1114",
                    color: "#ffb4b4",
                    borderRadius: 8,
                    padding: "10px 14px",
                    margin: "12px 16px 0",
                    fontSize: 13,
                    lineHeight: 1.45,
                  }}
                >
                  <strong>Backend CLI:</strong> {sidecarNotice}
                </div>
              </div>
            ) : null}
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
                  <div className="brand-logo" role="img" aria-label="Zelari" />
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
                {/* SLICE2(transcript-memo): the per-message map moved into
                    the memoised ChatTranscript, so a render that only changed
                    App state (or a delta for the last message) no longer
                    re-parses every reply. It renders a fragment: the live run
                    widgets below stay siblings inside .chat-inner. */}
                <ChatTranscript
                  messages={messages}
                  running={running}
                  onClarificationChoose={onTranscriptClarification}
                  onPermissionDecide={onTranscriptPermissionDecide}
                  onAskUserChoose={onTranscriptAskUserChoose}
                />
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
                <KrakenActivity conversationId={active?.id} />
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
                {missedBelow > 0 ? (
                  <span className="btn-follow-stream-pill">
                    {missedBelow} new
                  </span>
                ) : null}
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
          <QueuedFollowUps
            items={pendingFollowUps}
            running={running}
            onRemove={removeQueuedFollowUp}
          />
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
                    onClick={() => removeAttachment(a.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-stack">
          {/* SLICE1(composer-isolation): the capsule — textarea, @-mention
              popup, pills and send row — owns its own draft state now, so
              typing re-renders it and nothing else (see ChatComposer.tsx). */}
          <ChatComposer
            ref={composerRef}
            running={running}
            placeholder={composerPlaceholder}
            textareaRef={taRef}
            onSend={onComposerSend}
            onStop={onComposerStop}
            speechListening={speech.listening}
            speechOk={speech.speechOk}
            speechInterim={speech.interim}
            speechError={speech.error}
            onToggleSpeech={speech.toggle}
            cliBlocked={cli !== null && !cli.ok}
            attachmentsCount={attachments.length}
            hasPendingSkill={pendingSkill !== null}
            liveSendMode={liveSendMode}
            steerSupported={steerSupported}
            onPickExternalFiles={onPickExternalFiles}
            onOpenSkillPicker={onOpenSkillPicker}
            onAttachPath={attachWorkspacePath}
            mentionCwd={activeCwd}
            config={config}
            provider={provider}
            model={model}
            onProviderChange={onComposerProviderChange}
            onModelChange={onComposerModelChange}
            onThinkingChange={onComposerThinkingChange}
            setConfig={setConfig}
            setStatusLine={setStatusLine}
            prefs={prefs}
            setPrefs={setPrefs}
            mode={mode}
            onModeChange={onComposerModeChange}
            phase={phase}
            onPhaseChange={onComposerPhaseChange}
            krakenGraph={krakenGraph}
            setGraphMode={setGraphMode}
            setGauntletLoop={setGauntletLoop}
          />
          </div>
          {/* Kraken context meter: a compact composer row (one line at rest).
              It used to sit at the bottom of the chat flow, where it ate the
              conversation and could never be dismissed. */}
          <KrakenContextPanel
            live={liveCtx}
            progress={krakenCard?.progress ?? null}
            sessionId={active?.sessionId ?? null}
          />
          <div className="composer-hint">
            {/* experimental/cursor-learn 2.4 — when the next Enter would
                auto-resume (same predicate as send()), say so under the input. */}
            {!running &&
            mode === "zelari" &&
            mission != null &&
            shouldAutoResumeMission({
              mode,
              mission,
              hasPriorUserTurn: (active.messages ?? []).some(
                (m) => m.role === "user",
              ),
            })
              ? `${autoResumeHint(mission)} · `
              : ""}
            {running
              ? liveSendMode === "steer" && steerSupported
                ? "Enter steers at the next tool boundary · later sends queue"
                : "Enter queues a follow-up for when this run ends"
              : "Enter to send · @tag files · paperclip any file · drop to attach"}{" "}
            · {phase}{" "}
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
          // SLICE1(composer-isolation): the tag lands in the capsule.
          composerRef.current?.setText((d) => {
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
