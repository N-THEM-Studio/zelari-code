/**
 * BrainEvent — provider-neutral event contract for Zelari Code's agent system.
 *
 * These types are the ONLY contract between the agent loop (main process) and any
 * frontend (Electron renderer today, Ink CLI tomorrow). They are intentionally
 * standalone: no Electron imports, no project imports. Every payload is plain,
 * JSON-serializable data so events can cross the IPC boundary or a socket
 * untouched.
 *
 * @see docs/plans/2026-06-28-zelari-code.md (Task 11.1)
 */

/** Discriminator for every {@link BrainEvent} variant. */
export type BrainEventType =
  | 'agent_start'
  | 'agent_end'
  | 'agent_spawned'
  | 'agent_status'
  | 'agent_tool'
  | 'agent_ended'
  | 'message_start'
  | 'message_end'
  | 'message_delta'
  | 'thinking_delta'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end'
  | 'queue_update'
  | 'session_compacted'
  | 'error'
  | 'member_cost'
  | 'council_mode'
  | 'task_update'
  | 'task_snapshot'
  | 'context_metrics'
  | 'kraken_progress'
  | 'kraken_metrics';

/** Fields shared by every event. */
export interface BrainEventBase {
  /** Type discriminator. */
  type: BrainEventType;
  /** Unique event id (UUID v4 string). */
  id: string;
  /** Event timestamp (epoch ms). */
  ts: number;
  /** Session this event belongs to. */
  sessionId: string;
}

// --- Agent lifecycle --------------------------------------------------------

/**
 * The agent loop has started; carries the resolved model + provider.
 *
 * @since 0.5.0 `memberId` is included when the agent run belongs to a
 *          council member (i.e. the run was launched by the council
 *          pipeline, not by a direct user prompt). `memberName` is
 *          the human-readable label (e.g. "Caronte") for UI display
 *          without a second lookup into the roles table.
 */
export interface BrainAgentStartEvent extends BrainEventBase {
  type: 'agent_start';
  model: string;
  provider: string;
  memberId?: string;
  memberName?: string;
}

/**
 * The agent loop has finished, was cancelled, or errored out.
 *
 * @since 0.5.0 `memberId` + `memberName` mirror the corresponding
 *          `agent_start` (see above).
 */
export interface BrainAgentEndEvent extends BrainEventBase {
  type: 'agent_end';
  reason: 'completed' | 'cancelled' | 'error';
  durationMs: number;
  memberId?: string;
  memberName?: string;
}

// --- Tentacle activity (Frontier plan §37) -----------------------------------

/** Role of a Kraken tentacle as spawned via the `task` tool. */
export type TentacleAgentRole = 'explore' | 'general' | 'verify' | 'fix' | 'planner';

/** A Kraken tentacle has been spawned by the lead (via the `task` tool). */
export interface BrainAgentSpawnedEvent extends BrainEventBase {
  type: 'agent_spawned';
  agentId: string;
  role: TentacleAgentRole;
  title?: string;
  model?: string;
  provider?: string;
  scope?: string[];
  worktree?: string;
}

/** Coarse lifecycle status of a tentacle, for live activity UIs. */
export interface BrainAgentStatusEvent extends BrainEventBase {
  type: 'agent_status';
  agentId: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  message?: string;
}

/** A tool execution inside a tentacle (start/end, with duration on end). */
export interface BrainAgentToolEvent extends BrainEventBase {
  type: 'agent_tool';
  agentId: string;
  toolCallId: string;
  tool: string;
  status: 'started' | 'completed' | 'failed';
  summary?: string;
  durationMs?: number;
}

/** A tentacle finished (ok, error, cancelled or timeout). */
export interface BrainAgentEndedEvent extends BrainEventBase {
  type: 'agent_ended';
  agentId: string;
  reason: string;
  ok: boolean;
  durationMs: number;
}

// --- Message streaming ------------------------------------------------------

/**
 * An assistant message has begun streaming.
 *
 * @since 0.5.0 `memberId` + `memberName` identify the council member
 *          producing this message (omitted for direct user prompts).
 */
export interface BrainMessageStartEvent extends BrainEventBase {
  type: 'message_start';
  messageId: string;
  role: 'assistant';
  memberId?: string;
  memberName?: string;
}

/**
 * An incremental chunk of assistant message text.
 *
 * @since 0.5.0 `memberId` + `memberName` mirror `message_start` so
 *          consumers can stream-attribute text to a council member
 *          without buffering until `message_end`.
 */
export interface BrainMessageDeltaEvent extends BrainEventBase {
  type: 'message_delta';
  messageId: string;
  delta: string;
  memberId?: string;
  memberName?: string;
}

/**
 * An assistant message has finished streaming.
 *
 * @since 0.5.0 `memberId` + `memberName` mirror `message_start`.
 */
export interface BrainMessageEndEvent extends BrainEventBase {
  type: 'message_end';
  messageId: string;
  totalLength: number;
  finishReason: string;
  memberId?: string;
  memberName?: string;
  /**
   * Real token usage reported by the provider (Task G.4). When the
   * provider sends an OpenAI-shaped `usage` chunk (gated by
   * `stream_options.include_usage`), this carries the actual numbers.
   * When missing, downstream consumers fall back to the
   * ~4-characters-per-token approximation that v3-B used.
   *
   * @see docs/plans/2026-06-29-anathema-coder-v3-G.md (Task G.4.4)
   */
  usage?: UsageBreakdown;
}

/**
 * Provider-reported token usage for one assistant turn (Task G.4).
 * The numbers come from the OpenAI-compatible `usage` field in the
 * final SSE chunk before `[DONE]`. Providers that don't honor
 * `stream_options.include_usage` will not emit this — consumers must
 * degrade gracefully to the approximation.
 */
export interface UsageBreakdown {
  /** Tokens in the prompt (system + user messages, including tool messages). */
  promptTokens: number;
  /** Tokens generated by the assistant. */
  completionTokens: number;
  /** Convenience: promptTokens + completionTokens. */
  totalTokens: number;
  /**
   * Prompt tokens that were served from the provider's prompt cache
   * (a subset of `promptTokens`). OpenAI-compatible providers cache the
   * stable prompt prefix (system prompt + tool schema + early transcript)
   * automatically and bill these at a steep discount — DeepSeek ~10× cheaper,
   * OpenAI/xAI/GLM ~2–4× cheaper. Parsed from `prompt_tokens_details.cached_tokens`
   * (OpenAI/xAI/GLM) or `prompt_cache_hit_tokens` (DeepSeek). Undefined/0 when
   * the provider reports no cache hit. Used for accurate cost accounting and
   * the cache-hit-rate stat.
   */
  cachedPromptTokens?: number;
}

// --- Reasoning (optional) ---------------------------------------------------

/** An incremental chunk of the model's reasoning / thinking trace. */
export interface BrainThinkingDeltaEvent extends BrainEventBase {
  type: 'thinking_delta';
  messageId: string;
  delta: string;
}

// --- Tool execution ---------------------------------------------------------

/** A tool call has started executing. */
export interface BrainToolExecutionStartEvent extends BrainEventBase {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** Progress update emitted while a tool is still running. */
export interface BrainToolExecutionUpdateEvent extends BrainEventBase {
  type: 'tool_execution_update';
  toolCallId: string;
  delta?: string;
}

/** A tool call has finished, successfully or with an error. */
export interface BrainToolExecutionEndEvent extends BrainEventBase {
  type: 'tool_execution_end';
  toolCallId: string;
  result: string;
  isError: boolean;
  durationMs: number;
}

// --- Queued user prompts (steering / follow-up) -----------------------------

/** The count of queued user prompts has changed. */
export interface BrainQueueUpdateEvent extends BrainEventBase {
  type: 'queue_update';
  queuedCount: number;
}

// --- Session compaction -----------------------------------------------------

/** The session history was compacted into a summary. */
export interface BrainSessionCompactedEvent extends BrainEventBase {
  type: 'session_compacted';
  summary: string;
  messagesRemoved: number;
  /** v1.36.0 cache telemetry: fingerprint of the request that was compacted. */
  sourceRequestFingerprint?: string;
  /** Fingerprint of the stable header (provider+model+system+tools). */
  headerFingerprint?: string;
  /** Estimated tokens of the dropped prefix. */
  sourceEstimatedTokens?: number;
  /** Estimated tokens of the replacement checkpoint message. */
  replacementEstimatedTokens?: number;
  /** Tool results pruned in place during the same compaction. */
  prunedToolResults?: number;
  /** False when the summarizer ran on a different provider/model (no KV reuse). */
  cacheReuseExpected?: boolean;
  /** Closed interval of spine seqs this checkpoint replaces. */
  fromSeq?: number;
  toSeq?: number;
  checkpoint?: { role: 'user' | 'system'; content: string };
  strategy?: 'extractive' | 'llm';
  sourceEventSeqs?: number[];
  retainedCriterionIds?: string[];
  retainedEvidenceRefs?: unknown[];
  retainedState?: object;
  stateSnapshot?: object;
  /** Estimated model-history tokens before compaction. */
  inputTokens?: number;
  /** Estimated model-history tokens in the replacement surface. */
  outputTokens?: number;
  /** Non-negative estimated token reduction. */
  savedTokens?: number;
  /** 1 when this compaction replaces an earlier checkpoint, otherwise 0. */
  recompactionRate?: number;
  /** Narrative summarizer used for the checkpoint. */
  summaryStrategy?: 'extractive' | 'llm';
  /** Summarizer provider, present for LLM checkpoints. */
  provider?: string;
  /** Summarizer model, present for LLM checkpoints. */
  model?: string;
}

// --- Errors -----------------------------------------------------------------

/** A recoverable, fatal, or cancellation error occurred. */
export interface BrainErrorEvent extends BrainEventBase {
  type: 'error';
  severity: 'recoverable' | 'fatal' | 'cancelled';
  message: string;
  code?: string;
}

// --- Council per-member cost (Task I.1, v3-I) ------------------------------

/**
 * Per-member cost report emitted at the end of a council member's run.
 * Carries the actual `MemberCost` payload produced by
 * `MemberCostTracker.record()` (see `electron/cli/councilCost.ts`).
 *
 * Note: we inline a structural type here instead of importing the
 * `MemberCost` type, to keep this events module free of CLI-side deps
 * (architecture rule: events.ts must be renderer/Node-loadable without
 * pulling in `electron/cli/*`).
 */
export interface BrainMemberCostEvent extends BrainEventBase {
  type: 'member_cost';
  cost: {
    memberId: string;
    name: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
    toolCalls: number;
    errored: boolean;
  };
}

/** Emitted once at the start of a council run (tier + mode metadata). */
export interface BrainCouncilModeEvent extends BrainEventBase {
  type: 'council_mode';
  tier: 'lite' | 'full';
  councilSize: number;
  runMode: 'implementation' | 'design-phase';
}

// --- Workspace / session tasks (ADR-0018 slice 3b) -------------------------

/** Canonical task status across session todos and workspace plan tasks. */
export type BrainTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'blocked';

/**
 * Where a task lives: volatile per-session todos (`todo_write`) or the
 * durable workspace plan store (`task_create`/`task_update` on
 * `.zelari/plan.json`). `blocked` only ever occurs on workspace tasks.
 */
export type BrainTaskSource = 'session_todo' | 'workspace_plan';

/** Provider-neutral task payload shared by update and snapshot events. */
export interface BrainTaskPayload {
  id: string;
  title: string;
  status: BrainTaskStatus;
  phaseId?: string;
  priority?: string;
}

/**
 * A single task was created or mutated. Emitted right after the durable
 * write succeeded, so frontends can update optimistically without parsing
 * tool arguments or re-reading the store.
 */
export interface BrainTaskUpdateEvent extends BrainEventBase {
  type: 'task_update';
  source: BrainTaskSource;
  task: BrainTaskPayload;
}

/** Full task list snapshot (e.g. after `task_list` / `todo_read`). */
export interface BrainTaskSnapshotEvent extends BrainEventBase {
  type: 'task_snapshot';
  source: BrainTaskSource;
  tasks: BrainTaskPayload[];
}

// --- Kraken turn progress (ADR-0020, Fase 2) --------------------------------

/**
 * User-facing phase of one standard-Kraken parent turn, derived by
 * projection from tool activity (KrakenTurnRuntime) — the model never
 * self-reports progress. `planning` is the plan-phase counterpart of
 * `implementing`.
 */
export type KrakenProgressPhase =
  | 'understanding'
  | 'exploring'
  | 'selecting'
  | 'planning'
  | 'implementing'
  | 'verifying'
  | 'repairing'
  | 'completed';

/** Counters + phase for one Kraken turn (plain JSON, renderer-safe). */
export interface KrakenProgressPayload {
  phase: KrakenProgressPhase;
  /** Work phase of the turn: the `planning`/`implementing` label follows this. */
  mode: 'plan' | 'build';
  /** Tentacles spawned this turn (all kinds). */
  tentacles: number;
  /** Explore tentacles seen (candidate counter for the UI). */
  exploreTentacles: number;
  /** Verify tentacles seen. */
  verifyTentacles: number;
  /** Successful mutating tool calls this turn (write/edit/apply_diff). */
  writes: number;
  /** Epoch ms when the current phase was entered (elapsed display). */
  phaseEnteredAt: number;
  /**
   * Required checks registered for this turn (Fase 6: kraken_select
   * output). Absent until a selection produces checks — additive and
   * optional, so older consumers keep parsing the payload fine.
   */
  checkTotal?: number;
  /**
   * Required checks explicitly PASSED so far (Fase 7: verify
   * tentacle structured report). Only `pass` counts — `unknown`
   * never does. Absent until the first verify tentacle reports.
   */
  checksPassed?: number;
}

/**
 * A Kraken turn changed user-facing phase. Emitted ONLY on change (sparse);
 * counters ride the payload. Consumers without a Kraken card ignore it
 * safely — additive by design, like task_update/task_snapshot (ADR-0018 3b).
 */
export interface BrainKrakenProgressEvent extends BrainEventBase {
  type: 'kraken_progress';
  progress: KrakenProgressPayload;
}

/**
 * Turn-level Kraken selection metrics (Fase 10, ADR-0020 §58). Emitted ONCE
 * per turn — only when the turn actually used the selection flow (null
 * snapshot on plain turns ⇒ no event ⇒ simple tasks pay zero overhead).
 * Consumers without a Kraken card ignore it safely (additive by design).
 */
export interface KrakenMetricsPayload {
  selectionUsed: boolean;
  candidateCount: number;
  /** Provider-reported total tokens across candidate tentacles (0 if none reported). */
  candidateTokens: number;
  /** Provider-reported tokens for the judging call (absent if not reported). */
  selectionTokens?: number;
  /** Wall-clock ms of the judging call. */
  selectionLatencyMs?: number;
  selectionFallback: boolean;
  selectionFallbackReason?: string;
  needsMoreEvidence: boolean;
  verificationPass: number;
  verificationFail: number;
  verificationUnknown: number;
  repairTriggered: boolean;
  repairSucceeded: boolean;
}

export interface BrainKrakenMetricsEvent extends BrainEventBase {
  type: 'kraken_metrics';
  metrics: KrakenMetricsPayload;
}

/** Discriminated union of every event the brain can emit. */
export type BrainEvent =
  | BrainAgentStartEvent
  | BrainAgentEndEvent
  | BrainAgentSpawnedEvent
  | BrainAgentStatusEvent
  | BrainAgentToolEvent
  | BrainAgentEndedEvent
  | BrainMessageStartEvent
  | BrainMessageDeltaEvent
  | BrainMessageEndEvent
  | BrainThinkingDeltaEvent
  | BrainToolExecutionStartEvent
  | BrainToolExecutionUpdateEvent
  | BrainToolExecutionEndEvent
  | BrainQueueUpdateEvent
  | BrainSessionCompactedEvent
  | BrainErrorEvent
  | BrainMemberCostEvent
  | BrainCouncilModeEvent
  | BrainTaskUpdateEvent
  | BrainTaskSnapshotEvent
  | BrainContextMetricsEvent
  | BrainKrakenProgressEvent
  | BrainKrakenMetricsEvent;

/**
 * Map from a {@link BrainEventType} discriminator to its concrete event type.
 * Lets callers say `BrainEventOf<'agent_start'>` instead of repeating the
 * `Extract<BrainEvent, { type: ... }>` dance.
 */
export type BrainEventOf<T extends BrainEventType> = Extract<BrainEvent, { type: T }>;

// --- Context-growth metrics (Fase M) ----------------------------------------

/**
 * Per-run context-growth metrics, emitted once at the end of a run, right
 * before `agent_end`. Log-only by design: it is NEVER rendered into the
 * model-facing message history — consumers persist it (session JSONL,
 * metrics.jsonl) or display it (doctor, /cache).
 *
 * Makes the "context-growth avoidance" thesis falsifiable: what entered
 * the context (tool bytes), how big the request surface was, and how much
 * of it the provider prefix cache actually absorbed.
 */
export interface BrainContextMetricsEvent extends BrainEventBase {
  type: 'context_metrics';
  /** Tool executions completed this run (round-trips). */
  toolRoundTrips: number;
  /** UTF-8 bytes of tool results appended to model history this run. */
  intermediateToolBytes: number;
  /** LLM requests issued this run (>= 1; grows with the tool loop). */
  requests: number;
  /** UTF-8 bytes of the serialized messages array at the LAST request. */
  historyBytesLast: number;
  /** Max historyBytesLast across all requests this run. */
  historyBytesPeak: number;
  /** Prompt tokens served from the provider prefix cache this run. */
  cacheHitTokens: number;
}


// --- Type guards ------------------------------------------------------------

export function isBrainAgentStartEvent(e: BrainEvent): e is BrainAgentStartEvent {
  return e.type === 'agent_start';
}

export function isBrainAgentEndEvent(e: BrainEvent): e is BrainAgentEndEvent {
  return e.type === 'agent_end';
}

export function isBrainMessageStartEvent(e: BrainEvent): e is BrainMessageStartEvent {
  return e.type === 'message_start';
}

export function isBrainMessageDeltaEvent(e: BrainEvent): e is BrainMessageDeltaEvent {
  return e.type === 'message_delta';
}

export function isBrainMessageEndEvent(e: BrainEvent): e is BrainMessageEndEvent {
  return e.type === 'message_end';
}

export function isBrainThinkingDeltaEvent(e: BrainEvent): e is BrainThinkingDeltaEvent {
  return e.type === 'thinking_delta';
}

export function isBrainToolExecutionStartEvent(e: BrainEvent): e is BrainToolExecutionStartEvent {
  return e.type === 'tool_execution_start';
}

export function isBrainToolExecutionUpdateEvent(e: BrainEvent): e is BrainToolExecutionUpdateEvent {
  return e.type === 'tool_execution_update';
}

export function isBrainToolExecutionEndEvent(e: BrainEvent): e is BrainToolExecutionEndEvent {
  return e.type === 'tool_execution_end';
}

export function isBrainQueueUpdateEvent(e: BrainEvent): e is BrainQueueUpdateEvent {
  return e.type === 'queue_update';
}

export function isBrainSessionCompactedEvent(e: BrainEvent): e is BrainSessionCompactedEvent {
  return e.type === 'session_compacted';
}

export function isBrainErrorEvent(e: BrainEvent): e is BrainErrorEvent {
  return e.type === 'error';
}

export function isBrainMemberCostEvent(e: BrainEvent): e is BrainMemberCostEvent {
  return e.type === 'member_cost';
}

export function isBrainCouncilModeEvent(e: BrainEvent): e is BrainCouncilModeEvent {
  return e.type === 'council_mode';
}

export function isBrainTaskUpdateEvent(e: BrainEvent): e is BrainTaskUpdateEvent {
  return e.type === 'task_update';
}

export function isBrainTaskSnapshotEvent(e: BrainEvent): e is BrainTaskSnapshotEvent {
  return e.type === 'task_snapshot';
}

export function isBrainContextMetricsEvent(e: BrainEvent): e is BrainContextMetricsEvent {
  return e.type === 'context_metrics';
}

export function isBrainKrakenProgressEvent(e: BrainEvent): e is BrainKrakenProgressEvent {
  return e.type === 'kraken_progress';
}

export function isBrainKrakenMetricsEvent(e: BrainEvent): e is BrainKrakenMetricsEvent {
  return e.type === 'kraken_metrics';
}

// --- Constructor ------------------------------------------------------------

/**
 * Build a fully-formed {@link BrainEvent}, stamping the common `id` (UUID v4)
 * and `ts` (epoch ms) fields automatically. The caller supplies only the
 * variant-specific payload.
 *
 * Uses the global `crypto.randomUUID()` (Web Crypto), available in both Node 20+
 * and the browser/renderer — keeping this module free of Node-only imports.
 *
 * @example
 * const ev = createBrainEvent('message_delta', sessionId, { messageId, delta });
 */
export function createBrainEvent<T extends BrainEventType>(
  type: T,
  sessionId: string,
  data: Omit<BrainEventOf<T>, 'type' | 'id' | 'ts' | 'sessionId'>,
): BrainEventOf<T> {
  return {
    type,
    id: crypto.randomUUID(),
    ts: Date.now(),
    sessionId,
    ...data,
  } as BrainEventOf<T>;
}
