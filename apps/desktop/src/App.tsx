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
  onSidecarStatus,
  type SidecarStatusPayload,
  permissionRespond,
  askUserRespond,
  runTask,
  setAppConfig,
  summarizeToolArgs,
} from "./agentClient";
import {
  applyAskUserSettled,
  applyPermissionSettled,
  askUserAskFromEvent,
  permissionAskFromEvent,
} from "./inChatAsk";
// WS2 (inbox as notification bus): frames → at most one native notification per
// signal. Pref + permission + focus gated, no Rust dependency (WebView2 API).
import { createInboxNotifier, currentNotifyPermission } from "./inboxNotify";
import { loadConversations, saveConversations } from "./chatStorage";
import { useDebouncedSave } from "./hooks/useDebouncedSave";
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
  MessageStats,
  SessionFilter,
  WorkPhase,
} from "./types";
import { checkForDesktopUpdate } from "./updater";
import { useSpeechToText } from "./hooks/useSpeechToText";
import {
  flushSidecarBatches,
  useBatchedState,
} from "./hooks/useSidecarBatch";
import { Composer, type ComposerHandle } from "./components/Composer";
import { ChatList, type PermissionDecision } from "./components/ChatList";
import { SidecarLogPanel } from "./components/SidecarLogPanel";
import { accentStyle } from "./theme/accent";
import { applyBaffettiTheme } from "./theme/baffetti";
import "./App.css";
import "./theme/baffetti.css";

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

/** IDE round: collapsed sidebar = minimal icon rail. Persisted as "1"/"0". */
const SIDEBAR_COLLAPSED_W = 46;
const LS_SIDEBAR_COLLAPSED = "zelari-desktop-sidebar-collapsed";

/** IDE round: which conversations are "open" like editor tabs, plus the one
 * that was active — restored on the next launch. */
const LS_OPEN_TABS = "zelari-desktop-open-tabs";

type OpenTabsState = { tabs: string[]; active?: string };

/** Tolerant reader for the open-tab strip: only tabs whose conversation still
 * exists (and is not archived) survive; the active tab falls back to the
 * first survivor. Returns null when nothing usable is stored. */
function loadOpenTabsState(convs: Conversation[]): OpenTabsState | null {
  try {
    const raw = localStorage.getItem(LS_OPEN_TABS);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OpenTabsState> | null;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    const live = new Set(convs.filter((c) => !c.archived).map((c) => c.id));
    const tabs = parsed.tabs.filter(
      (t): t is string => typeof t === "string" && live.has(t),
    );
    if (tabs.length === 0) return null;
    const active =
      typeof parsed.active === "string" && tabs.includes(parsed.active)
        ? parsed.active
        : tabs[0] ?? "";
    return { tabs, active };
  } catch {
    return null;
  }
}

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
  /** W2.1: raw (unscrubbed) text accumulated for this turn's live bubble.
   *  The source of truth: deltas append here (never one char per event — the
   *  Rust side coalesces ~40 ms) and the throttled commit reads it, so no
   *  text can be lost or duplicated by the rAF/throttle. Reset per bubble. */
  streamRaw: string;
  /** W2.4: pending requestAnimationFrame id for the streaming commit (0=none). */
  streamRaf: number;
  /** W2.1: pending scrub-cadence timeout id (0=none). */
  streamTimer: number;
  /** W2.1: epoch ms of the last live scrub commit (throttle anchor). */
  streamScrubbedAt: number;
}

/** W2.1: live-scrub cadence for the streaming transcript (ms). The commit
 *  reads the raw ref, so a slower cadence only makes the visible bubble lag
 *  the ref by at most this much — it never drops text. */
const STREAM_SCRUB_MS = 250;

type StreamUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

/** True if a/b refer to the same council member (id preferred, else name). */
function isSameMember(
  a: { name?: string; id?: string },
  b: { name?: string; id?: string },
): boolean {
  if (a.id && b.id) return a.id === b.id;
  if (a.name && b.name)
    return (
      a.name.localeCompare(b.name, undefined, { sensitivity: "accent" }) === 0
    );
  // Only one side known → cannot prove switch; treat as same only if both empty
  if (!a.id && !a.name && !b.id && !b.name) return true;
  // One known, other empty → keep current bubble (tools mid-turn)
  if ((!a.id && !a.name) || (!b.id && !b.name)) return true;
  return false;
}

function memberMatches(
  m: ChatMessage,
  member: { name?: string; id?: string },
): boolean {
  if (m.role !== "assistant") return false;
  return isSameMember({ name: m.memberName, id: m.memberId }, member);
}

function usageStats(u: StreamUsage): MessageStats {
  const total =
    u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
  return {
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    totalTokens: total,
  };
}

/** Replace a single conversation in the array, leaving every other element's
 *  object identity untouched (W2.2: only the active chat + the target message
 *  are rewritten per streaming commit). */
function replaceConversation(
  prev: Conversation[],
  ci: number,
  next: Conversation,
): Conversation[] {
  const out = prev.slice();
  out[ci] = next;
  return out;
}

/**
 * W2.1/W2.2: write the (already scrubbed) live text of the turn's target
 * assistant bubble. Resolves the bubble with the SAME rules the old per-delta
 * handler used (resume this turn's card, else the trailing assistant of the
 * same member, else create one) but replaces ONLY that one message inside ONLY
 * that one conversation — no whole-store remap, no fresh copies of unrelated
 * objects.
 */
function applyStreamContent(
  prev: Conversation[],
  convId: string,
  turn: TurnCtx,
  text: string,
  final: boolean,
  usage?: StreamUsage,
): Conversation[] {
  const ci = prev.findIndex((c) => c.id === convId);
  if (ci === -1) return prev;
  const conv = prev[ci];

  // Resume the current turn's bubble if it still exists and still belongs to
  // the current member; otherwise fall back to the trailing assistant card.
  let aid = turn.assistantId;
  if (aid) {
    const open = conv.messages.find((m) => m.id === aid);
    if (!open || !memberMatches(open, turn.member)) aid = null;
  }
  if (!aid) {
    let lastIdx = -1;
    for (let i = conv.messages.length - 1; i >= 0; i -= 1) {
      if (conv.messages[i].role !== "tool") {
        lastIdx = i;
        break;
      }
    }
    const last = lastIdx >= 0 ? conv.messages[lastIdx] : undefined;
    if (last?.role === "assistant" && memberMatches(last, turn.member)) {
      aid = last.id;
      turn.assistantId = aid;
    } else {
      aid = uid("asst");
      turn.assistantId = aid;
      const bubble: ChatMessage = {
        id: aid,
        role: "assistant",
        content: text,
        createdAt: Date.now(),
        streaming: !final,
        memberName: turn.member.name,
        memberId: turn.member.id,
        ...(final && usage ? { stats: usageStats(usage) } : {}),
      };
      return replaceConversation(prev, ci, {
        ...conv,
        updatedAt: Date.now(),
        messages: [...conv.messages, bubble],
      });
    }
  }

  const targetIdx = conv.messages.findIndex((m) => m.id === aid);
  if (targetIdx === -1) return prev;
  const target = conv.messages[targetIdx];
  const nextMsg: ChatMessage = {
    ...target,
    content: text,
    streaming: !final,
    memberName: turn.member.name ?? target.memberName,
    memberId: turn.member.id ?? target.memberId,
    ...(final && usage
      ? { stats: { ...target.stats, ...usageStats(usage) } }
      : {}),
  };
  const messages = conv.messages.slice();
  messages[targetIdx] = nextMsg;
  return replaceConversation(prev, ci, {
    ...conv,
    updatedAt: Date.now(),
    messages,
  });
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

  // W1.3: start from an EMPTY store and hydrate AFTER first paint. Reading and
  // parsing the whole localStorage store (~80 chats) inside the useState
  // initializer blocked the first paint; consumers are all active?.… null-safe,
  // so one render with the empty store is tolerated before hydration lands.
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  /** True once the initial localStorage load has been applied. Gates the
   * debounced save so the empty first paint can never overwrite the store. */
  const hydratedRef = useRef(false);

  // W1.3: mount-only, post-paint hydration. In dev StrictMode the effect runs
  // twice (mount → cleanup → mount); the ref guard keeps it to a single load.
  useEffect(() => {
    if (hydratedRef.current) return;
    const stored = loadConversations();
    const next =
      stored && stored.length > 0
        ? stored
        : [newConversation(defaults.mode, defaults.phase)];
    hydratedRef.current = true;
    setConversations(next);
    // IDE round: restore the open-tab strip (and the tab that was active)
    // when every stored conversation still exists; otherwise default to the
    // first active chat. The auto-open effect below would re-add the active
    // tab anyway, but restoring keeps the whole previous strip.
    const restored = loadOpenTabsState(next);
    if (restored) {
      setOpenTabs(restored.tabs);
      setActiveId(restored.active ?? restored.tabs[0] ?? "");
    } else {
      const first = next.find((c) => !c.archived)?.id ?? next[0].id;
      setOpenTabs([first]);
      setActiveId(first);
    }
  }, [defaults.mode, defaults.phase]);

  /** Imperative handle to the Composer, which owns the input text (W3.2). */
  const composerRef = useRef<ComposerHandle>(null);
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

  /** IDE round: collapsed sidebar (icon rail), persisted. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_SIDEBAR_COLLAPSED) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_SIDEBAR_COLLAPSED, sidebarCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [sidebarCollapsed]);

  /** IDE round: open-chat tabs, like editor file tabs. */
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  // Auto-open: whatever becomes active lands in the strip (idempotent).
  useEffect(() => {
    if (!activeId || openTabs.includes(activeId)) return;
    setOpenTabs((prev) => (prev.includes(activeId) ? prev : [...prev, activeId]));
  }, [activeId, openTabs]);
  // Persist the strip + the active tab for the next launch.
  useEffect(() => {
    try {
      localStorage.setItem(
        LS_OPEN_TABS,
        JSON.stringify({ tabs: openTabs, active: activeId }),
      );
    } catch {
      /* ignore */
    }
  }, [openTabs, activeId]);
  // Drop tabs whose conversation was deleted or archived (an archived chat
  // leaves the active list, so its tab must close too).
  useEffect(() => {
    setOpenTabs((prev) => {
      const next = prev.filter((id) =>
        conversations.some((c) => c.id === id && !c.archived),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [conversations]);

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
  /** Per-conversation live run UI (M2 multiplexing), keyed by conversation. */
  /**
   * SLICE3(sidecar-batching): these five slices are written by the sidecar
   * event burst and only READ by the render body (the tool carousel, the
   * kraken/verification/gauntlet cards) — nothing branches on their current
   * value mid-stream. They go through the coalescing holder so a burst of
   * tentacle/tool/progress events produces ONE app commit instead of one per
   * event; `flushSidecarBatches()` lands the pending batch at message and run
   * boundaries. The chat stream itself is NOT batched here — `message_delta`
   * is coalesced Rust-side (delta_coalescer.rs) and stays on its own path.
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
  // WS2: the notification bus reads the CURRENT pref on every event — the
  // agent-event subscription below is created once and must not close over a
  // stale `prefs`.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

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

  /**
   * When true, chat auto-scrolls with the stream; user scroll-up detaches.
   * The REF is the single source of truth for scroll gating; the STATE only
   * drives rendering (the follow button). Never sync the ref from the render
   * body: while streaming, re-renders fired by stream deltas land in separate
   * macrotasks and can run BEFORE the scroll handler's state update commits —
   * the stale `true` written back into the ref reopened the stick-to-bottom
   * gate and yanked the reader back down ("occasionally it pulls me down
   * while I read history"). Every flip MUST go through setFollowStream,
   * which writes ref+state together.
   */
  const [followStream, _setFollowStream] = useState(true);
  const followStreamRef = useRef(true);
  const setFollowStream = useCallback((v: boolean) => {
    followStreamRef.current = v;
    _setFollowStream(v);
  }, []);
  /** Ignore scroll events caused by programmatic stick-to-bottom. */
  const programmaticScrollRef = useRef(false);
  /** Stream ticks that landed below the viewport while detached; shown as
   *  a pill on the follow button so the user knows what they jumped back to. */
  const [missedBelow, setMissedBelow] = useState(0);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  /** When set, next send expands this skill around the user draft. */
  const [pendingSkill, setPendingSkill] = useState<SkillEntryDto | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
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
        streamRaw: "",
        streamRaf: 0,
        streamTimer: 0,
        streamScrubbedAt: 0,
      };
      turnsRef.current.set(convId, t);
    }
    return t;
  };
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // W2.1/W2.4: streaming commit pipeline. The raw deltas live in each turn's
  // `streamRaw` (the source of truth); these helpers coalesce the expensive
  // scrub + setState so a burst of deltas costs at most one commit per
  // animation frame and re-scrubs the full accumulated text at most once
  // every STREAM_SCRUB_MS. Before this it was a full conversations remap plus
  // a full-text scrub PER TOKEN (the O(N²) the plan targets).
  const cancelStreamSchedule = useCallback((turn: TurnCtx) => {
    if (turn.streamTimer) {
      window.clearTimeout(turn.streamTimer);
      turn.streamTimer = 0;
    }
    if (turn.streamRaf) {
      cancelAnimationFrame(turn.streamRaf);
      turn.streamRaf = 0;
    }
  }, []);

  const commitStreamText = useCallback(
    (convId: string, turn: TurnCtx, final: boolean, usage?: StreamUsage) => {
      turn.streamTimer = 0;
      turn.streamRaf = 0;
      const text = scrubDisplayText(turn.streamRaw, { streaming: !final });
      turn.streamScrubbedAt = Date.now();
      setConversations((prev) =>
        applyStreamContent(prev, convId, turn, text, final, usage),
      );
      // Seed the ref with the committed (scrubbed) text so a later message
      // part of the same turn resumes from exactly what the display shows —
      // matching the old per-delta base (`m.content + delta`).
      if (final) turn.streamRaw = text;
    },
    [],
  );

  const scheduleStreamCommit = useCallback(
    (convId: string, turn: TurnCtx) => {
      if (turn.streamRaf || turn.streamTimer) return;
      const run = () => {
        turn.streamRaf = 0;
        commitStreamText(convId, turn, false);
      };
      const since = Date.now() - turn.streamScrubbedAt;
      if (since >= STREAM_SCRUB_MS) {
        // Leading edge: the first paint of a bubble lands on the next frame.
        turn.streamRaf = requestAnimationFrame(run);
      } else {
        // Trailing edge: at most one live scrub per STREAM_SCRUB_MS.
        turn.streamTimer = window.setTimeout(() => {
          turn.streamTimer = 0;
          if (turn.streamRaf) return;
          turn.streamRaf = requestAnimationFrame(run);
        }, STREAM_SCRUB_MS - since);
      }
    },
    [commitStreamText],
  );

  const flushStreamCommit = useCallback(
    (convId: string, turn: TurnCtx, usage?: StreamUsage) => {
      cancelStreamSchedule(turn);
      if (!turn.assistantId && !turn.streamRaw) return;
      commitStreamText(convId, turn, true, usage);
    },
    [cancelStreamSchedule, commitStreamText],
  );

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


  // W1.2: persist chats through a trailing debounce (~500 ms) instead of on
  // every `conversations` change — during streaming that was one full
  // stringify + localStorage write PER TOKEN (typing jank, O(N²) growth). The
  // ACTIVE conversation keeps its guaranteed storage slot (cap-aware selection
  // in chatStorage) and quota failures still surface on the status line. EVERY
  // mutation schedules a save here; critical boundaries call flushSave()
  // explicitly (run finished, switch/delete/new, page unload) for promptness.
  const persistConversations = useCallback(() => {
    if (!hydratedRef.current) return;
    const res = saveConversations(conversationsRef.current, {
      activeId: activeIdRef.current,
    });
    if (!res.ok) {
      console.warn("[zelari] chat save failed:", res.error);
      setStatusLine(
        `Chats not saved (local storage full) — ${res.error ?? "unknown error"}`,
      );
    }
  }, []);
  const { schedule: scheduleSave, flush: flushSave } = useDebouncedSave(
    persistConversations,
    500,
    2500,
  );
  useEffect(() => {
    if (!hydratedRef.current) return;
    scheduleSave();
  }, [conversations, scheduleSave]);

  // W1.2 flush point (c): a pending debounced save must survive the window
  // closing or being hidden. localStorage writes are synchronous, so flush
  // directly from the unload/hide handlers.
  useEffect(() => {
    const onHide = () => flushSave();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushSave();
    };
    window.addEventListener("beforeunload", onHide);
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushSave]);

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
  // Auto-dispatch the oldest follow-up AFTER React applies run-finished.
  // The Tauri handler must not call send() in the same tick: `running` and
  // `isRunning()` are still stale, so the follow-up was re-steered / dropped.
  useEffect(() => {
    const convId = activeId;
    if (!convId || !autoSendAfterRunRef.current.has(convId)) return;
    if (runCoordinator.isRunning(convId)) return;
    const queued = conversations.find((c) => c.id === convId)?.pendingFollowUps?.[0];
    const composerDraft = composerRef.current?.getValue() ?? "";
    const text = shouldAutoSendFollowUp({
      queued,
      draft: composerDraft,
      wasCancelled: false,
    });
    if (!text) {
      if (
        queued &&
        composerDraft.trim() &&
        composerDraft.trim() !== queued.trim()
      ) {
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

  // Quiet update checks — only status line; install lives in Settings.
  // W1.4: schedule the (network) check at browser IDLE so it never competes
  // with mount/boot work; fall back to a delayed timeout where
  // requestIdleCallback is unavailable. Same check logic + UX, only WHEN.
  useEffect(() => {
    let cancelled = false;
    const runCheck = () => {
      if (cancelled) return;
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
    };
    // StrictMode double-invokes this effect: the cleanup cancels the first
    // scheduling (and `cancelled` guards a late idle callback), so exactly one
    // check runs.
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(runCheck, { timeout: 8000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(id);
      };
    }
    const t = window.setTimeout(runCheck, 8000);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, []);

  // W4.3: warm the harness sidecar at browser IDLE so the one-time sidecar
  // spawn + boot handshake are already paid by the time the first message is
  // sent. Fire-and-forget: if it has not finished, the lazy path in the first
  // turn is unchanged. Mirrors the update-check effect above — one guarded
  // scheduling (StrictMode-safe), no new state/props.
  useEffect(() => {
    let cancelled = false;
    const prefetch = () => {
      if (cancelled) return;
      void (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("prefetch_harness_sidecar");
        } catch {
          /* best-effort: the first turn still spawns the sidecar on demand */
        }
      })();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(prefetch, { timeout: 4000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(id);
      };
    }
    const t = window.setTimeout(prefetch, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
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
      composerRef.current?.updateValue((prev) =>
        prev ? `${prev.trimEnd()} ${piece}` : piece,
      );
    },
  });

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      // WS2 (inbox as notification bus): the notifier is created with the
      // subscription, so ONE dedupe memory covers the whole stream. Its gate is
      // read per event (pref flip / permission change apply immediately).
      const inboxNotifier = createInboxNotifier({
        gate: () => ({
          enabled: prefsRef.current.inboxNotifications,
          permission: currentNotifyPermission(),
          focused: typeof document !== "undefined" && document.hasFocus(),
        }),
      });
      const u1 = await onAgentEvent((ev) => {
        if (cancelled) return;
        // Chat-agnostic on purpose: "waiting on you" does not depend on which
        // conversation is open, so the bus sees every frame (including the
        // ones the routing gate below drops).
        inboxNotifier.onEvent(ev as unknown as Record<string, unknown>);
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
              composerRef.current?.updateValue((prev) =>
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

        const switchToMember = (next: {
          name?: string;
          id?: string;
        }) => {
          const prev = turn.member;
          const hasNext = Boolean(next.name || next.id);
          if (!hasNext) return;
          const changed =
            Boolean(prev.name || prev.id) && !isSameMember(prev, next);
          if (changed) {
            // Finalize the outgoing member's bubble from the raw ref while
            // `turn.member` still carries the OLD attribution, then start a
            // fresh card for the new member.
            flushStreamCommit(convId, turn);
            turn.streamRaw = "";
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
          turn.member = {
            name: next.name ?? prev.name,
            id: next.id ?? prev.id,
          };
          if (next.name) {
            setLiveMemberNameFor(convId, next.name);
            setStatusLineIfActive(`${next.name} speaking…`);
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
          if (turn.member.name) setLiveMemberNameFor(convId, turn.member.name);
          // Text is streaming — clear tool line so member focus shows.
          clearToolLabelTimer(convId);
          setLiveToolLabelFor(convId, null);

          // W2.1/W2.2/W2.4: append the raw batch to this turn's ref (the
          // source of truth — deltas arrive coalesced ~40 ms from the Rust
          // side, never one char per event) and schedule the throttled commit.
          // The per-token whole-store remap + full-text scrub that used to sit
          // here is gone: the commit rewrites at most one message inside the
          // one active conversation, at most once per animation frame, and
          // re-scrubs at most once every STREAM_SCRUB_MS. The bubble is
          // resolved/created by the commit (or by the end-of-turn flush), so
          // no delta can be dropped.
          turn.streamRaw += delta;
          scheduleStreamCommit(convId, turn);
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
          // W2.1: finalize the turn's bubble with the EXACT final scrub over
          // the full accumulated text (the same result the old code produced)
          // and fold in the usage stats — one commit, no whole-store remap.
          // flushStreamCommit is a no-op when nothing was streamed.
          flushStreamCommit(convId, turn, usage);
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
                        // SystemNotice words assistant_text_loop's next step
                        // itself (keyed on `notice.code`).
                        content: msg,
                        notice: {
                          ...(code ? { code } : {}),
                          ...(typeof (ev as { severity?: unknown }).severity === "string"
                            ? { severity: (ev as { severity?: unknown }).severity as string }
                            : {}),
                        },
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
        // screen with the stats below, never one window late.
        flushSidecarBatches();
        // W2.1: land any throttled live commit as final before reading the
        // bubble and attaching run stats (the run is settling; no more
        // deltas). No-op when nothing is pending.
        flushStreamCommit(convId, turn);
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
        // W1.2 flush point (a): persist the settled run promptly instead of
        // waiting out the trailing debounce.
        flushSave();
      });
      if (cancelled) u3();
      else unsubs.push(u3);
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
      unsubs.length = 0;
    };
  }, [refreshCli, flushSave]);

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
    composerRef.current?.setValue("");
    setTextLoopRecovery(false);
    composerRef.current?.focus();
    // W1.2 flush point (b): new chat.
    flushSave();
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
    // W1.2 flush point (b): conversation switch — persist the chat we are
    // leaving before wiring the new one.
    flushSave();
  };

  /** IDE round: close one open tab. Closing the ACTIVE tab activates the
   *  neighbour (previous first, like an editor); with no candidates left the
   *  first active chat becomes the new tab. The run registry keeps tracking a
   *  closed chat's run in the background: it can be re-opened anytime. */
  const closeTab = (id: string) => {
    const idx = openTabs.indexOf(id);
    const remaining = openTabs.filter((t) => t !== id);
    setOpenTabs(remaining);
    if (id !== activeId) return;
    const neighbourId = idx > 0 ? remaining[idx - 1] : undefined;
    const pick =
      (neighbourId
        ? conversations.find((c) => c.id === neighbourId && !c.archived)
        : undefined) ??
      remaining
        .map((t) => conversations.find((c) => c.id === t && !c.archived))
        .find((c): c is Conversation => Boolean(c)) ??
      conversations.find((c) => c.id !== id && !c.archived);
    if (pick) {
      onSelectSession(pick);
    } else {
      startNewChat();
    }
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
    // W1.2 flush point (b): archive switches the active chat when it hits it.
    flushSave();
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
    // W1.2 flush point (b): delete — persist immediately, do not wait.
    flushSave();
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

  const onSelectSkill = useCallback((skill: SkillEntryDto) => {
    setPendingSkill(skill);
    setStatusLine(`Skill selected: ${skill.id} — type a task and send`);
    composerRef.current?.focus();
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
    composerRef.current?.setValue("");
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
        composerRef.current?.updateValue((prev) =>
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
      composerRef.current?.updateValue((prev) =>
        prev.trim() === queued.trim() ? "" : prev,
      );
    }
  };

  const send = async (text?: string, opts?: { resumeMission?: boolean }) => {
    const convId = active.id;
    const turn = turnFor(convId);
    const fromSpeech = [composerRef.current?.getValue() ?? "", speech.interim]
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
      composerRef.current?.setValue("");
      setAttachments([]);
      setStatusLine("Queued follow-up — sends when this run ends");
      return;
    }
    speech.stop();
    setTextLoopRecovery(false);

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
    // W2.1/W2.4: drop any streaming schedule/ref from the previous turn.
    cancelStreamSchedule(turn);
    turn.streamRaw = "";
    turn.streamScrubbedAt = 0;
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
    composerRef.current?.setValue("");
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
        krakenCrossModel: prefs.krakenCrossModel,
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

  // W3.1: stable handlers for the memoized ChatList / MessageContent.
  const onClarificationChoose = useCallback((choice: string) => {
    if (runningRef.current) return;
    void sendRef.current(choice);
  }, []);
  const onPermissionDecide = useCallback(
    (requestId: string, decision: PermissionDecision) => {
      const conv = activeIdRef.current;
      void (async () => {
        try {
          await permissionRespond(requestId, decision);
        } catch {
          // Sidecar never saw the answer — leave the card pending
          // (CLI deny-timeout is authority).
          return;
        }
        if (!conv) return;
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conv
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
    [],
  );
  const onAskUserChoose = useCallback(
    (requestId: string, choice: string) => {
      void askUserRespond(requestId, choice);
      const conv = activeIdRef.current;
      if (!conv) return;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv
            ? {
                ...c,
                messages: applyAskUserSettled(c.messages, requestId, choice),
              }
            : c,
        ),
      );
    },
    [],
  );

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
        composerRef.current?.setValue("");
        composerRef.current?.focus();
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
          composerRef.current?.setValue("");
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

  // Settings → Accent color: an inline custom property on `.app` beats every
  // stylesheet `--accent` (per-mode palettes + the flat token block), so all
  // var(--accent) consumers follow, chat included. Auto → undefined (no-op).
  // `data-accent` switches on the color-mix re-derivation of the derived tokens.
  const accentColor = prefs.accentColor;
  const accentVars = accentStyle(accentColor);

  if (view === "settings") {
    return (
      <div
        className="app app-chrome app-settings"
        data-mode={mode}
        data-theme={theme}
        data-accent={accentColor}
        style={accentVars}
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
      data-accent={accentColor}
      style={accentVars}
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
      <div
        className="app-body"
        style={{
          "--sidebar-w": `${sidebarCollapsed ? SIDEBAR_COLLAPSED_W : sidebarW}px`,
        } as CSSProperties}
      >
      <Sidebar
        sessions={visibleSessions}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
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
        {/* IDE round: ONE bar above the chat — open-chat tabs on the left,
            the global cluster (todos + runs + folder picker) on the right.
            The old topbar row is gone: this single strip reclaims its vertical
            space. Always rendered so the folder picker stays reachable even in
            the empty state; the tablist itself only exists when tabs are open. */}
        <div className="chat-tabbar">
          {openTabs.length > 0 && (
            <div className="chat-tabs" role="tablist" aria-label="Chat aperte">
              {openTabs.map((id) => {
                const c = conversations.find((x) => x.id === id);
                if (!c) return null;
                const tabRunning = runCoordinator.isRunning(id);
                const dotClass = tabRunning
                  ? " is-running"
                  : unseenByConv[id]
                    ? " is-done"
                    : "";
                return (
                  <div
                    key={id}
                    className={`chat-tab${id === activeId ? " active" : ""}`}
                    role="tab"
                    aria-selected={id === activeId}
                    title={c.cwd ? `${c.title} — ${c.cwd}` : c.title}
                    onClick={() => onSelectSession(c)}
                  >
                    <span className={`chat-tab-dot${dotClass}`} aria-hidden />
                    <span className="chat-tab-title">{c.title}</span>
                    <button
                      type="button"
                      className="chat-tab-close"
                      title="Chiudi tab"
                      aria-label={`Chiudi ${c.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="chat-tab-add"
                title="Nuova chat"
                aria-label="Nuova chat"
                onClick={startNewChat}
                disabled={running}
              >
                +
              </button>
            </div>
          )}
          <div className="chat-tabs-right">
            {/* Run-scoped chip: the only summary of session tasks left in the
                chrome (the panel below keeps the full list). */}
            {sessionTasks.length > 0 ? (
              <span className="todo-chip" title="Session tasks from agent">
                {sessionTasks.filter((t) => t.status === "completed").length}/
                {sessionTasks.length} todos
              </span>
            ) : null}
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
        </div>

        <div className="chat-scroll-shell">
          {sessionTasks.length > 0 || projectTasks.length > 0 || mission ? (
            <LiveTasksPanel
              tasks={sessionTasks}
              projectTasks={projectTasks}
              mission={mission}
              // One run per chat (host policy): while this chat runs the
              // button is not offered instead of steering the in-flight run.
              onResumeMission={running ? undefined : onResumeMission}
              onClear={() =>
                setConversations((prev) => clearSessionTasks(prev, active.id))
              }
            />
          ) : null}
          <SidecarLogPanel />
          <div
            className={`chat-scroll${followStream ? "" : " is-detached"}`}
            ref={scrollRef}
          >
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
                <ChatList
                  messages={messages}
                  running={running}
                  onClarificationChoose={onClarificationChoose}
                  onPermissionDecide={onPermissionDecide}
                  onAskUserChoose={onAskUserChoose}
                  conversationId={active?.id}
                  scrollRef={scrollRef}
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
                <KrakenActivity
                  conversationId={active?.id}
                  leadProvider={active?.provider || provider || undefined}
                />
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
              title="Vai alla fine"
              aria-label={
                running && missedBelow > 0
                  ? `Vai alla fine (${missedBelow} aggiornamenti persi)`
                  : "Vai alla fine"
              }
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
                  {/* Down arrow: jump to the bottom */}
                  <path d="M12 5v14" />
                  <path d="m6 13 6 6 6-6" />
                </svg>
              </span>
              {/* Icon-only affordance (IDE-style): the missed count survives as a
                  tiny corner badge, the old kicker/label block is gone. */}
              {missedBelow > 0 ? (
                <span className="btn-follow-stream-pill" aria-hidden>
                  {missedBelow > 99 ? "99+" : missedBelow}
                </span>
              ) : null}
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
          <Composer
            ref={composerRef}
            cwd={activeCwd}
            prefill={running ? "" : (oldestPendingFollowUp ?? "")}
            running={running}
            cliBlocked={cli !== null && !cli.ok}
            mode={mode}
            liveSendMode={liveSendMode}
            steerSupported={steerSupported}
            attachmentCount={attachments.length}
            hasPendingSkill={pendingSkill !== null}
            speech={{
              listening: speech.listening,
              speechOk: speech.speechOk,
              interim: speech.interim,
              error: speech.error,
              toggle: speech.toggle,
            }}
            toolbar={{
              config,
              provider,
              model,
              disabled: running,
              onProviderChange,
              onModelChange,
              onThinkingChange,
              onConfigRefresh: setConfig,
              onStatus: setStatusLine,
              permissionPreset: prefs.permissionPreset,
              onPermissionPresetChange: (permissionPreset) =>
                setPrefs((prev) => patchDesktopPrefs(prev, { permissionPreset })),
              krakenExploreThinking: prefs.krakenExploreThinking,
              onKrakenExploreThinkingChange: (krakenExploreThinking) =>
                setPrefs((prev) => patchDesktopPrefs(prev, { krakenExploreThinking })),
              krakenGeneralThinking: prefs.krakenGeneralThinking,
              onKrakenGeneralThinkingChange: (krakenGeneralThinking) =>
                setPrefs((prev) => patchDesktopPrefs(prev, { krakenGeneralThinking })),
              krakenVerifyThinking: prefs.krakenVerifyThinking,
              onKrakenVerifyThinkingChange: (krakenVerifyThinking) =>
                setPrefs((prev) => patchDesktopPrefs(prev, { krakenVerifyThinking })),
              mode,
              onModeChange,
              phase,
              onPhaseChange,
              krakenGraph,
              onKrakenGraphChange: setGraphMode,
              gauntlet: prefs.gauntletLoop,
              onGauntletChange: setGauntletLoop,
            }}
            onSubmit={(text) => void send(text)}
            onStop={() => void onStop()}
            onPickExternalFiles={() => void onPickExternalFiles()}
            onOpenSkillPicker={() => setSkillPickerOpen(true)}
            onAttachPath={(hit) => void attachWorkspacePath(hit)}
          />
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
          composerRef.current?.updateValue((d) => {
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
