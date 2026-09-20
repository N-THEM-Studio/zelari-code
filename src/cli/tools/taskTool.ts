/**
 * taskTool — delegate a bounded sub-task to an isolated sub-agent (Kraken tentacle).
 *
 * Isolation & safety:
 *   - explore / verify: READ-ONLY (or read+bash for verify)
 *   - general: full tools except nested `task` (no recursion)
 *   - Parent gets only a short conclusion, not the full sub-transcript
 *   - Optional git worktree for general when ZELARI_KRAKEN_WORKTREE=1|true|auto
 *   - Radio JSONL under .zelari/radio/ for parent observability
 *
 * Structure (F2 — Kraken graph engine):
 *   - `runTentacle()` is the standalone, exported core run (worktree + radio +
 *     live + harness + merge + footer). It has NO spawn-cap so the graph
 *     executor can drive many tentacles directly.
 *   - The `task` tool's `execute` is a thin wrapper that applies the per-turn
 *     spawn cap and maps the TentacleResult back to typedOk/typedErr.
 *
 * @since v0.7.x · typed agents v1.21.0 · Kraken contracts v1.x · graph F2
 */

import { z } from 'zod';
import type {
  AgentToolSpec,
  ProviderStreamFn,
  AgentHarnessConfig,
} from '@zelari/core/harness';
import type { AgentMessage } from '@zelari/core/harness';
import { parentContextForRole } from '@zelari/core/context';
import type {
  BrainEvent,
  BrainAgentSpawnedEvent,
  BrainAgentStatusEvent,
  BrainAgentToolEvent,
  BrainAgentEndedEvent,
} from '@zelari/core/shared/events';
import type { ToolRegistry } from '@zelari/core/harness/tools/registry';
import {
  typedOk,
  typedErr,
  type ToolDefinition,
  type ToolPermission,
  type TypedResult,
} from '@zelari/core/harness/tools/toolTypes';
import { appendKrakenRadio } from './krakenRadio.js';
import { existsSync } from 'node:fs';
import {
  createKrakenWorktreeDetailed,
  cleanupKrakenWorktree,
  formatWorktreeFooter,
  resolveKrakenWorktreeMode,
  shouldKeepWorktree,
  mergeKrakenWorktree,
  isKrakenWorktreeAutoMergeEnabled,
  type KrakenWorktreeFailureCode,
  type WorktreeHandle,
  type WorktreeMergeResult,
} from './krakenWorktree.js';
import { krakenTentacleStart, krakenTentacleEnd } from './krakenLive.js';
// WS5 (t137): observation-only lifecycle hooks — SubagentStart/End subscribers.
import type {
  HookContext,
  LifecycleHookRunner,
  SubagentPayload,
} from '@zelari/core/harness';
import type { WorktreeScheduleMode } from '../kraken/worktreeScheduling.js';
import { randomUUID } from 'node:crypto';
import type { UsageBreakdown } from '@zelari/core/events';
import type { MemoryService } from '@zelari/core/memory';
import {
  candidateInstructions,
  isKrakenSelectionEnabled,
  krakenRequiredChecks,
  parseCandidateReport,
  registerCandidate,
  reserveCandidateSlot,
  setKrakenCheckResults,
  setLastVerifyToolTrace,
  getLastVerifyToolTrace,
} from '../kraken/candidateRegistry.js';
import { allUnknownCheckResults, parseVerifyReport, type TentacleToolTrace } from '../kraken/verifyReport.js';
import { recordCandidateTokens } from '../kraken/metrics.js';
import { parseVerifyVerdict } from '@zelari/core';
import { startTentacleHeartbeat } from './tentacleHeartbeat.js';
import {
  emitVerifyDebtCleared,
  emitVerifyDebtOpen,
  enqueueVerifyDebtPersist,
  loadSessionEventsForVerifyDebt,
  replayOpenVerifyDebts,
  type SpineEventLike,
} from './verifyDebtSpine.js';

/** Sub-agent kinds (OpenCode-inspired). */
export type TaskAgentKind = 'explore' | 'general' | 'verify';
export type TaskThoroughness = 'quick' | 'medium' | 'deep';

/** Everything a sub-agent needs to run, built fresh per invocation. */
export interface SubAgentContext {
  providerStream: ProviderStreamFn;
  model: string;
  provider: string;
  registry: ToolRegistry;
  tools: AgentToolSpec[];
  /** Effective agent kind for prompts / budgets. */
  agent?: TaskAgentKind;
  /**
   * Optional cwd override (e.g. git worktree path). When set, harness + tools
   * run with this as working directory / sandbox root.
   */
  cwd?: string;
  /**
   * Lead identity to retry with when the routed cheap model 404s
   * (`glm-5.3-flash does not exist` while the lead model works).
   */
  fallback?: {
    model: string;
    provider: string;
    providerStream: ProviderStreamFn;
  };
  /**
   * Thinking-effort spec ACTUALLY applied to this tentacle, in the canonical
   * string form (`auto` | `off` | `low` | `medium` | `high` | `xhigh` | `max`
   * | `budget:<tokens>`). Filled by the context factory after resolving
   * per-spawn arg > per-kind env > inherited provider default; surfaced on the
   * `agent_spawned` activity event. Optional so hand-rolled contexts (tests,
   * alternate hosts) need not report one.
   */
  thinking?: string;
}

/** A minimal harness surface — just the event stream. */
export interface SubAgentHarness {
  run(): AsyncIterable<BrainEvent>;
  /** Stop an in-flight run (provider stream + nested tools). */
  cancel?(): void;
}

/**
 * Wall-clock bound for the `task` tool wrapper (parent AgentHarness invoke).
 * Must cover a `general` writer on a slow reasoning model (thinking:max,
 * multi-file P0 slices). Keep aligned with DEFAULT_WRITER_NODE_TIMEOUT_MS
 * in kraken/executor.
 */
export const TASK_TOOL_TIMEOUT_MS = 2_700_000;

/**
 * Runtime permission tags for ONE `task` invocation, from the agent kind.
 * The tool schema still advertises the union (read/network/write/execute)
 * so the model can pick any kind — but spawning an explore tentacle is
 * read-only research and must not pop execute+network approval cards.
 */
export function permissionsForTaskAgent(
  agent: TaskAgentKind | undefined,
): ToolPermission[] {
  const kind = agent ?? 'explore';
  if (kind === 'general') return ['read', 'write', 'execute', 'network'];
  if (kind === 'verify') return ['read', 'execute', 'network'];
  return ['read'];
}

/** F12 (K2.4): details of a worktree-creation failure that fell back to the shared tree. */
export interface WorktreeFallbackInfo {
  /** Error excerpt that forced the fallback (never empty). */
  reason: string;
  /** Resolved ZELARI_KRAKEN_WORKTREE mode at fallback time (WS3: 'on'|'off'|'auto'). */
  mode: WorktreeScheduleMode;
  /**
   * WS3: machine-readable cause — 'not-a-git-repo', 'git-unavailable',
   * 'worktree-add-failed', 'worktree-root-unwritable' (a *declined* worktree),
   * or 'worktree-create-threw' (the pre-WS3 signal). Omitted by callers that
   * only reproduce the old shape.
   */
  code?: KrakenWorktreeFailureCode;
  /** Graph node id, when the caller (graph executor) supplied one. */
  nodeId?: string;
}

export interface TaskToolDeps {
  /** Optional sink for tentacle activity events (Frontier plan §37). */
  onTentacleEvent?: (ev: BrainEvent) => void;
  /**
   * F12 (K2.4): fired when this tentacle WANTED a worktree but creation threw,
   * so it is now running in the SHARED parent tree. Fail-open in spirit (the
   * tentacle still runs), but the graph executor uses this signal to STOP
   * rescuing overlapping writers under ZELARI_KRAKEN_WORKTREE=auto — parallel
   * admission assumed worktree isolation, which just broke.
   */
  onWorktreeFallback?: (info: WorktreeFallbackInfo) => void;
  /**
   * Build provider + tool registry for one sub-agent run.
   * `agent` selects tool set (explore RO / general write / verify tests).
   * `cwd` is the effective working directory (parent cwd or worktree).
   * `thinkingEffort` is the per-spawn thinking-effort override requested by the
   * caller (the `task` tool's `thinkingEffort` arg); 'inherit'/undefined means
   * "let the factory resolve one" (per-kind env, else the provider default).
   */
  createSubAgentContext: (opts: {
    agent: TaskAgentKind;
    thoroughness: TaskThoroughness;
    cwd: string;
    thinkingEffort?: string;
  }) => Promise<SubAgentContext | null>;
  /** Construct the harness. Overridable in tests; defaults to AgentHarness. */
  harnessFactory?: (config: AgentHarnessConfig) => SubAgentHarness;
  /**
   * When true (default), general tentacles use a git worktree unless
   * ZELARI_KRAKEN_WORKTREE=0 opts out (WS3: isolation is default ON). Tests can
   * force-disable. The env may also be `auto` (P2.C): worktrees stay on, and
   * the graph scheduler decides which nodes it rescues in parallel.
   */
  allowWorktree?: boolean;
  /** Shared native project memory used by every tentacle in this run. */
  memoryService?: MemoryService;
  /** Persist concise tentacle outcomes. Defaults true when memoryService exists. */
  memoryAutoWrite?: boolean;
  /**
   * WS5 (t137): lifecycle-hook runner used ONLY for the observation-only
   * `SubagentStart` / `SubagentEnd` / `Notification` events. Optional: absent ⇒
   * no hook fires, behavior byte-identical to before. Fire-and-forget by
   * construction — the observer methods return void — so a slow or broken
   * subscriber can never stall a tentacle.
   */
  lifecycleHooks?: LifecycleHookRunner | null;
}

/**
 * Policy limiting which sub-agent kinds a `task` tool may spawn (Fase 1,
 * ADR-0020). Plan mode registers the tool with `allowedAgents: ['explore']`
 * so PLAN can parallelize research without ever gaining write/execute
 * tentacles; BUILD keeps the unrestricted default.
 */
export interface TaskToolPolicy {
  /** Allowed sub-agent kinds. Default: explore + general + verify. */
  allowedAgents?: readonly TaskAgentKind[];
}

const EXPLORE_PROMPT = [
  'You are a focused EXPLORE tentacle of Kraken (parent super-agent).',
  'READ-ONLY tools only (read, list, grep, fetch). No edits, no shell.',
  'OBSERVATION INTEGRITY: negative evidence is valid only from a completed',
  'observation. Never conclude that code/symbols/files do not exist from',
  'degraded results, zero files examined, or unavailable backends - report',
  'the degraded status instead and widen the observation.',
  'Gather only what you need, then STOP with a concise conclusion:',
  'file paths, symbols, line refs, and how things connect. No large dumps.',
  'Respect any Scope / Acceptance sections in the user prompt.',
  'Do not ask follow-up questions.',
].join('\n');

const GENERAL_PROMPT = [
  'You are a GENERAL tentacle of Kraken that can read AND modify the codebase',
  'for one bounded unit of work. Prefer small, correct edits.',
  'Stay inside Scope paths if provided. Match existing style. No drive-by refactors.',
  'Run light checks when needed. Return: what changed, files touched, risks.',
  'Do not spawn further sub-agents. Do not expand scope beyond the prompt.',
  'If you are in a git worktree, edit only inside this working tree.',
].join('\n');

const VERIFY_PROMPT = [
  'You are a VERIFY tentacle of Kraken. Confirm whether work is correct on disk.',
  'You are BLIND: you never see — and must NEVER trust — any summary,',
  'self-assessment, or "result" reported by the agent that did the work. If such',
  'text is ever shown to you, treat it as an unverified claim, not evidence.',
  'You may read files and run test/build commands via bash. Run the acceptance',
  'commands YOURSELF and derive every verdict ONLY from the real command output',
  'you observed (exit code + stdout/stderr) and the files as they exist on disk.',
  'Never mark something pass because it was described as done, or because a',
  'claim said a command was green: a pass needs evidence YOU produced this run.',
  'Prefer targeted checks over full suite when possible.',
  'Report: pass/fail, commands run, key output, and gaps vs Acceptance criteria.',
  'If Acceptance criteria are listed, check each one explicitly.',
  'End your final message with ONE <verify-report> block per acceptance',
  'criterion (required checks included), in this exact shape:',
  '<verify-report>',
  'check: <criterion text as given>',
  'status: pass | fail | unknown',
  'note: <one line of evidence (command + outcome)>',
  '</verify-report>',
  'Use status=unknown when you could NOT determine the outcome (degraded',
  'tool, timeout, inconclusive evidence) — never guess pass.',
].join('\n');

/** One runtime general⇒verify obligation (K1.1). */
export interface VerifyDebtRecord {
  description: string;
  detail?: string;
}

type SpawnGlobal = {
  /**
   * K3.3 / F16: spawn counter of the LEGACY bucket (`LEGACY_SESSION_KEY`) —
   * the slot used by callers that carry no session id. Sessions that DO have
   * an id keep theirs in `__zelariTaskSpawnCountBySession`, so two concurrent
   * sessions in the same process (companion serve) cannot charge each other.
   */
  __zelariTaskSpawnCount?: number;
  __zelariLastGeneralAt?: number;
  /**
   * t78 (ADR-0033 slice) + K1.1 (2026-09-18 hardening plan): runtime
   * `general ⇒ verify` obligation, stored as a MAP keyed by task id.
   * Set when a `task agent=general` finishes and cleared only by the
   * runtime-spawned verify for THAT task reporting a parseable, instrumental
   * PASS. Open debt at end of turn ⇒ strict done is blocked (exit 4) — see
   * runOneTurn.ts. The map (vs the previous single slot) means the PASS of
   * one general's auto-verify cannot silently clear another general's debt.
   *
   * K3.3 / F16: this slot is the LEGACY session bucket only; every session
   * with an id lives in `__zelariGeneralVerifyDebtBySession`.
   */
  __zelariGeneralVerifyDebt?: Map<string, VerifyDebtRecord> | null;
  /** K3.3 / F16: spawn counters of every session EXCEPT the legacy bucket. */
  __zelariTaskSpawnCountBySession?: Map<string, number>;
  /**
   * K3.3 / F16: verify-debt map of every session EXCEPT the legacy bucket,
   * keyed by sessionId (TUI session, headless spine session, executor
   * `sessionId`) → the same `taskId → VerifyDebtRecord` map K1.1 introduced.
   */
  __zelariGeneralVerifyDebtBySession?: Map<string, Map<string, VerifyDebtRecord>>;
};

/** Sentinel taskId used by the legacy single-slot seam (tests). */
const SEED_TASK_ID = '__seed__';

/**
 * K3.3 / F16: bucket key for callers with NO session id (the unit-test seam
 * and pre-session turn boundaries). It IS the legacy `globalThis` slot, so an
 * id-less caller keeps exactly the process-wide behaviour it had before.
 */
const LEGACY_SESSION_KEY = 'default';

/** K3.3 / F16: did the caller hand us a real session id? */
function isSessionScoped(sessionId?: string): sessionId is string {
  return typeof sessionId === 'string' && sessionId.trim().length > 0;
}

/** K3.3 / F16: bucket key of a session id (the legacy slot when id-less). */
function sessionKey(sessionId?: string): string {
  return isSessionScoped(sessionId) ? sessionId : LEGACY_SESSION_KEY;
}

/** K3.3 / F16: spawn counters of every non-legacy session. */
function spawnCountMap(): Map<string, number> {
  const g = globalThis as unknown as SpawnGlobal;
  if (!g.__zelariTaskSpawnCountBySession) g.__zelariTaskSpawnCountBySession = new Map();
  return g.__zelariTaskSpawnCountBySession;
}

/**
 * K3.3 / F16: charge one task spawn to `sessionId` and return THAT session's
 * new count. Counting per session (same numeric cap as before) is what stops a
 * concurrent session in the same process from eating another one's budget.
 */
function bumpTaskSpawnCount(sessionId?: string): number {
  const g = globalThis as unknown as SpawnGlobal;
  const key = sessionKey(sessionId);
  if (key === LEGACY_SESSION_KEY) {
    g.__zelariTaskSpawnCount = (g.__zelariTaskSpawnCount ?? 0) + 1;
    return g.__zelariTaskSpawnCount;
  }
  const next = (spawnCountMap().get(key) ?? 0) + 1;
  spawnCountMap().set(key, next);
  return next;
}

/**
 * K3.3 / F16: verify-debt bucket of ONE session — the legacy `globalThis` slot
 * for an id-less caller, `__zelariGeneralVerifyDebtBySession` otherwise.
 */
function debtStore(sessionId?: string): Map<string, VerifyDebtRecord> {
  const g = globalThis as unknown as SpawnGlobal;
  const key = sessionKey(sessionId);
  if (key === LEGACY_SESSION_KEY) {
    if (!g.__zelariGeneralVerifyDebt) g.__zelariGeneralVerifyDebt = new Map();
    return g.__zelariGeneralVerifyDebt;
  }
  if (!g.__zelariGeneralVerifyDebtBySession) g.__zelariGeneralVerifyDebtBySession = new Map();
  let bucket = g.__zelariGeneralVerifyDebtBySession.get(key);
  if (!bucket) {
    bucket = new Map();
    g.__zelariGeneralVerifyDebtBySession.set(key, bucket);
  }
  return bucket;
}

/** K3.3 / F16: every non-legacy session bucket (aggregate gate reads). */
function sessionDebtStores(): readonly Map<string, VerifyDebtRecord>[] {
  const g = globalThis as unknown as SpawnGlobal;
  const bySession = g.__zelariGeneralVerifyDebtBySession;
  return bySession ? [...bySession.values()] : [];
}

/**
 * K3.3 / F16: the buckets a read must consult — ONE session when `sessionId`
 * is given, EVERY session (legacy bucket first) when it is omitted. The
 * id-less read is the strict-done gate's view (`runOneTurn.ts` and
 * `useChatTurn.ts` call it with no argument) and stays FAIL-CLOSED: debt open
 * in ANY session blocks the turn.
 */
function debtScopes(sessionId?: string): readonly Map<string, VerifyDebtRecord>[] {
  return isSessionScoped(sessionId) ? [debtStore(sessionId)] : [debtStore(), ...sessionDebtStores()];
}

/**
 * Reset the spawn counter (call at start of each parent user turn).
 *
 * K3.3 / F16: `sessionId` resets ONLY that session's budget and never touches
 * a concurrent session; omitting it keeps the legacy process-wide reset used
 * by the unit-test seam and the headless per-turn boundary.
 */
export function resetTaskSpawnCount(sessionId?: string): void {
  const g = globalThis as unknown as SpawnGlobal;
  if (!isSessionScoped(sessionId)) {
    g.__zelariTaskSpawnCount = 0;
    g.__zelariTaskSpawnCountBySession?.clear();
    return;
  }
  if (sessionKey(sessionId) === LEGACY_SESSION_KEY) {
    g.__zelariTaskSpawnCount = 0;
    return;
  }
  g.__zelariTaskSpawnCountBySession?.delete(sessionId);
}

/**
 * Reset the general⇒verify obligation (call at start of each parent user turn).
 *
 * K3.3 / F16: `sessionId` drops ONLY that session's debt and never a
 * concurrent session's; omitting it keeps the legacy process-wide reset used
 * by the unit-test seam and the headless per-turn boundary.
 */
export function resetTaskVerifyObligation(sessionId?: string): void {
  const g = globalThis as unknown as SpawnGlobal;
  if (!isSessionScoped(sessionId)) {
    g.__zelariGeneralVerifyDebt = new Map();
    g.__zelariGeneralVerifyDebtBySession?.clear();
    return;
  }
  if (sessionKey(sessionId) === LEGACY_SESSION_KEY) {
    g.__zelariGeneralVerifyDebt = new Map();
    return;
  }
  g.__zelariGeneralVerifyDebtBySession?.delete(sessionId);
}

/**
 * Open verify obligation, or null when every general this turn has been
 * verified PASS by the runtime auto-spawn (t78). Consulted by the headless
 * strict-done gate — an open obligation closes the turn blocked (exit 4).
 *
 * K1.1: returns the first open record (any one is enough to block). The map
 * may carry MORE records than this returns; use `listTaskVerifyObligations()`
 * or `hasOpenTaskVerifyDebt()` to see the full state.
 *
 * K3.3 / F16: scoped to ONE session when `sessionId` is given; an id-less read
 * aggregates every session (fail-closed), so no session's debt is invisible.
 */
export function taskVerifyObligation(sessionId?: string): VerifyDebtRecord | null {
  for (const store of debtScopes(sessionId)) {
    if (store.size === 0) continue;
    // Map iteration is insertion-ordered; the newest insert wins (matches the
    // pre-K1.1 "newest wins" semantics for the single open record).
    const last = store.keys().next().value as string | undefined;
    if (last) return store.get(last) ?? null;
  }
  return null;
}

/**
 * K1.1: number of open verify obligations (strict-gate invariant: > 0 ⇒
 * blocked). Useful for diagnostics and tests; the strict gate itself keeps
 * using the boolean `taskVerifyObligation() != null` check.
 * K3.3 / F16: `sessionId` scopes the listing (id-less = every session).
 */
export function listTaskVerifyObligations(sessionId?: string): readonly VerifyDebtRecord[] {
  return debtScopes(sessionId).flatMap((store) => [...store.values()]);
}

/**
 * K1.1: did any general leave a runtime verify obligation open? Strict-gate
 * friendly boolean — `true` ⇒ the strict-done gate must block the turn.
 * K3.3 / F16: `sessionId` scopes the check (id-less = every session).
 */
export function hasOpenTaskVerifyDebt(sessionId?: string): boolean {
  return debtScopes(sessionId).some((store) => store.size > 0);
}

/**
 * K1.1: register (or replace) the verify obligation for one specific task.
 * Used by `runAutoVerifyAfterGeneral` to record the debt of EACH general it
 * services — multiple tasks can be open at the same time.
 *
 * K3.3 / F16: `sessionId` writes the debt into THAT session's bucket (id-less
 * callers keep the legacy bucket), so a companion-serve session never opens
 * debt in another session's view.
 */
export function addTaskVerifyObligation(
  taskId: string,
  debt: VerifyDebtRecord,
  sessionId?: string,
): void {
  debtStore(sessionId).set(taskId, debt);
  enqueueVerifyDebtPersist(() =>
    emitVerifyDebtOpen(undefined, {
      taskId,
      description: debt.description,
      detail: debt.detail,
      timestamp: Date.now(),
    }),
  );
}

/**
 * K1.1: clear the verify obligation for ONE task. Used on a PASS of THAT
 * task's verify tentacle — clearing is per-task, so a sibling general's
 * debt stays open.
 *
 * K3.3 / F16: clear inside ONE bucket — the session that opened the debt
 * (id-less callers keep the legacy bucket); a concurrent session's debt with
 * the same taskId is never touched.
 */
export function clearTaskVerifyObligation(taskId: string, sessionId?: string): void {
  const store = debtStore(sessionId);
  if (!store.has(taskId)) return;
  store.delete(taskId);
  enqueueVerifyDebtPersist(() => emitVerifyDebtCleared(undefined, { taskId }));
}

/**
 * F3.3 (verify trust chain): memory only on PASS. `true` when no general⇒verify
 * obligation is open at call time — i.e. nothing unverified is pending: either
 * no `task agent=general` ran this turn, or its runtime auto-verify reported a
 * parseable PASS and cleared the debt. A FAIL, an unknown/absent verdict, or a
 * verify that never ran all leave the debt open, so a durable outcome must NOT
 * be remembered and nothing must be promoted. Gate the outcome-memory writes
 * and both `promoteOpsKnowledgeSafe` sites on this.
 */
export function outcomeMemoryAllowed(): boolean {
  return !hasOpenTaskVerifyDebt();
}

/**
 * Test seam: seed an open general⇒verify obligation without running a tentacle.
 * Production code must never call this — the auto-verify chain owns the slot.
 *
 * K1.1: the optional `taskId` argument disambiguates which slot to seed; when
 * omitted, the legacy sentinel key `'__seed__'` is used so the existing
 * strict-exit test (`runOneTurn.strictExit.test.ts`) keeps working unchanged.
 * K3.3 / F16: the optional `sessionId` seeds that session's bucket (omitted ⇒
 * the legacy bucket, which the id-less strict gate still sees).
 */
export function seedTaskVerifyObligation(
  debt: VerifyDebtRecord | null,
  taskId: string = SEED_TASK_ID,
  sessionId?: string,
): void {
  const store = debtStore(sessionId);
  if (debt === null) {
    store.delete(taskId);
    return;
  }
  store.set(taskId, debt);
}

/**
 * K1.5 / F5: merge un-cleared `verify.debt_open` events into the process
 * cache WITHOUT emitting (replay must not re-append). Existing slots
 * (including the test seed) are overwritten for matching taskIds and
 * otherwise left alone — callers that want a blank cache reset first.
 *
 * K3.3 / F16: hydrate the bucket of the session the log belongs to
 * (`sessionId`), never the process-wide/other-session view.
 */
export function hydrateTaskVerifyDebtFromEvents(
  events: readonly SpineEventLike[],
  sessionId?: string,
): number {
  const open = replayOpenVerifyDebts(events);
  const store = debtStore(sessionId);
  for (const [taskId, debt] of open) {
    store.set(taskId, debt);
  }
  return open.size;
}

/**
 * K1.5: hydrate the cache from `<sessionsDir>/<sessionId>/events.jsonl`.
 * K3.3 / F16: the replay lands in the bucket of the session that owns the log.
 */
export async function hydrateTaskVerifyDebtFromSpine(source: {
  sessionsDir: string;
  sessionId: string;
}): Promise<number> {
  const events = await loadSessionEventsForVerifyDebt(source);
  return hydrateTaskVerifyDebtFromEvents(events, source.sessionId);
}

/** Max concurrent/serial task spawns per parent turn, PER SESSION (env override). */
export function maxTaskSpawnsPerTurn(): number {
  const raw = process.env.ZELARI_KRAKEN_MAX_TASK_SPAWNS;
  if (raw === undefined || raw === '') return 6;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 32) : 6;
}

/** Cap on how much of the original task prompt is quoted into an auto-verify prompt (planner parity). */
const MAX_AUTO_VERIFY_TASK_PROMPT_CHARS = 1200;

/**
 * t78 (ADR-0033 slice): prompt for the verify tentacle the `task` tool
 * AUTO-spawns after a successful general. Mirrors the graph planner's
 * `buildAutoVerifyPrompt` (planner.ts): restate the task, its scope and its
 * acceptance criteria — a fresh sub-agent sees only this text — and require
 * the parseable `VERDICT:` trailer the executor's rework loop relies on.
 *
 * F3.2 (blind verify): this builder is fed the ORIGINAL contract ONLY. It is
 * deliberately blind — it is never handed the general's summary, its
 * self-assessment, its claimed command output, or the `[sub-agent:general …]`
 * result marker. The verifier derives its verdict from the tree on disk and the
 * commands it runs itself, never from the implementer's account.
 */
export function buildTaskAutoVerifyPrompt(args: {
  description: string;
  prompt: string;
  scope?: string[];
  acceptance?: string[];
}): string {
  const taskPrompt =
    args.prompt.length > MAX_AUTO_VERIFY_TASK_PROMPT_CHARS
      ? `${args.prompt.slice(0, MAX_AUTO_VERIFY_TASK_PROMPT_CHARS)}\n… [truncated]`
      : args.prompt;
  const parts: string[] = [
    `Verify on disk that this work was actually completed correctly: ${args.description}.`,
    '',
    '## The task that was carried out',
    taskPrompt,
  ];
  if (args.scope && args.scope.length > 0) {
    parts.push('', '## Paths the work was scoped to', ...args.scope.map((s) => `- ${s}`));
  }
  if (args.acceptance && args.acceptance.length > 0) {
    parts.push('', '## Acceptance criteria to check explicitly', ...args.acceptance.map((a) => `- ${a}`));
  }
  parts.push(
    '',
    'This brief is BLIND by design: it gives you the goal, the scope and the acceptance ' +
      'criteria ONLY — never the implementer\'s summary, self-assessment or claimed command ' +
      'output. Read the files on disk and run the acceptance commands yourself; a PASS must ' +
      'come from output YOU produced. Report the commands you ran and every gap you found.',
    '',
    '## How to report your verdict',
    'End your final message with a line of exactly this form, as the LAST line:',
    '',
    'VERDICT: PASS',
    '',
    'or',
    '',
    'VERDICT: FAIL',
    '',
    'This line is parsed. Only report FAIL for a real defect against the task or its ' +
      'acceptance criteria: a rework round is expensive and there is only a small number of them.',
  );
  return parts.join('\n');
}

/**
 * Prompt for the single rework round the `task` tool may spend when its
 * auto-spawned verify reports FAIL — same shape as the graph executor's
 * `spawnReworkPair` rework node (original task + reviewer findings).
 */
export function buildTaskReworkPrompt(
  original: { prompt: string },
  findings: string,
): string {
  return (
    `A reviewer inspected this work on disk and REJECTED it. Address every finding below, ` +
    `then leave the work in a state that satisfies the original task.\n\n` +
    `## Original task\n${original.prompt}\n\n` +
    `## Reviewer findings (these are what must change)\n` +
    `${findings || '(the reviewer reported FAIL without detail)'}`
  );
}

/**
 * F3.3 (verify trust chain): remember a general's outcome ONLY once the runtime
 * verify reported a parseable PASS. Written here rather than in `runTentacle`
 * precisely because the writer runs first and its verdict is knowable only now:
 * an unverified (FAIL / unknown / verify-never-ran) outcome is never stored.
 * Best-effort — a memory failure never fails the chain.
 */
async function rememberVerifiedGeneralOutcome(opts: {
  deps: TaskToolDeps;
  original: { description: string; scope?: string[]; acceptance?: string[] };
  general: TentacleSuccess;
  sessionId: string;
}): Promise<void> {
  const memoryService = opts.deps.memoryService;
  if (!memoryService || opts.deps.memoryAutoWrite === false) return;
  const content = (opts.general.result ?? '').trim();
  if (!content) return;
  try {
    await memoryService.remember({
      kind: 'outcome',
      content: content.slice(0, 12_000),
      importance: 0.75,
      confidence: 0.98,
      tags: ['kraken', 'tentacle:general'],
      source: {
        agent: 'kraken-general',
        sessionId: opts.sessionId,
        ...(opts.general.agentId ? { tentacleId: opts.general.agentId } : {}),
        ...(opts.general.worktreePath ? { worktree: opts.general.worktreePath } : {}),
      },
      metadata: {
        writeClass: 'auto',
        description: opts.original.description,
        scope: opts.original.scope ?? [],
        acceptance: opts.original.acceptance ?? [],
        verified: true,
      },
      writeClass: 'auto',
    });
  } catch {
    // Shared memory is fail-open: a persistence issue never fails the chain.
  }
}

/**
 * t78 (ADR-0033 slice): runtime `general ⇒ verify` obligation on the `task`
 * tool path — the graph engine already auto-injects a verify node after every
 * general (planner) and reworks once on FAIL (executor, DEFAULT_MAX_REVIEW_ROUNDS);
 * the `task` tool used to append a soft hint footer and stop.
 *
 * Behavior (parent-side sequential spawn — sub-agents still cannot nest `task`):
 *   1. auto-spawn one verify with the SAME acceptance[] (and the general's
 *      worktree when it is still present — kept worktrees; merged-and-cleaned
 *      ones left the work in the parent tree, which is what must be checked);
 *   2. on parseable `VERDICT: FAIL`: at most `resolveMaxReviewRounds()` rework
 *      round(s) in that same tree (executor pattern: `allowWorktree: false` so
 *      no second worktree opens on the same scope), then verify again;
 *   3. PASS clears the obligation; FAIL after the budget, an unknown verdict
 *      (no parseable trailer — non-blocking here, exactly like the executor)
 *      or a failed spawn leaves it open, and the headless strict-done gate
 *      then closes the turn blocked (exit 4). `ZELARI_STRICT_DONE=0` remains
 *      the only opt-out.
 *
 * Returns the honest parent-facing `[kraken:auto-verify]` block appended to
 * the task result (or null when nothing ran — e.g. explore/verify agents).
 */
export async function runAutoVerifyAfterGeneral(opts: {
  deps: TaskToolDeps;
  original: { description: string; prompt: string; scope?: string[]; acceptance?: string[] };
  /** The successful general result (for its worktree path, when kept). */
  general: TentacleSuccess;
  parentCwd: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<string> {
  // Debt exists from the moment the general finished — even a mid-chain
  // failure must not leave the work silently "verified".
  //
  // K1.1: key the slot by this general's `agentId` (always populated by
  // TentacleSuccess) so a sibling general's PASS cannot clear our debt.
  const debtKey = opts.general.agentId ?? opts.original.description;
  // K3.3 / F16: the debt is opened in THIS session's bucket (opts.sessionId).
  addTaskVerifyObligation(debtKey, { description: opts.original.description }, opts.sessionId);

  // t94: live phase captions on the general's activity row (agent_status)
  // mirrored into the radio 'progress' trail — the parent sees the general
  // flip to "verifying…" and then to the verdict without polling.
  // `terminal` lets a caption carry the row's terminal status in the SAME
  // agent_status event: without it the general's row stays ● running forever
  // (the 'verifying…' caption flips it back to running after agent_ended, and
  // the final PASS/FAIL caption used to leave it there). The radio mirror
  // below is unchanged (no new kinds/fields).
  const emitVerifyPhase = (detail: string, ok?: boolean, terminal?: 'completed' | 'failed') => {
    const agentId = opts.general.agentId;
    if (agentId) {
      opts.deps.onTentacleEvent?.({
        type: 'agent_status',
        agentId,
        status: terminal ?? 'running',
        message: detail,
        id: randomUUID(),
        sessionId: opts.sessionId,
        ts: Date.now(),
      } as BrainEvent);
    }
    appendKrakenRadio(opts.parentCwd, opts.sessionId, {
      kind: 'progress',
      agent: 'verify',
      description: `verify: ${opts.original.description}`,
      detail,
      ...(ok === undefined ? {} : { ok }),
    });
  };

  // Same worktree when one was used AND still exists (kept); after an
  // auto-merge the worktree is gone and the work lives in the parent tree.
  const inheritedCwd =
    opts.general.worktreePath && existsSync(opts.general.worktreePath)
      ? opts.general.worktreePath
      : undefined;

  const runVerify = (label: string): Promise<TentacleResult> =>
    runTentacle({
      deps: opts.deps,
      args: {
        description: label,
        prompt: buildTaskAutoVerifyPrompt(opts.original),
        scope: opts.original.scope,
        acceptance: opts.original.acceptance,
      },
      agent: 'verify',
      thoroughness: 'medium',
      parentCwd: opts.parentCwd,
      ...(inheritedCwd ? { cwdOverride: inheritedCwd } : {}),
      sessionId: opts.sessionId,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

  // K1.3 (rev): every inner-verify return MUST publish its tool trace to
  // the per-turn channel `__zelariVerifyToolTrace` BEFORE we read it back
  // at the floor check, because the inner verify is a direct `runTentacle`
  // call that does NOT go through `createTaskTool.execute` (which is the
  // only other publisher of that channel). Without this publish, (1) an
  // honest PASS with tool captures still fails the floor (positive path
  // broken), and (2) a stale trace from an earlier OUTER verify could be
  // seen here (stale-trace leakage). The helper centralizes the rule.
  const publishInnerVerifyTrace = (result: TentacleResult): void => {
    setLastVerifyToolTrace(result.ok ? result.toolTrace ?? [] : []);
  };

  emitVerifyPhase('verifying…');
  let verify = await runVerify(`verify: ${opts.original.description}`);
  publishInnerVerifyTrace(verify);
  // Parsed like the graph executor: last VERDICT trailer wins; a failed run is
  // an unknown (degraded observation is never proof).
  let verdict = verify.ok ? parseVerifyVerdict(verify.result).verdict : 'unknown';
  let findings = verify.ok ? parseVerifyVerdict(verify.result).findings : '';

  if (verdict === 'fail') {
    // Same rework budget as the graph executor (default 1), resolved lazily to
    // avoid a module-load cycle tools → kraken/executor → tentacle → tools.
    const { resolveMaxReviewRounds } = await import('../kraken/executor.js');
    const maxRounds = resolveMaxReviewRounds();
    let round = 0;
    while (verdict === 'fail' && round < maxRounds) {
      round += 1;
      const rework = await runTentacle({
        // A rework edits the EXISTING tree — it must not open a second
        // worktree on the same scope (executor spawnReworkPair contract).
        deps: { ...opts.deps, allowWorktree: false },
        args: {
          description: `rework: ${opts.original.description}`,
          prompt: buildTaskReworkPrompt(opts.original, findings),
          scope: opts.original.scope,
          acceptance: opts.original.acceptance,
        },
        agent: 'general',
        thoroughness: 'medium',
        parentCwd: opts.parentCwd,
        ...(inheritedCwd ? { cwdOverride: inheritedCwd } : {}),
        sessionId: opts.sessionId,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!rework.ok) {
        const detail = `rework round ${round} failed: ${rework.error}`;
        addTaskVerifyObligation(
          debtKey,
          {
            description: opts.original.description,
            detail,
          },
          opts.sessionId,
        );
        appendKrakenRadio(opts.parentCwd, opts.sessionId, {
          kind: 'error',
          agent: 'general',
          description: `rework: ${opts.original.description}`,
          detail,
          ok: false,
        });
        emitVerifyPhase(`rework round ${round} failed`, false, 'failed');
        return (
          `\n\n[kraken:auto-verify] verify FAIL — rework round ${round} failed to run ` +
          `(${rework.error}). Work stays UNVERIFIED; strict done will close this turn blocked.`
        );
      }
      verify = await runVerify(`verify: ${opts.original.description} (rework ${round})`);
      publishInnerVerifyTrace(verify);
      verdict = verify.ok ? parseVerifyVerdict(verify.result).verdict : 'unknown';
      findings = verify.ok ? parseVerifyVerdict(verify.result).findings : '';
    }
  }

  if (verdict === 'pass') {
    // K1.3: the verify trailer may say PASS but the verify must also have
    // executed ≥ 1 tool (real bash / read / etc.) before the debt is cleared.
    // A bare-text PASS — "I read the diff and it's fine" with no tool
    // captures — is narrative-only and cannot clear the obligation.
    const trace = getLastVerifyToolTrace();
    const instrumental = Array.isArray(trace) && trace.length > 0;
    if (!instrumental) {
      const detail =
        'verify produced VERDICT: PASS but executed no tool — narrative-only PASS does not satisfy the auto-verify floor';
      addTaskVerifyObligation(
        debtKey,
        {
          description: opts.original.description,
          detail,
        },
        opts.sessionId,
      );
      emitVerifyPhase('verify PASS without tool evidence', false, 'failed');
      appendKrakenRadio(opts.parentCwd, opts.sessionId, {
        kind: 'error',
        agent: 'verify',
        description: `verify: ${opts.original.description}`,
        detail,
        ok: false,
      });
      return (
        `\n\n[kraken:auto-verify] ${detail}. Work stays UNVERIFIED; ` +
        `strict done will close this turn blocked.`
      );
    }
    clearTaskVerifyObligation(debtKey, opts.sessionId);
    await rememberVerifiedGeneralOutcome(opts);
    emitVerifyPhase('verify PASS', true, 'completed');
    return `\n\n[kraken:auto-verify] verify PASS — general⇒verify obligation satisfied.`;
  }

  // t94: unresolved chain — caption the failure mode before the honest return.
  emitVerifyPhase(
    verdict === 'fail' ? 'verify FAIL' : verify.ok ? 'verify unknown' : 'verify failed',
    verdict === 'fail' || !verify.ok ? false : undefined,
    'failed',
  );
  const detail =
    verdict === 'fail'
      ? `verify FAIL unresolved (rework budget spent): ${findings || 'no findings reported'}`
      : verify.ok
        ? 'verify produced no parseable VERDICT — unverified'
        : `verify tentacle failed: ${verify.error}`;
  addTaskVerifyObligation(
    debtKey,
    {
      description: opts.original.description,
      detail,
    },
    opts.sessionId,
  );
  appendKrakenRadio(opts.parentCwd, opts.sessionId, {
    kind: 'error',
    agent: 'verify',
    description: `verify: ${opts.original.description}`,
    detail,
    ok: false,
  });
  return (
    `\n\n[kraken:auto-verify] ${detail}. Work stays UNVERIFIED; ` +
    `strict done will close this turn blocked.`
  );
}

/** Build user message with optional contract fields (Fractal-style NODE contract). */
export function buildTaskUserPrompt(args: {
  prompt: string;
  scope?: string[];
  acceptance?: string[];
}): string {
  const parts: string[] = [args.prompt.trim()];
  if (args.scope && args.scope.length > 0) {
    parts.push(
      '',
      '## Scope (path allowlist — do not edit outside)',
      ...args.scope.map((s) => `- ${s}`),
    );
  }
  if (args.acceptance && args.acceptance.length > 0) {
    parts.push('', '## Acceptance criteria', ...args.acceptance.map((a) => `- ${a}`));
  }
  return parts.join('\n');
}

/**
 * Fase 6 (ADR-0020): BUILD dynamic checks. When kraken_select selected a
 * candidate this turn, its requiredChecks become proof obligations of
 * every verify tentacle — appended to the parent's acceptance (deduped,
 * case-insensitive) or the whole acceptance when the parent provided
 * none. Explore/general are never touched; verify is PLAN-rejected
 * (Fase 1), so this path is BUILD-only by construction. No flag gate
 * needed: a verdict can only exist when the selection tool ran.
 */
export function withKrakenRequiredChecks(
  agent: TaskAgentKind,
  acceptance?: string[],
): string[] | undefined {
  if (agent !== 'verify') return acceptance;
  const required = krakenRequiredChecks();
  if (required.length === 0) return acceptance;
  const seen = new Set((acceptance ?? []).map((a) => a.trim().toLowerCase()));
  const merged = [...(acceptance ?? [])];
  for (const check of required) {
    const key = check.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(check);
    }
  }
  return merged;
}

export function systemPromptForAgent(agent: TaskAgentKind): string {
  if (agent === 'general') return GENERAL_PROMPT;
  if (agent === 'verify') return VERIFY_PROMPT;
  return EXPLORE_PROMPT;
}

export function maxToolCallsForThoroughness(
  thoroughness: TaskThoroughness,
  agent: TaskAgentKind,
): number {
  if (agent === 'general') {
    if (thoroughness === 'quick') return 8;
    if (thoroughness === 'deep') return 20;
    return 12;
  }
  if (agent === 'verify') {
    if (thoroughness === 'quick') return 6;
    if (thoroughness === 'deep') return 14;
    return 10;
  }
  // explore
  if (thoroughness === 'quick') return 4;
  if (thoroughness === 'deep') return 12;
  return 6;
}

/** @deprecated use systemPromptForAgent('explore') — kept for tests */
export const SUBAGENT_SYSTEM_PROMPT = EXPLORE_PROMPT;

const TaskArgsSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('A 3-6 word label for the sub-task (for logs/UI).'),
  prompt: z
    .string()
    .min(1)
    .describe(
      'The full, self-contained instruction for the sub-agent. It has no access ' +
        'to this conversation, so include all context it needs. Prefer Goal/Scope/Acceptance.',
    ),
  agent: z
    .enum(['explore', 'general', 'verify'])
    .optional()
    .describe(
      'Sub-agent type: explore (read-only research, default), general (can edit), ' +
        'verify (read + bash tests). Prefer explore for search; general for isolated edits.',
    ),
  thoroughness: z
    .enum(['quick', 'medium', 'deep'])
    .optional()
    .describe('How deep the sub-agent should go (tool budget). Default medium.'),
  scope: z
    .array(z.string().min(1))
    .max(32)
    .optional()
    .describe(
      'Optional path/glob allowlist for this tentacle (contract). Appended to the prompt as Scope.',
    ),
  acceptance: z
    .array(z.string().min(1))
    .max(16)
    .optional()
    .describe(
      'Optional acceptance checklist (contract). Appended to the prompt as Acceptance criteria.',
    ),
  thinkingEffort: z
    .enum(['inherit', 'auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe(
      'Thinking effort for THIS tentacle only (ADR-0017), overriding the provider ' +
        "default used by the lead. 'inherit' (and omitting the field) defers to the " +
        'per-kind default: ZELARI_KRAKEN_<EXPLORE|GENERAL|VERIFY>_THINKING, else the ' +
        'provider thinkingByProvider value. Token budgets are not accepted here — set ' +
        "ZELARI_KRAKEN_<KIND>_THINKING='budget:<n>' instead. Invalid values are ignored.",
    ),
});

const TaskPurposeSchema = z
  .enum(['candidate'])
  .optional()
  .describe(
    'Mark this explore tentacle as one CANDIDATE hypothesis (alpha: requires ' +
      'ZELARI_KRAKEN_SELECTION=1). Forces agent=explore, structured report.',
  );

const TaskArgsWithPurposeSchema = TaskArgsSchema.extend({
  purpose: TaskPurposeSchema,
});

type TaskArgs = z.infer<typeof TaskArgsSchema>;

/**
 * Run a sub-agent to completion and return the text of its final assistant
 * message (the "conclusion"). Intermediate tool-call turns are discarded.
 *
 * When `signal` aborts, the `for await` loop breaks, which calls `.return()`
 * on the `AgentHarness.run()` async generator and unwinds it — the sub-agent
 * stops before starting its next tool call, so it cannot keep writing files
 * after the caller has given up on it. Reports `aborted: true` so callers can
 * tell "the run stopped on request" from "the run finished on its own"; that
 * distinction matters to the graph executor, which must not re-spawn a node
 * onto a scope another tentacle may still be writing to.
 */
/** Bounded tentacle tool trace (2.1 T5): ring size + output excerpt cap. */
const TOOL_TRACE_RING = 24;
const TOOL_TRACE_OUTPUT_MAX = 600;

/** Best-effort command/path hint from tool args, for note→tool matching. */
function toolCommandHint(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['command', 'cmd', 'script', 'pattern', 'path', 'query', 'url']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 160);
  }
  return undefined;
}

export async function runSubAgent(
  harness: SubAgentHarness,
  opts: { signal?: AbortSignal; onEvent?: (ev: BrainEvent) => void } = {},
): Promise<{ result: string; error?: string; aborted?: boolean; usage?: UsageBreakdown; toolTrace?: TentacleToolTrace[] }> {
  const { signal } = opts;
  let current = '';
  let lastCompleted = '';
  let error: string | undefined;
  let usage: UsageBreakdown | undefined;
  /** toolCallId → { tool, command } captured at tool_execution_start. */
  const pendingTools = new Map<string, { tool: string; command?: string }>();
  const toolTrace: TentacleToolTrace[] = [];
  const onAbort = () => harness.cancel?.();
  if (signal?.aborted) {
    onAbort();
    return { result: '', aborted: true };
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
  for await (const ev of harness.run()) {
    if (signal?.aborted) {
      onAbort();
      return {
        result: (lastCompleted || current).trim(),
        ...(error ? { error } : {}),
        aborted: true,
        ...(toolTrace.length > 0 ? { toolTrace } : {}),
      };
    }
    if (opts.onEvent && (ev.type === 'agent_start' || ev.type === 'agent_end' || ev.type === 'tool_execution_start' || ev.type === 'tool_execution_update' || ev.type === 'tool_execution_end')) {
      opts.onEvent(ev);
    }
    // 2.1 T5 (original-tool-backed evidence): capture the tentacle's raw tool
    // executions mechanically, at execution time — the verify-report note is
    // the agent's claim; this is what the process actually observed.
    if (ev.type === 'tool_execution_start') {
      pendingTools.set(ev.toolCallId, { tool: ev.toolName, command: toolCommandHint(ev.args) });
    } else if (ev.type === 'tool_execution_end') {
      const started = pendingTools.get(ev.toolCallId);
      pendingTools.delete(ev.toolCallId);
      toolTrace.push({
        tool: started?.tool ?? 'unknown',
        callId: ev.toolCallId,
        ok: !ev.isError,
        ...(started?.command ? { command: started.command } : {}),
        output: String(ev.result ?? '').slice(0, TOOL_TRACE_OUTPUT_MAX),
        durationMs: ev.durationMs,
        endedAt: Date.now(),
      });
      if (toolTrace.length > TOOL_TRACE_RING) {
        toolTrace.splice(0, toolTrace.length - TOOL_TRACE_RING);
      }
    }
    switch (ev.type) {
      case 'message_start':
        current = '';
        break;
      case 'message_delta':
        current += ev.delta;
        break;
      case 'message_end':
        if (current.trim()) lastCompleted = current;
        // Fase 10: capture provider-reported usage (summed across the
        // sub-agent's tool-loop turns) so candidate token costs are real,
        // never approximated.
        if (ev.usage) {
          usage = usage
            ? {
                promptTokens: usage.promptTokens + ev.usage.promptTokens,
                completionTokens: usage.completionTokens + ev.usage.completionTokens,
                totalTokens: usage.totalTokens + ev.usage.totalTokens,
                ...((usage.cachedPromptTokens ?? 0) + (ev.usage.cachedPromptTokens ?? 0) > 0
                  ? {
                      cachedPromptTokens:
                        (usage.cachedPromptTokens ?? 0) + (ev.usage.cachedPromptTokens ?? 0),
                    }
                  : {}),
              }
            : ev.usage;
        }
        current = '';
        break;
      case 'error':
        error = ev.message;
        break;
      default:
        break;
    }
  }
  const result = (lastCompleted || current).trim();
  return {
    result,
    ...(error ? { error } : {}),
    ...(usage ? { usage } : {}),
    ...(toolTrace.length > 0 ? { toolTrace } : {}),
  };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Successful tentacle run (raw conclusion + footer, no `[sub-agent:…]` prefix). */
export interface TentacleSuccess {
  ok: true;
  agent: TaskAgentKind;
  thoroughness: TaskThoroughness;
  /** Live activity row id — same id the agent_* BrainEvents carry (t94). */
  agentId?: string;
  /** Model actually used by the sub-agent. */
  model: string;
  /** Raw sub-agent conclusion (no prefix, no footer). */
  result: string;
  /** Worktree footer (leading newline included), or ''. */
  footer: string;
  /**
   * Provider-reported token usage summed across the sub-agent's turns
   * (Fase 10 metrics). Absent when the provider reports none — never
   * approximated.
   */
  usage?: UsageBreakdown;
  /**
   * 2.1 T5: raw tool executions captured during the run (bounded ring,
   * output excerpts). The verify-report path stores them with the check
   * results so the strict gate can anchor evidence to real tool output.
   */
  toolTrace?: TentacleToolTrace[];
  /** Git worktree path if one was used, else null. */
  worktreePath: string | null;
  /**
   * Full worktree handle when one was created (regardless of deferMerge),
   * else null. The graph executor (F3) uses this to merge/cleanup explicitly
   * when `deferMerge` was requested.
   */
  worktreeHandle: WorktreeHandle | null;
  /** Cognitive-memory node created from this concise conclusion, if enabled. */
  memoryId?: string;
}

/** Failed tentacle run. `error` is the exact message previously given to typedErr. */
export interface TentacleFailure {
  ok: false;
  agent: TaskAgentKind;
  error: string;
  /**
   * True when the run stopped because its `signal` aborted, i.e. the sub-agent
   * is confirmed to have unwound rather than still running somewhere. The
   * graph executor uses this to decide whether re-running the node onto the
   * same scope is safe.
   */
  cancelled?: boolean;
}

export type TentacleResult = TentacleSuccess | TentacleFailure;

/** Inputs for a single tentacle run (shared by the `task` tool and the graph executor). */
export interface RunTentacleOptions {
  deps: TaskToolDeps;
  args: {
    description: string;
    prompt: string;
    scope?: string[];
    acceptance?: string[];
    /**
     * Per-spawn thinking-effort override (ADR-0017). 'inherit'/undefined defers
     * to the per-kind env, else the provider default — see `TaskArgsSchema`.
     */
    thinkingEffort?: string;
  };
  agent: TaskAgentKind;
  thoroughness: TaskThoroughness;
  /** Parent working directory (worktrees are created relative to this). */
  parentCwd: string;
  /**
   * Run the sub-agent in this directory instead of `parentCwd`, without making
   * it the worktree/radio root. The graph executor uses it to run a `verify`
   * tentacle inside the worktree its writer produced: verification happens
   * before the merge node, so checking `parentCwd` meant checking a tree that
   * did not yet contain the work being verified. Ignored when this tentacle
   * creates a worktree of its own (writers).
   */
  cwdOverride?: string;
  /** Lead messages for §51 parent-summary projection (optional, inert by default). */
  parentTranscript?: AgentMessage[];
  /** Session id used for radio JSONL correlation. */
  sessionId: string;
  /**
   * When true and a worktree was created for this tentacle, skip the
   * auto-merge/cleanup step entirely and return the worktree handle so the
   * caller (graph executor) can merge multiple tentacles' branches
   * sequentially instead of racing concurrent merges into the same parent
   * HEAD. Ignored when no worktree is used. Default false (current `task`
   * tool behavior: merge immediately).
   */
  deferMerge?: boolean;
  /** Graph engine (F5): tag the live tentacle entry with its graph/node id. */
  graphId?: string;
  nodeId?: string;
  /**
   * Cancels the sub-agent run. The graph executor aborts this when a node
   * exceeds its wall-clock budget, so the tentacle stops instead of running on
   * (and writing) while the executor retries the same scope.
   */
  signal?: AbortSignal;
  /**
   * Override the system prompt. Used by Pillar 2 persona kinds
   * (`spec`, `conformance`) to inject the persona's specific prompt
   * even when the host agent is `verify`. When unset, falls back to
   * `systemPromptForAgent(agent)`.
   */
  systemPromptOverride?: string;
}

/** Compact path for live phase captions (mirrors the panel's shortWorktree). */
function shortWorktreeCaption(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  const short = parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p;
  return short.length > 50 ? `...${short.slice(-47)}` : short;
}

/**
 * WS5 (t137): inputs of an observation-only `SubagentStart` / `SubagentEnd`
 * hook payload. Structural on purpose (`agent` is a plain string) so the
 * builder stays pure and unit-testable without a provider, a harness or a repo.
 */
export interface SubagentHookInput {
  /** Sub-agent kind (`general` / `explore` / `verify` / persona kinds). */
  agent: string;
  /** The tentacle's one-line description. */
  description: string;
  thoroughness?: string;
  /** Resolved `ZELARI_KRAKEN_WORKTREE` mode (`on` / `off` / `auto`). */
  worktreeMode?: string;
  /** Worktree path when isolation is active (`null`/absent ⇒ shared tree). */
  worktreePath?: string | null;
  nodeId?: string;
  graphId?: string;
  cwd?: string;
  /** `SubagentEnd` only: absent is NEVER a success claim. */
  ok?: boolean;
  durationMs?: number;
  error?: string;
}

/**
 * Pure: one tentacle run → the structured hook payload. `worktree` is derived
 * from the REAL path (WS3 isolation actually in effect), never from the mode
 * alone — `auto`/`on` with a failed creation runs in the shared tree.
 */
export function buildSubagentHookPayload(input: SubagentHookInput): SubagentPayload {
  const worktreePath = input.worktreePath ?? '';
  return {
    agent: input.agent,
    description: input.description,
    worktree: worktreePath.length > 0,
    ...(input.thoroughness ? { thoroughness: input.thoroughness } : {}),
    ...(input.worktreeMode ? { worktreeMode: input.worktreeMode } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.graphId ? { graphId: input.graphId } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(typeof input.ok === 'boolean' ? { ok: input.ok } : {}),
    ...(typeof input.durationMs === 'number' ? { durationMs: input.durationMs } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

/**
 * Fire one observer subagent hook. Fire-and-forget: the returned promise is
 * NOT awaited (the runner's observer methods never reject, and a `.catch` keeps
 * even a misbehaving runner from producing an unhandled rejection), so no
 * subscriber can delay a tentacle or its teardown.
 */
export function fireSubagentHook(
  hooks: LifecycleHookRunner | null | undefined,
  event: 'SubagentStart' | 'SubagentEnd',
  payload: SubagentPayload,
  ctx: HookContext = {},
): void {
  if (!hooks) return;
  const run =
    event === 'SubagentStart' ? hooks.runSubagentStart(payload, ctx) : hooks.runSubagentEnd(payload, ctx);
  void run.catch(() => {
    /* an observer never propagates into the tentacle */
  });
}

/**
 * WS5 (t137): the tentacle END seam — `SubagentEnd` plus the matching
 * `Notification` (a finished/failed tentacle is a WS2 `tentacle-finished`
 * inbox item; `kind` names the real producer, `task.tentacle_ended`, and never
 * claims a graph envelope it did not write). Best-effort and fire-and-forget.
 */
export function fireTentacleEndHooks(
  hooks: LifecycleHookRunner | null | undefined,
  input: SubagentHookInput,
  ctx: HookContext = {},
): void {
  if (!hooks) return;
  const payload = buildSubagentHookPayload(input);
  fireSubagentHook(hooks, 'SubagentEnd', payload, ctx);
  const what = input.ok === false ? 'tentacle FAILED' : 'tentacle finished';
  void hooks
    .runNotification(
      {
        source: 'tentacle-finished',
        kind: 'task.tentacle_ended',
        summary: `${what}: ${input.agent} — ${input.description}`,
        ...(input.nodeId ? { taskId: input.nodeId } : {}),
      },
      ctx,
    )
    .catch(() => {
      /* an observer never propagates into the tentacle */
    });
}

/**
 * Run one Kraken tentacle end-to-end: optional worktree isolation, radio +
 * live tracking, sub-agent harness run, worktree squash-merge, and footer
 * assembly. Returns a discriminated result instead of a TypedResult so callers
 * (the `task` tool wrapper, the graph executor) can react programmatically.
 *
 * Deliberately has NO spawn-cap: the per-turn cap is a `task`-tool policy
 * applied by the wrapper; the graph executor budgets concurrency itself.
 */
export async function runTentacle(opts: RunTentacleOptions): Promise<TentacleResult> {
  const { deps, args, agent, thoroughness, parentCwd, sessionId } = opts;
  const started = Date.now();
  const g = globalThis as unknown as SpawnGlobal;

  // Worktree isolation for general writers (K7). WS3 (2.39) flipped the
  // DEFAULT: unless the user opts out with ZELARI_KRAKEN_WORKTREE=0
  // (false/no/off), a writer runs in its own worktree. `auto` (P2.C) keeps its
  // extra meaning — the graph scheduler may pull overlapping writers forward —
  // so the flip isolates writers WITHOUT widening parallelism: a non-`auto`
  // mode still defers overlapping writers exactly as before.
  let worktree: WorktreeHandle | null = null;
  let effectiveCwd = opts.cwdOverride || parentCwd;
  const worktreeMode = resolveKrakenWorktreeMode(process.env);
  const wantWt = agent === 'general' && deps.allowWorktree !== false && worktreeMode !== 'off';
  /**
   * WS3: teardown reports what it actually did. A still-locked directory or a
   * refused sweep is announced on the radio instead of vanishing into a catch.
   */
  const teardownWorktree = async (handle: WorktreeHandle): Promise<void> => {
    const outcome = await cleanupKrakenWorktree(handle);
    if (outcome.degraded) {
      appendKrakenRadio(parentCwd, sessionId, {
        kind: 'progress',
        agent,
        thoroughness,
        description: args.description,
        detail: `worktree cleanup degraded: ${outcome.degraded}`,
      });
    }
  };
  if (wantWt) {
    let failure: { code: KrakenWorktreeFailureCode; reason: string } | null = null;
    try {
      const created = await createKrakenWorktreeDetailed(parentCwd, args.description);
      if (created.ok) {
        worktree = created.handle;
        effectiveCwd = created.handle.path;
      } else {
        failure = { code: created.code, reason: created.reason };
      }
    } catch (err) {
      failure = {
        code: 'worktree-create-threw',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (failure) {
      // F12 (K2.4) + WS3: no worktree → fail OPEN (the tentacle still runs in
      // the SHARED parent tree) but make the degradation LOUD. Under
      // ZELARI_KRAKEN_WORKTREE=auto the graph scheduler admits overlapping
      // writers in parallel ONLY because it assumes worktree isolation, and
      // since WS3 every writer is expected to be isolated by default — so a
      // silent decline would run unisolated concurrent writes with no trace.
      // The radio event plus the deps callback let the executor stop rescuing
      // overlapping writers (serial admission) for the rest of the run.
      const reason =
        failure.code === 'worktree-create-threw'
          ? failure.reason
          : `${failure.code}: ${failure.reason}`;
      worktree = null;
      appendKrakenRadio(parentCwd, sessionId, {
        kind: 'worktree.fallback_shared_tree',
        agent,
        thoroughness,
        description: args.description,
        detail: `worktree creation failed — running in the shared parent tree: ${reason}`,
        mode: worktreeMode,
        reason,
        ...(opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
        ok: false,
      });
      deps.onWorktreeFallback?.({
        code: failure.code,
        reason,
        mode: worktreeMode,
        ...(opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
      });
    }
  }

  // WS5 (t137): the observation-only hook correlation for THIS tentacle, built
  // once AFTER worktree resolution (so `worktree` reflects the isolation really
  // in effect, not the requested mode) and shared by SubagentStart/SubagentEnd.
  const hookCtx: HookContext = { sessionId, cwd: effectiveCwd };
  const subagentHookBase: SubagentHookInput = {
    agent,
    description: args.description,
    thoroughness,
    worktreeMode,
    worktreePath: worktree?.path ?? null,
    ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
    ...(opts.graphId ? { graphId: opts.graphId } : {}),
    cwd: effectiveCwd,
  };
  appendKrakenRadio(parentCwd, sessionId, {
    kind: 'spawn',
    agent,
    thoroughness,
    description: args.description,
    worktree: worktree?.path ?? null,
  });
  // G1 (K10): track the tentacle in-process so StatusBar / Desktop can show
  // "tentacles 1↑ 2✓" live during the parent turn.
  const liveId = krakenTentacleStart({
    agent,
    description: args.description,
    worktree: worktree?.path ?? null,
    ...(opts.graphId ? { graphId: opts.graphId } : {}),
    ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
  });

  const emitActivity = (ev: Omit<BrainEvent, 'id' | 'sessionId'> & { type: BrainEvent['type'] }) => {
    deps.onTentacleEvent?.({ ...ev, id: randomUUID(), sessionId } as BrainEvent);
  };
  const endTentacle = (id: string, info: Parameters<typeof krakenTentacleEnd>[1]) => {
    krakenTentacleEnd(id, info);
    // WS5 (t137): every terminal path of a tentacle funnels through here, so
    // this is the single `SubagentEnd` (+ `tentacle-finished` Notification)
    // seam. Fire-and-forget: an observer can never delay the teardown.
    fireTentacleEndHooks(
      deps.lifecycleHooks,
      {
        ...subagentHookBase,
        ok: info.ok,
        durationMs: info.durationMs ?? Date.now() - started,
        ...(info.ok === false ? { error: info.detail ?? 'failed' } : {}),
      },
      hookCtx,
    );
    emitActivity({
      type: 'agent_ended',
      agentId: id,
      // t102: `reason` feeds a failure-heuristic on the Desktop; free text in
      // it (result excerpt) could flip a SUCCESSFUL tentacle to "failed".
      // Only genuine failures carry detail; successes are enum-only.
      reason: info.ok === false ? (info.detail ?? 'failed') : 'completed',
      ok: info.ok !== false,
      durationMs: info.durationMs ?? 0,
      ts: Date.now(),
    } as BrainAgentEndedEvent);
  };

  let sub: SubAgentContext | null;
  try {
    sub = await deps.createSubAgentContext({
      agent,
      thoroughness,
      cwd: effectiveCwd,
      // Per-spawn thinking effort (ADR-0017): the factory applies arg > per-kind
      // env > inherited provider default and reports the winner back on `sub`.
      ...(args.thinkingEffort ? { thinkingEffort: args.thinkingEffort } : {}),
    });
  } catch (err) {
    if (worktree) await teardownWorktree(worktree);
    appendKrakenRadio(parentCwd, sessionId, {
      kind: 'error',
      agent,
      description: args.description,
      detail: err instanceof Error ? err.message : String(err),
      ok: false,
      durationMs: Date.now() - started,
    });
    endTentacle(liveId, { ok: false, durationMs: Date.now() - started });
    return {
      ok: false,
      agent,
      error: `task: could not initialize sub-agent — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!sub) {
    if (worktree) await teardownWorktree(worktree);
    appendKrakenRadio(parentCwd, sessionId, {
      kind: 'error',
      agent,
      description: args.description,
      detail: 'no provider',
      ok: false,
      durationMs: Date.now() - started,
    });
    endTentacle(liveId, { ok: false, durationMs: Date.now() - started });
    return {
      ok: false,
      agent,
      error: 'task: no provider configured for the sub-agent (set an API key / run /login).',
    };
  }

  // E (thinking): the value ACTUALLY applied, for the spawn event. The context
  // factory already resolved arg > per-kind env > inherited provider default and
  // reported the winner as `sub.thinking`; the explicit arg is only a fallback
  // for hand-rolled factories (tests/alternate hosts) that report nothing.
  const requestedThinking =
    args.thinkingEffort && args.thinkingEffort.toLowerCase() !== 'inherit'
      ? args.thinkingEffort
      : undefined;
  const spawnThinking = sub.thinking ?? requestedThinking;

  emitActivity({
    type: 'agent_spawned',
    agentId: liveId,
    role: agent,
    title: args.description,
    ...(sub.model ? { model: sub.model } : {}),
    ...(sub.provider ? { provider: sub.provider } : {}),
    ...(spawnThinking ? { thinking: spawnThinking } : {}),
    ...(args.scope && args.scope.length > 0 ? { scope: args.scope } : {}),
    ...(worktree ? { worktree: worktree.path } : {}),
    ts: Date.now(),
  } as BrainAgentSpawnedEvent);
  emitActivity({ type: 'agent_status', agentId: liveId, status: 'running', ts: Date.now() } as BrainAgentStatusEvent);
  // t94: live phase trail — agent_status carries the one-line caption to the
  // desktop panel row, radio 'progress' mirrors it into the persistent
  // .zelari/radio/<session>.jsonl audit trail (doctor-visible).
  const emitPhase = (message: string) => {
    emitActivity({ type: 'agent_status', agentId: liveId, status: 'running', message, ts: Date.now() } as BrainAgentStatusEvent);
    appendKrakenRadio(parentCwd, sessionId, {
      kind: 'progress',
      agent,
      thoroughness,
      description: args.description,
      detail: message,
    });
  };
  // Starting phase = the agent kind itself (explore|general|verify) — also
  // gives worktree-less tentacles (explore/verify) a first progress event.
  emitPhase(`phase: ${agent}`);
  if (worktree) emitPhase(`worktree: ${shortWorktreeCaption(worktree.path)}`);
  // WS5 (t137): `SubagentStart` — the tentacle is really running now (live
  // tracker registered, isolation resolved, first phase emitted).
  fireSubagentHook(deps.lifecycleHooks, 'SubagentStart', buildSubagentHookPayload(subagentHookBase), hookCtx);
  const taskUserContent = buildTaskUserPrompt({
    prompt: args.prompt,
    scope: args.scope,
    acceptance: withKrakenRequiredChecks(agent, args.acceptance),
  });
  // §51 — tentacles may receive a compact projected parent summary (never
  // the full lead transcript). Inert unless parentTranscript is passed.
  const parentBlock = parentContextForRole(agent, opts.parentTranscript ?? []);
  const userContent = parentBlock ? `${parentBlock.block}\n\n${taskUserContent}` : taskUserContent;
  const maxToolCalls = maxToolCallsForThoroughness(thoroughness, agent);
  const runCwd = sub.cwd || effectiveCwd;
  const config: AgentHarnessConfig = {
    model: sub.model,
    provider: sub.provider,
    messages: [
      { role: 'system', content: opts.systemPromptOverride ?? systemPromptForAgent(agent) },
      { role: 'user', content: userContent },
    ],
    tools: sub.tools,
    toolRegistry: sub.registry,
    providerStream: sub.providerStream,
    buildLiveness: {
      mutationRequired: agent === 'general',
      maxRecoveries: 2,
    },
    cwd: runCwd,
    maxToolCallsPerTurn: maxToolCalls,
    maxToolLoopIterations: Math.max(12, maxToolCalls + 4),
    ...(deps.memoryService
      ? {
          memoryService: deps.memoryService,
          memoryQuery: `${args.description}\n${taskUserContent}`,
          memoryContextChars: 2_400,
        }
      : {}),
  };

  let harness: SubAgentHarness;
  try {
    if (deps.harnessFactory) {
      harness = deps.harnessFactory(config);
    } else {
      const { AgentHarness } = await import('@zelari/core/harness');
      harness = new AgentHarness(config);
    }
  } catch (err) {
    if (worktree) await teardownWorktree(worktree);
    endTentacle(liveId, { ok: false, durationMs: Date.now() - started });
    return {
      ok: false,
      agent,
      error: `task: failed to start sub-agent — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const startedTools = new Map<string, string>();
  const onHarnessEvent = (ev: BrainEvent) => {
    if (ev.type === 'tool_execution_start') {
      startedTools.set(ev.toolCallId, ev.toolName);
      emitActivity({ type: 'agent_tool', agentId: liveId, toolCallId: ev.toolCallId, tool: ev.toolName, status: 'started', ...(ev.args ? { summary: toolCommandHint(ev.args) } : {}), ts: Date.now() } as BrainAgentToolEvent);
    } else if (ev.type === 'tool_execution_end') {
      emitActivity({ type: 'agent_tool', agentId: liveId, toolCallId: ev.toolCallId, tool: startedTools.get(ev.toolCallId) ?? 'unknown', status: ev.isError ? 'failed' : 'completed', durationMs: ev.durationMs, ts: Date.now() } as BrainAgentToolEvent);
    }
  };
  // Keep the Desktop sidecar idle clock alive: tentacle thinking_delta never
  // reaches parent NDJSON, and GLM/Grok can sit silent for minutes before
  // the first tool. Without this, TURN_IDLE_TIMEOUT cancels the lead.
  const stopHeartbeat = startTentacleHeartbeat((caption) => {
    emitActivity({
      type: 'agent_status',
      agentId: liveId,
      status: 'running',
      message: caption,
      ts: Date.now(),
    } as BrainAgentStatusEvent);
  });

  let result: string | undefined;
  let error: string | undefined;
  let aborted: boolean | undefined;
  let usage: UsageBreakdown | undefined;
  let toolTrace: TentacleToolTrace[] | undefined;
  try {
    ({ result, error, aborted, usage, toolTrace } = await runSubAgent(harness, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      onEvent: onHarnessEvent,
    }));

    // Routed cheap model 404 (e.g. Settings explore = glm-5.3-flash while the
    // lead model works): retry once on the parent identity.
    if (
      !aborted &&
      !result &&
      sub.fallback &&
      sub.fallback.model !== sub.model
    ) {
      const { isUnknownModelError } = await import('./krakenModel.js');
      if (isUnknownModelError(error)) {
        emitPhase(`model ${sub.model} unavailable — retrying with ${sub.fallback.model}`);
        const retryConfig: AgentHarnessConfig = {
          ...config,
          model: sub.fallback.model,
          provider: sub.fallback.provider,
          providerStream: sub.fallback.providerStream,
        };
        try {
          harness = deps.harnessFactory
            ? deps.harnessFactory(retryConfig)
            : new (await import('@zelari/core/harness')).AgentHarness(retryConfig);
          const retry = await runSubAgent(harness, {
            ...(opts.signal ? { signal: opts.signal } : {}),
            onEvent: onHarnessEvent,
          });
          result = retry.result;
          error = retry.error;
          aborted = retry.aborted;
          usage = retry.usage;
          toolTrace = retry.toolTrace;
          sub = { ...sub, model: sub.fallback.model, provider: sub.fallback.provider };
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }
    }
  } finally {
    stopHeartbeat();
  }
  const durationMs = Date.now() - started;

  if (aborted) {
    // Parent AbortSignal fired: user Stop, Desktop idle watchdog
    // (session.cancel reason=turn_timeout), or the task-tool wall clock.
    // Do not label this "node timeout" — that hid watchdog cancels as a
    // CLI hang.
    if (worktree && !shouldKeepWorktree()) await teardownWorktree(worktree);
    appendKrakenRadio(parentCwd, sessionId, {
      kind: 'error',
      agent,
      thoroughness,
      description: args.description,
      detail: 'cancelled by parent',
      model: sub.model,
      worktree: worktree?.path ?? null,
      durationMs,
      ok: false,
    });
    endTentacle(liveId, {
      ok: false,
      model: sub.model,
      detail: 'cancelled',
      durationMs,
    });
    return { ok: false, agent, error: 'task: sub-agent cancelled by parent', cancelled: true };
  }

  if (!result) {
    if (worktree) await teardownWorktree(worktree);
    appendKrakenRadio(parentCwd, sessionId, {
      kind: 'error',
      agent,
      thoroughness,
      description: args.description,
      detail: error ?? 'no output',
      model: sub.model,
      worktree: worktree?.path ?? null,
      durationMs,
      ok: false,
    });
    endTentacle(liveId, { ok: false, model: sub.model, detail: error, durationMs });
    return {
      ok: false,
      agent,
      error: `task: sub-agent (${agent}) produced no output${error ? ` (${error})` : ''}.`,
    };
  }

  const kept = worktree ? shouldKeepWorktree() : false;
  let footer = '';
  if (worktree && opts.deferMerge && !kept) {
    // Graph executor (F3) owns merge ordering — leave the worktree + branch
    // in place; the caller merges (sequentially, across tentacles) and
    // cleans up via the returned worktreeHandle.
    footer += `\nworktree deferred: branch=${worktree.branch} path=${worktree.path} (executor merges)`;
  } else if (worktree) {
    // G2: before cleanup, squash-merge the tentacle branch into the parent
    // HEAD so the sub-agent's edits survive. Without this the worktree is
    // removed and all edits are lost (the original gap).
    let merge: WorktreeMergeResult | null = null;
    if (!kept && isKrakenWorktreeAutoMergeEnabled()) {
      emitPhase('merging…');
      try {
        merge = await mergeKrakenWorktree(
          worktree,
          { message: `kraken: merge ${args.description.slice(0, 80)}`, sessionId },
        );
      } catch (err) {
        merge = {
          ok: false,
          merged: false,
          committed: false,
          message: `merge threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      emitPhase(merge.ok ? 'merge ok' : 'merge failed');
    } else if (!kept) {
      // auto-merge disabled — fall back to bare cleanup (old behavior)
      await teardownWorktree(worktree);
    }
    footer += `\n${formatWorktreeFooter(worktree, { kept, merge })}`;
  }
  if (agent === 'general') {
    g.__zelariLastGeneralAt = Date.now();
  }

  endTentacle(liveId, {
    ok: true,
    model: sub.model,
    detail: result.slice(0, 160),
    durationMs,
  });

  appendKrakenRadio(parentCwd, sessionId, {
    kind: agent === 'general' ? 'verify_hint' : 'done',
    agent,
    thoroughness,
    description: args.description,
    detail: result.slice(0, 240),
    model: sub.model,
    worktree: worktree?.path ?? null,
    durationMs,
    ok: true,
  });

  // t57 C1: sidecar with the FULL conclusion — the radio caps detail at 240
  // chars (biased against medium/verbose explores), which makes the
  // explore→plan coverage metric incomputable from the radio alone.
  // t57 C4: the same sidecar records the `thoroughness` this tentacle actually
  // ran with (the `task` arg, not a config guess): the flip gate phases a
  // session by what its explores DID, and a session that does not say is
  // excluded rather than assumed.
  // Fail-open: observability extra, never a dependency of the run.
  try {
    const { writeTentacleSidecar } = await import('../kraken/exploreCoverage.js');
    await writeTentacleSidecar(parentCwd, sessionId, opts.nodeId ?? liveId, {
      agent,
      thoroughness,
      model: sub.model,
      durationMs,
      result,
      worktree: worktree?.path ?? null,
    });
  } catch {
    /* fail-open: the sidecar is best-effort */
  }

  let memoryId: string | undefined;
  if (deps.memoryService && deps.memoryAutoWrite !== false) {
    try {
      // F4 (K1.4): memory only when the CANONICAL trailer parser says PASS.
      // The previous free regex /(?:VERDICT:\s*PASS|status:\s*pass)/i matched
      // any "status: pass" string inside the body (tables, quotes, prose) and
      // could turn an actual trailer `VERDICT: FAIL` into a memory PASS.
      // `parseVerifyVerdict` is the last-trailer-wins parser used everywhere
      // else in the engine — reuse it so memory writes share the same gate.
      const verifyPass =
        agent === 'verify' && parseVerifyVerdict(result).verdict === 'pass';
      // F3.3 (verify trust chain): memory only on PASS.
      //   - verify/verification: written only when its OWN verdict parsed PASS;
      //   - general/outcome: NEVER here — a general result is durable only once
      //     verified, so it is written by runAutoVerifyAfterGeneral on PASS, and
      //     an unverified outcome is never stored;
      //   - explore/finding: written only when no unverified general is pending.
      const allowMemory =
        agent === 'verify' ? verifyPass : agent === 'general' ? false : outcomeMemoryAllowed();
      if (allowMemory) {
        const memory = await deps.memoryService.remember({
          kind: agent === 'verify' ? 'verification' : 'finding',
          content: result.slice(0, 12_000),
          importance: 0.65,
          confidence: verifyPass ? 0.98 : 0.72,
          tags: ['kraken', `tentacle:${agent}`],
          source: {
            agent: `kraken-${agent}`,
            sessionId,
            tentacleId: opts.nodeId ?? liveId,
            ...(worktree?.path ? { worktree: worktree.path } : {}),
          },
          metadata: {
            writeClass: agent === 'verify' ? 'auto' : 'candidate',
            description: args.description,
            scope: args.scope ?? [],
            acceptance: args.acceptance ?? [],
            graphId: opts.graphId,
            nodeId: opts.nodeId,
            verified: verifyPass,
          },
          writeClass: agent === 'verify' ? 'auto' : 'candidate',
        });
        memoryId = memory.id;
      }
    } catch {
      // Shared memory is fail-open: a persistence issue never fails the tentacle.
    }
  }

  return {
    ok: true,
    agent,
    thoroughness,
    agentId: liveId,
    model: sub.model,
    result,
    footer,
    ...(usage ? { usage } : {}),
    ...(toolTrace && toolTrace.length > 0 ? { toolTrace } : {}),
    worktreePath: worktree?.path ?? null,
    worktreeHandle: worktree,
    ...(memoryId ? { memoryId } : {}),
  };
}

/** Build the `task` tool from injected sub-agent deps. */
export function createTaskTool(
  deps: TaskToolDeps,
  policy: TaskToolPolicy = {},
): ToolDefinition<TaskArgs & { purpose?: 'candidate' }, { result: string; agent: string }> {
  const allowedAgents: readonly TaskAgentKind[] =
    policy.allowedAgents ?? ['explore', 'general', 'verify'];
  const restricted =
    policy.allowedAgents !== undefined &&
    !(
      policy.allowedAgents.includes('explore') &&
      policy.allowedAgents.includes('general') &&
      policy.allowedAgents.includes('verify')
    );
  // When restricted, narrow the zod enum too so conforming providers cannot
  // emit a disallowed kind (belt) on top of the execute-time gate (braces).
  const inputSchema = restricted
    ? TaskArgsSchema.extend({
        agent: z
          .enum(allowedAgents as unknown as [TaskAgentKind, ...TaskAgentKind[]])
          .optional()
          .describe(
            `Sub-agent type. In this mode ONLY ${allowedAgents.join('|')} is allowed ` +
              '(plan-safe read-only tentacles).',
          ),
      })
    : TaskArgsSchema;
  return {
    name: 'task',
    description:
      'Delegate a focused sub-task to an isolated sub-agent with its own context; ' +
      'returns only a concise conclusion (keeps parent context lean).\n' +
      '- agent=explore (default): read-only research/search\n' +
      '- agent=general: can edit files for one bounded unit of work\n' +
      '- agent=verify: read + bash to run tests/checks\n' +
      'Provide a fully self-contained `prompt` (sub-agent cannot see this conversation). ' +
      'Optional scope[] + acceptance[] contracts. After general, follow up with verify.' +
      (restricted
        ? `\nRESTRICTED in this mode: only agent=${allowedAgents.join('|')} is allowed.`
        : ''),
    permissions: ['read', 'network', 'write', 'execute'],
    timeoutMs: TASK_TOOL_TIMEOUT_MS,
    inputSchema,
    execute: async (args, ctx): Promise<TypedResult<{ result: string; agent: string }>> => {
      const agent: TaskAgentKind = args.agent ?? 'explore';
      let candidateSlot = 0;
      // Fase 1 (ADR-0020): policy gate BEFORE the spawn budget — a rejected
      // kind must not consume the per-turn tentacle budget.
      if (!allowedAgents.includes(agent)) {
        return typedErr(
          `task: agent=${agent} is not allowed in this mode. Allowed: ${allowedAgents.join(', ')} ` +
            '(plan-safe read-only tentacles). Re-issue with an allowed agent kind.',
        );
      }
      // Fase 3 (ADR-0020): candidate contract — explore-only, flag-gated,
      // capped per turn. Checked BEFORE the spawn budget (same rule as the
      // policy gate: a rejected candidate must not consume the budget).
      const isCandidate = args.purpose === 'candidate';
      if (isCandidate) {
        if (!isKrakenSelectionEnabled()) {
          return typedErr(
            'task: purpose=candidate requires ZELARI_KRAKEN_SELECTION=1 (alpha feature). ' +
              'Spawn a plain explore tentacle instead.',
          );
        }
        if (agent !== 'explore') {
          return typedErr(
            'task: purpose=candidate forces agent=explore (candidates are read-only ' +
              'in v1 — zero candidate implementations, ADR-0020).',
          );
        }
        const slot = reserveCandidateSlot();
        if ('error' in slot) return typedErr(slot.error);
        candidateSlot = slot.index;
      }
      const thoroughness: TaskThoroughness = args.thoroughness ?? 'medium';
      const sessionId = ctx.sessionId || LEGACY_SESSION_KEY;
      const parentCwd = ctx.cwd || process.cwd();

      // Per-SESSION spawn cap (Kraken K3 + K3.3 / F16): the numeric limit is
      // unchanged, but it is counted per sessionId — a concurrent session in
      // the same process (companion serve) cannot exhaust this session's
      // budget. Reset via resetTaskSpawnCount(sessionId) each parent turn.
      const spawnCap = maxTaskSpawnsPerTurn();
      if (bumpTaskSpawnCount(sessionId) > spawnCap) {
        return typedErr(
          `task: spawn cap reached (${spawnCap}). Finish the current slice or raise ZELARI_KRAKEN_MAX_TASK_SPAWNS.`,
        );
      }

      const res = await runTentacle({
        deps,
        args: {
          description: args.description,
          prompt: args.prompt,
          scope: args.scope,
          acceptance: args.acceptance,
          ...(args.thinkingEffort ? { thinkingEffort: args.thinkingEffort } : {}),
        },
        agent,
        thoroughness,
        parentCwd,
        sessionId,
        // Fase 1 (ADR-0020): propagate the parent turn's cancellation signal
        // so cancel/timeout unwinds the tentacle instead of letting it run on.
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(isCandidate
          ? {
              systemPromptOverride:
                systemPromptForAgent('explore') +
                '\n\n' +
                candidateInstructions(candidateSlot),
            }
          : {}),
      });

      // Fase 3 (ADR-0020): register the structured report (malformed reports
      // are preserved as degraded evidence, never dropped). The parent still
      // sees the full conclusion text including the <candidate-report> block.
      if (isCandidate) {
        // Fase 10: real provider-reported tokens (0 when unreported/failed).
        recordCandidateTokens(res.ok ? res.usage?.totalTokens ?? 0 : 0);
        if (res.ok) {
          const parsed = parseCandidateReport(res.result);
          registerCandidate(
            parsed.ok
              ? {
                  status: 'ok' as const,
                  index: candidateSlot,
                  description: args.description,
                  report: parsed.report,
                  raw: res.result,
                }
              : {
                  status: 'malformed' as const,
                  index: candidateSlot,
                  description: args.description,
                  error: parsed.error,
                  raw: res.result,
                },
          );
        } else {
          // Failed tentacle: the slot is consumed and tracked as malformed
          // (no report arrived — degraded by definition).
          registerCandidate({
            status: 'malformed' as const,
            index: candidateSlot,
            description: args.description,
            error: res.error,
            raw: '',
          });
        }
      }
      // Fase 7 (ADR-0020): structured verification — the verify tentacle
      // reports pass/fail/unknown per required check. A failed tentacle or
      // a missing block leaves checks `unknown`: a degraded observation is
      // never proof. Only runs when a selection exists this turn (required
      // checks come from a `selected` verdict — Fase 6 routing).
      if (agent === 'verify') {
        // K1.3: ALWAYS anchor the latest verify tentacle's tool trace on the
        // per-turn channel so the auto-verify floor (≥ 1 tool execution per
        // PASS) is observable even when no selection ran this turn (no
        // required-checks path). The strict gate for PASS is
        // `getLastVerifyToolTrace().length > 0`.
        const verifyTrace = res.ok ? res.toolTrace ?? [] : [];
        setLastVerifyToolTrace(verifyTrace);
        const required = krakenRequiredChecks();
        if (required.length > 0) {
          setKrakenCheckResults(
            res.ok
              ? parseVerifyReport(res.result, required)
              : allUnknownCheckResults(required, `verify tentacle failed: ${res.error}`),
            verifyTrace,
          );
        }
      }
      if (!res.ok) return typedErr(res.error);
      let result = `[sub-agent:${res.agent}/${res.thoroughness} model=${res.model}]\n${res.result}${res.footer}`;
      // t78 (ADR-0033 slice): runtime general⇒verify obligation — after a
      // successful general, the tool itself spawns the verify (same
      // acceptance[], same tree) instead of only appending a hint footer.
      // FAIL gets at most one rework round, mirroring the graph executor.
      if (res.agent === 'general') {
        try {
          result += await runAutoVerifyAfterGeneral({
            deps,
            original: {
              description: args.description,
              prompt: args.prompt,
              scope: args.scope,
              acceptance: args.acceptance,
            },
            general: res,
            parentCwd,
            sessionId,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // K1.1: key the debt by the runtime agentId (when present) so it
          // matches the key opened by runAutoVerifyAfterGeneral; fall back
          // to the description so an early throw still lands in the same slot.
          addTaskVerifyObligation(
            res.agentId ?? args.description,
            {
              description: args.description,
              detail: `auto-verify chain failed: ${msg}`,
            },
            sessionId,
          );
          result += `\n\n[kraken:auto-verify] auto-verify chain failed (${msg}) — work stays UNVERIFIED.`;
        }
      }
      return typedOk({
        result,
        agent: res.agent,
      });
    },
  };
}
