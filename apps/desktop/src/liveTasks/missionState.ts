/**
 * Pure view + Italian labels for the persisted Zelari mission
 * (`.zelari/mission-state.json`, written by src/cli/zelariMission.ts).
 *
 * No Tauri import on purpose: the sandboxed read lives in `missionStateIo.ts`
 * so render tests of LiveTasksPanel keep a module graph free of
 * `@tauri-apps/api` (same split as workspacePlan / workspacePlanIo).
 */

/** Status set persisted by the mission driver (`MissionStatus`, zelariMission.ts). */
export type MissionStatusView =
  | "running"
  | "success"
  | "stopped"
  | "stalled"
  | "cancelled"
  | "error";

/**
 * Minimal projection of the CLI's `MissionState`. Only the fields the Live
 * Tasks pill needs are mapped; everything else (brief, trace, repairHistory,
 * cumulativeCostUsd, …) is ignored, so the reader stays forward compatible.
 * Field names keep the CLI ones (`currentSliceId`, `iteration`) instead of
 * inventing aliases.
 */
export interface MissionStateView {
  missionId: string;
  /** Persisted status; unknown strings are kept verbatim, absent → "unknown". */
  status: string;
  /** Slice the resume will continue from (`.currentSliceId` on disk). */
  currentSliceId?: string;
  /** Implementation iteration already completed. */
  iteration?: number;
  /** Last slice completion verdict. */
  lastCompletionOk?: boolean;
  /** ISO timestamp of the last persistence. */
  updatedAt?: string;
}

const STATUS_LABELS: Record<string, string> = {
  running: "in corso",
  success: "completata",
  stopped: "ferma",
  stalled: "in stallo",
  cancelled: "annullata",
  error: "errore",
  unknown: "stato ignoto",
};

/** Italian label of a persisted mission status (unknown values pass through). */
export function missionStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * Tolerant parse of the raw mission JSON. Returns null when the payload is not
 * a mission state (missing/blank `missionId`): a corrupt or half-written file
 * means "no mission pill", never a thrown error in the UI.
 */
export function parseMissionState(raw: unknown): MissionStateView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const missionId = typeof o.missionId === "string" ? o.missionId.trim() : "";
  if (!missionId) return null;

  const status =
    typeof o.status === "string" && o.status.trim() ? o.status.trim() : "unknown";
  const view: MissionStateView = { missionId, status };

  const slice = o.currentSliceId;
  if (typeof slice === "string" && slice.trim()) view.currentSliceId = slice.trim();
  if (typeof o.iteration === "number" && Number.isFinite(o.iteration)) {
    view.iteration = o.iteration;
  }
  if (typeof o.lastCompletionOk === "boolean") view.lastCompletionOk = o.lastCompletionOk;
  if (typeof o.updatedAt === "string" && o.updatedAt) view.updatedAt = o.updatedAt;
  return view;
}

/**
 * Same rule as the CLI (`isResumableMission`): only a green mission is final —
 * running/stopped/stalled/cancelled/error (and unknown) can be resumed.
 */
export function isMissionResumable(view: MissionStateView): boolean {
  return view.status !== "success";
}

/**
 * One-line row label: `m_1a2b3c4d · slice s2 · iter 3`. The panel supplies the
 * "Missione" heading and the status chip, so neither is repeated here. Missing
 * parts are dropped instead of rendering "undefined".
 */
export function missionRowLabel(view: MissionStateView): string {
  const parts = [view.missionId];
  if (view.currentSliceId) parts.push(`slice ${view.currentSliceId}`);
  if (typeof view.iteration === "number") parts.push(`iter ${view.iteration}`);
  return parts.join(" · ");
}

/**
 * Slice 2.4 — follow-up chat turns resume the cwd mission instead of
 * starting a new one. First prompt of a conversation stays a fresh start
 * (use the Live Tasks "Riprendi" button / `explicit` for that).
 * Council/Kraken modes never auto-resume: missions are Zelari-only.
 */
export function shouldAutoResumeMission(args: {
  mode?: string;
  mission: MissionStateView | null | undefined;
  hasPriorUserTurn: boolean;
  explicit?: boolean;
}): boolean {
  if (args.explicit) return true;
  if (args.mode !== "zelari") return false;
  if (!args.mission || !isMissionResumable(args.mission)) return false;
  return args.hasPriorUserTurn;
}

/** One-line composer hint when the next Enter would resume. */
export function autoResumeHint(view: MissionStateView): string {
  return `Riprenderà la missione ${view.missionId} · ${missionStatusLabel(view.status)}`;
}
