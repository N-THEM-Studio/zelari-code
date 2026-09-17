/**
 * automations/jsonOutput.ts — machine-readable projections for `automation --json`.
 *
 * Kept OUT of cli.ts so the dispatcher stays small. These are pure READS over
 * the registry (no OS scheduling beyond the status probe); the shapes are pinned
 * by jsonOutput.test.ts and consumed verbatim by the Desktop IPC bridge
 * (apps/desktop/src-tauri/src/automations_registry.rs).
 *
 * Contract: every builder returns a plain object that `JSON.stringify` renders
 * as the CLI's stdout line — never a Date, never a class instance.
 */
import { ensureGardenerSpec } from './gardenerMigration.js';
import { osScheduleStatus } from './osSchedule.js';
import { getAutomation, listAutomations, listRuns } from './registry.js';
import { listPending } from './social/approvals.js';
import type { AutomationSpec } from './types.js';

/** One row of `automation list --json`. */
export interface AutomationListJsonItem {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  /** intervalMin / cron / atLogon / timezone as stored on the spec. */
  schedule: { intervalMin?: number; cron?: string; atLogon?: boolean; timezone?: string };
  /** Newest run's status + exit code, or null when the job never ran. */
  lastRun: { status: string; exitCode: number } | null;
  /**
   * The FULL stored spec (null only when the spec file vanished mid-read). Lets
   * the Desktop editor prefill every field (budget, model, social_post) without
   * a second IPC round-trip.
   */
  spec: AutomationSpec | null;
}

/** `automation list --json`. */
export interface AutomationListJson {
  automations: AutomationListJsonItem[];
}

/** One channel outcome inside `automation runs --json`. */
export interface AutomationRunJsonPost {
  channel: string;
  ok: boolean;
  url?: string;
  postId?: string;
  error?: string;
  dryRun?: boolean;
  /** Evidence screenshot path captured by the F3.2 browser publisher, if any. */
  screenshot?: string;
}

/** One human approval decision inside `automation runs --json`. */
export interface AutomationRunJsonApproval {
  at: string;
  decision: 'allow' | 'deny' | 'edit';
  editedText?: string;
}

/** The draft a run produced (text + provenance), when it has one. */
export interface AutomationRunJsonDraft {
  text: string;
  media?: string[];
  warnings?: string[];
  generatedBy?: { source: 'static' | 'llm'; provider?: string; model?: string };
  /** Fresh web research executed before the LLM call (`researchQuery`). */
  research?: { query: string; provider: string; hits: number };
}

/** One run inside `automation runs --json` — the full Desktop evidence record. */
export interface AutomationRunJson {
  runId: string;
  automationId: string;
  status: string;
  exitCode: number;
  reason?: string;
  startedAt: string;
  finishedAt?: string;
  expiresAt?: string;
  draft?: AutomationRunJsonDraft;
  approvals?: AutomationRunJsonApproval[];
  posts: AutomationRunJsonPost[];
  costUsd?: number;
}

/** `automation runs --id <id> --json`. */
export interface AutomationRunsJson {
  id: string;
  runs: AutomationRunJson[];
}

/** One row of `automation pending --json`. */
export interface PendingApprovalsJsonItem {
  runId: string;
  automationId: string;
  draftPreview: string;
  startedAt: string;
  expiresAt?: string;
}

/** `automation pending --json`. */
export interface PendingApprovalsJson {
  approvals: PendingApprovalsJsonItem[];
}

/** `automation status --json`. */
export interface ScheduleStatusJson {
  id: string;
  registered: boolean;
  platform: string;
  detail?: string;
}

/** Summaries of every registered automation, newest run first-slot each. */
export async function listJson(root: string): Promise<AutomationListJson> {
  const items = await listAutomations(root);
  const automations: AutomationListJsonItem[] = [];
  for (const it of items) {
    const spec = await getAutomation(root, it.id);
    const last = (await listRuns(root, it.id, 1))[0];
    automations.push({
      id: it.id,
      name: it.name,
      kind: it.kind,
      enabled: it.enabled,
      schedule: spec?.schedule ?? {},
      lastRun: last ? { status: last.status, exitCode: last.exitCode } : null,
      spec: spec ?? null,
    });
  }
  return { automations };
}

/** Recent runs of one automation (newest first), with per-channel evidence. */
export async function runsJson(root: string, id: string, limit = 20): Promise<AutomationRunsJson> {
  const runs = await listRuns(root, id, limit);
  return {
    id,
    runs: runs.map((r) => ({
      runId: r.runId,
      automationId: r.automationId,
      status: r.status,
      exitCode: r.exitCode,
      reason: r.reason,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      expiresAt: r.expiresAt,
      draft: r.draft
        ? {
            text: r.draft.text,
            media: r.draft.media,
            warnings: r.draft.warnings,
            generatedBy: r.draft.generatedBy,
            research: r.draft.research,
          }
        : undefined,
      approvals: (r.approvals ?? []).map((a) => ({
        at: a.at,
        decision: a.decision,
        editedText: a.editedText,
      })),
      posts: (r.posts ?? []).map((p) => ({
        channel: p.channel,
        ok: p.ok,
        url: p.url,
        postId: p.postId,
        error: p.error,
        dryRun: p.dryRun,
        screenshot: p.screenshot,
      })),
      costUsd: r.costUsd,
    })),
  };
}

/** Every run across automations currently awaiting a human decision. */
export async function pendingJson(root: string): Promise<PendingApprovalsJson> {
  const items = await listPending(root);
  return {
    approvals: items.map((p) => ({
      runId: p.runId,
      automationId: p.automationId,
      draftPreview: p.draftPreview,
      startedAt: p.startedAt,
      expiresAt: p.expiresAt,
    })),
  };
}

/** Whether one automation's OS schedule is currently registered. */
export async function scheduleStatusJson(id: string): Promise<ScheduleStatusJson> {
  const st = await osScheduleStatus(id);
  return { id, registered: st.registered, platform: st.platform, detail: st.detail };
}

/**
 * `automation upsert --json` — echoes the SAVED (validated + defaulted) spec as a
 * single machine-readable line so a caller (the Desktop) can confirm exactly
 * what the registry stored without re-reading it.
 */
export function upsertJson(spec: AutomationSpec): string {
  return JSON.stringify(spec);
}

/** `automation set-enabled --json` — the id whose flag changed + the new value. */
export interface SetEnabledJson {
  id: string;
  enabled: boolean;
}

/** `automation set-enabled --json` — a compact single line (Desktop parses it). */
export function setEnabledJson(spec: AutomationSpec): string {
  const out: SetEnabledJson = { id: spec.id, enabled: spec.enabled };
  return JSON.stringify(out);
}

/**
 * `--json` dispatcher for the READ-ONLY subs. Returns the rendered JSON line, or
 * `undefined` when `sub` is not a JSON-capable read — the caller then falls
 * through to the human path / error handling. Keeps cli.ts's switch untouched.
 */
export async function readOnlyJson(
  sub: string | undefined,
  root: string,
  id: string | undefined,
  rawLimit: string | undefined,
): Promise<string | undefined> {
  switch (sub) {
    case 'list':
      await ensureGardenerSpec(root);
      return JSON.stringify(await listJson(root), null, 2);
    case 'runs': {
      if (!id) return undefined;
      const parsed = rawLimit ? Number.parseInt(rawLimit, 10) : 20;
      const limit = Number.isFinite(parsed) ? parsed : 20;
      return JSON.stringify(await runsJson(root, id, limit), null, 2);
    }
    case 'pending':
      return JSON.stringify(await pendingJson(root), null, 2);
    case 'status':
      return id ? JSON.stringify(await scheduleStatusJson(id), null, 2) : undefined;
    default:
      return undefined;
  }
}
