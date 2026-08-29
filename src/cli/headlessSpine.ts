/**
 * headlessSpine — attach the 2.0 session spine to a headless run.
 *
 * Dual-write is best-effort (same degrade-and-stop as the TUI mirror), but
 * since Exit-1/E1.2 the spine is also the *source* of the headless model
 * context: `seedHeadlessModelHistory()` imports legacy `--history` one-shot
 * into a fresh log and derives prior turns from events.
 * Profile is recorded on `session.started` so same-task / same-profile
 * harness deltas stay comparable (ADR-0022). Interrupt (SIGINT / abort)
 * releases the lock WITHOUT `session.ended` so deriveMissionState can
 * project `interrupted: true` and resume can continue the seq.
 */
import type { BrainEvent } from '@zelari/core/events';
import type { AgentMessage } from '@zelari/core/harness';
import { cleanAgentContent } from '@zelari/core';
import {
  exportSessionJson,
  SessionStore,
  resolveSessionsDir,
  derivedToAgentMessages,
  type DerivedMessage,
  type SessionEventInput,
} from '@zelari/core/session';
import { deriveMissionState } from '@zelari/core/mission';
import { readSessionLog } from '@zelari/core/session';
import path from 'node:path';
import { resolveProfile, toolManifestHash } from '@zelari/core/runtime';
import type { ToolFingerprint } from '@zelari/core';
import { SessionSpineMirror, type SpineMirrorOptions } from './sessionSpine.js';
import { BudgetRuntime, resolveResourceEnforcement } from './budget/budgetRuntime.js';
import { restoreBudgetRuntimeFromSession } from './budget/restoreRuntime.js';
import { noteHarnessLifecycle } from './sessionSpine.js';
import type { SessionVerificationRunSnapshot } from '@zelari/core/verification';
import { defaultProfileForMode, type HeadlessMode } from './headless.js';

export interface HeadlessSpineHandle {
  sessionId: string;
  profileId: string;
  spine: SessionSpineMirror;
  /** Mirror a BrainEvent onto the spine (no-op when degraded/disabled). */
  observe(ev: unknown): void;
  /** Start the per-turn execution budget before deriving model context. */
  beginResourceTurn(): Promise<void>;
  userMessage(text: string): void;
  verificationRun(payload: Record<string, unknown>): void;
  /** 2.6 Phase 3 pre-dispatch resource gate (null = no budget runtime, allow). */
  gateResourceToolCall(toolName: string, args?: unknown): { allowed: boolean; reason?: string; hardLimit?: boolean } | null;
  /** 2.6.1: live budget probe (loop gates, per-turn clamps). */
  resourceBudgetLimit(): { maxToolCalls: number; remaining: number; verificationReserve: number } | null;
  /** 2.6.1: full budget shape for the completion reserve gate (plan §14). */
  resourceBudgetSummary(): import('@zelari/core').ResourceBudget | null;

  /**
   * F3 (ADR-0023 §5): append one spine event and resolve its assigned seq
   * (null when degraded/disabled) — the anchor EvidenceRef.seq points at.
   */
  appendEvent(input: SessionEventInput): Promise<number | null>;
  /** E2.1: last strict verification record from the spine log (null when none/degraded). */
  lastVerificationRun(): Promise<SessionVerificationRunSnapshot | null>;
  missionPhase(phase: string, note?: string): void;
  /** F4: advisory continuation record (state-only spine event). */
  missionProgress(advice: {
    recommendation: string;
    rationale: string;
    blockers?: string[];
    trend?: { tier: string; value: number | null };
    iteration?: number;
  }): void;
  note(text: string, data?: Record<string, unknown>): void;
  /** Clean end: append session.ended + release lock. */
  close(reason?: string): Promise<void>;
  /** Interrupt: release lock WITHOUT session.ended (resumable). */
  interrupt(note?: string): Promise<void>;
  /** Portable JSON export of the spine (empty string when no log). */
  exportJson(): Promise<string | null>;
}

/**
 * E1.4 (ADR-0016/0021): the NDJSON event hosts consume to learn which 2.0
 * spine session this run owns. The Desktop captures it on turn 1 and resumes
 * the same event log (`--resume <id>`) on every following turn, so the model
 * context is derived from the spine instead of replaying 1.x `--history`.
 *
 * Pure factory (no `headless.ts` import) to keep the module graph acyclic;
 * callers pass the result to their own `emitEvent`.
 */
export function sessionStartedEvent(handle: HeadlessSpineHandle): {
  type: 'session_started';
  sessionId: string;
  spine: string;
} {
  return {
    type: 'session_started',
    sessionId: handle.sessionId,
    spine: handle.spine.status,
  };
}

export function resolveHeadlessProfileId(
  mode: HeadlessMode | undefined,
  explicit?: string,
): string {
  if (explicit) return resolveProfile(explicit).id;
  return defaultProfileForMode(mode ?? 'kraken');
}

export async function openHeadlessSpine(opts: {
  sessionId: string;
  mode?: HeadlessMode;
  profile?: string;
  workspace?: string;
  baseDir?: string;
  quiet?: boolean;
  /** 2.6.1 (plan §7): deep tool specs from the run registry (filtered to the profile). */
  toolSpecs?: readonly ToolFingerprint[];
}): Promise<HeadlessSpineHandle> {
  const profileId = resolveHeadlessProfileId(opts.mode, opts.profile);
  let profileTools: readonly string[] = [];
  try {
    profileTools = resolveProfile(profileId).tools;
  } catch {
    profileTools = [];
  }
  const extra: Record<string, unknown> = {
    profile: profileId,
    workspace: opts.workspace ?? process.cwd(),
    toolManifestHash: profileTools.length > 0 ? toolManifestHash(profileTools) : undefined,
  };
  const mirrorOpts: SpineMirrorOptions = {
    baseDir: opts.baseDir,
    workspaceRoot: opts.workspace,
    quiet: opts.quiet,
    extraStarted: extra,
  };
  const spine = await SessionSpineMirror.adopt(opts.sessionId, mirrorOpts);
  if (spine.status === 'active') {
    // 2.6 Track B (Phase 2/3): count tool calls, emit resource.snapshot.
    const budget = new BudgetRuntime(profileId, { enforcement: resolveResourceEnforcement() });
    if (spine.resumedFromSeq !== undefined && spine.resumedFromSeq > 0) {
      // 2.6.1 plan §10: the SAME helper every host uses (parity invariant).
      await restoreBudgetRuntimeFromSession(budget, opts.sessionId, opts.baseDir);
    }
    spine.attachBudgetRuntime(budget);
    // 2.6.1 (plan §6): same lifecycle as the TUI — manifest presence 100%,
    // drift on resume — via the ONE shared host helper.
    // 2.6.1 (plan §7): deep specs filtered to THIS profile’s tool list.
    const manifestSpecs = opts.toolSpecs?.filter((spec) => profileTools.includes(spec.name));
    await noteHarnessLifecycle(
      spine,
      opts.sessionId,
      profileId,
      budget,
      opts.baseDir,
      undefined,
      manifestSpecs && manifestSpecs.length > 0 ? manifestSpecs : undefined,
    );
    spine.note('headless.profile', { profile: profileId, mode: opts.mode ?? 'kraken' });
  }

  return {
    sessionId: opts.sessionId,
    profileId,
    spine,
    observe(ev: unknown): void {
      if (ev && typeof ev === 'object' && 'type' in ev) {
        spine.mirrorBrainEvent(ev as BrainEvent);
      }
    },
    beginResourceTurn(): Promise<void> {
      return spine.beginResourceTurn();
    },
    userMessage(text: string): void {
      spine.userMessage(text);
    },
    gateResourceToolCall(toolName: string, args?: unknown): { allowed: boolean; reason?: string; hardLimit?: boolean } | null {
      return spine.gateResourceToolCall(toolName, args);
    },
    resourceBudgetLimit() {
      return spine.resourceBudgetLimit();
    },
    resourceBudgetSummary() {
      return spine.resourceBudgetSummary();
    },
    verificationRun(payload: Record<string, unknown>): void {
      spine.verificationRun(payload);
    },
    appendEvent(input: SessionEventInput): Promise<number | null> {
      return spine.appendEvent(input);
    },
    lastVerificationRun(): Promise<SessionVerificationRunSnapshot | null> {
      return spine.lastVerificationRun();
    },
    missionPhase(phase: string, note?: string): void {
      spine.missionPhase(phase, note);
    },
    missionProgress(advice: {
      recommendation: string;
      rationale: string;
      blockers?: string[];
      trend?: { tier: string; value: number | null };
      iteration?: number;
    }): void {
      spine.missionProgress(advice);
    },
    note(text: string, data?: Record<string, unknown>): void {
      spine.note(text, data);
    },
    async close(reason = 'host-exit'): Promise<void> {
      await spine.close(reason);
    },
    async interrupt(note?: string): Promise<void> {
      if (note) spine.note('headless.interrupt', { note });
      await spine.release();
    },
    async exportJson(): Promise<string | null> {
      try {
        const store = new SessionStore(resolveSessionsDir({ baseDir: opts.baseDir }));
        if (!(await store.exists(opts.sessionId))) return null;
        return await exportSessionJson(store, opts.sessionId);
      } catch {
        return null;
      }
    },
  };
}

/** One-shot portable export for `--session-export <id>` (no live writer). */
export async function exportSessionById(
  sessionId: string,
  baseDir?: string,
): Promise<{ ok: true; json: string } | { ok: false; error: string }> {
  try {
    const store = SessionStore.withDefaults(baseDir ? { baseDir } : {});
    if (!(await store.exists(sessionId))) {
      return { ok: false, error: `session not found: ${sessionId}` };
    }
    return { ok: true, json: await exportSessionJson(store, sessionId) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Project mission state from a stored spine (resume / inspect). */
export async function missionStateFromSpine(
  sessionId: string,
  baseDir?: string,
): Promise<ReturnType<typeof deriveMissionState> | null> {
  try {
    const store = SessionStore.withDefaults(baseDir ? { baseDir } : {});
    if (!(await store.exists(sessionId))) return null;
    const projection = await store.projection(sessionId);
    return deriveMissionState(projection);
  } catch {
    return null;
  }
}

export interface HeadlessHistorySeed {
  /** Prior-turn model context: what the harness seeds as history. */
  history: AgentMessage[];
  /** How many legacy messages were written into the spine this call. */
  importedCount: number;
  /** Where the seed came from. */
  source: 'spine' | 'spine-import' | 'legacy-fallback';
}

/**
 * Exit-1/E1.2 — the session spine is the model-context source of truth.
 *
 * Call this BEFORE `handle.userMessage(task)` so the derived history
 * excludes the current turn.
 *
 * - Fresh log + legacy `--history` → import each turn as spine events
 *   (one-shot migration), then derive from events.
 * - Existing log (resume) → derive from events; legacy input is ignored
 *   (spine wins over the 1.x rolling JSON).
 * - Degraded / disabled spine (ZELARI_SESSION_SPINE=0) → declared discrete
 *   fallback to the filtered legacy seed, i.e. the pre-spine behavior.
 */
export async function seedHeadlessModelHistory(
  handle: HeadlessSpineHandle,
  legacy?: readonly AgentMessage[],
): Promise<HeadlessHistorySeed> {
  const mirror = handle.spine;
  const legacySeed = filterLegacySeed(legacy);
  if (mirror.status !== 'active') {
    return { history: legacySeed, importedCount: 0, source: 'legacy-fallback' };
  }
  const existing = await mirror.derivedPriorTurns();
  if (existing && existing.length > 0) {
    return { history: derivedModelSeed(existing), importedCount: 0, source: 'spine' };
  }
  if (legacySeed.length === 0) {
    return { history: [], importedCount: 0, source: 'spine' };
  }
  for (const m of legacySeed) {
    if (m.role === 'user') {
      // Historical import is not a live execution turn and must not reset or
      // emit the per-turn resource epoch before the actual current prompt.
      mirror.userMessage(m.content, { beginResourceTurn: false, imported: 'legacy-history' });
    } else {
      mirror.assistantMessage(m.content, { imported: 'legacy-history' });
    }
  }
  await mirror.flush();
  const derived = (await mirror.derivedPriorTurns()) ?? [];
  return {
    history: derivedModelSeed(derived),
    importedCount: legacySeed.length,
    source: 'spine-import',
  };
}

/** Same seed policy as the pre-spine path: user/assistant, scrubbed, non-empty. */
function filterLegacySeed(legacy?: readonly AgentMessage[]): AgentMessage[] {
  return (legacy ?? [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) =>
      m.role === 'assistant' && m.content
        ? {
            role: 'assistant' as const,
            content: cleanAgentContent(m.content, {
              stripQuestion: false,
              stripThink: false,
            }),
          }
        : { role: m.role as 'user' | 'assistant', content: m.content ?? '' },
    )
    .filter((m) => (m.content ?? '').trim().length > 0);
}

/**
 * DerivedMessage[] → harness seed (Exit-1 shared policy, headless + TUI).
 *
 * - user/assistant pass through (assistant scrubbed with the binding
 *   policy: keep <think> and ---QUESTION--- blocks);
 * - compacted summaries (system role) map to a user message — the 1.x
 *   store's own convention — so pre-compaction context survives without
 *   a mid-stream system message;
 * - tool results are dropped: derived results carry no paired assistant
 *   tool_calls block (deriveMessages default), which providers reject.
 */
export function derivedModelSeed(derived: readonly DerivedMessage[]): AgentMessage[] {
  return derivedToAgentMessages(derived)
    .map((m) =>
      m.role === 'system'
        ? { ...m, role: 'user' as const }
        : m,
    )
    .map((m) =>
      m.role === 'assistant' && m.content
        ? {
            ...m,
            content: cleanAgentContent(m.content, {
              stripQuestion: false,
              stripThink: false,
            }),
            ...(m.seq !== undefined ? { seq: m.seq } : {}),
          }
        : m,
    )
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => (m.content ?? '').trim().length > 0);
}
