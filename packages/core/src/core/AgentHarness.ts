/**
 * AgentHarness — provider-neutral agent loop.
 *
 * Encapsulates a single agent turn: given a (model, provider, messages, tools)
 * configuration and a provider streaming function, it drives the stream and
 * yields the full {@link BrainEvent} lifecycle as an `AsyncIterable<BrainEvent>`.
 *
 * Electron-free: this module imports ONLY from `electron/shared/` (the event
 * contract + bus) and `electron/main/core/tools/` (the tool registry). It has
 * zero coupling to `llm.ts` or any main-process IPC, so it can run in the
 * Electron main process today and be reused from the Ink CLI in Phase 14.
 *
 * When `toolRegistry` is provided, tool_call deltas trigger real tool
 * execution and emit a matching `tool_execution_end` event. Without it, the
 * harness only emits `tool_execution_start` (legacy behavior, useful for
 * streaming-only consumers).
 *
 * @see docs/plans/2026-06-28-zelari-code.md (Task 12.1 + 14.8)
 */

import { EventBus } from '../shared/eventBus.js';
import {
  createBrainEvent,
  type BrainEvent,
  type BrainAgentStartEvent,
  type BrainAgentEndEvent,
  type BrainMessageStartEvent,
  type BrainMessageDeltaEvent,
  type BrainMessageEndEvent,
  type BrainQueueUpdateEvent,
  type BrainToolExecutionEndEvent,
  type UsageBreakdown,
} from '../shared/events.js';
import { ToolRegistry } from './tools/registry.js';

// --- Public types -----------------------------------------------------------

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For tool messages: the tool call id this result corresponds to. */
  toolCallId?: string;
  /**
   * For assistant messages that requested tool calls: the list of tool
   * invocations the model emitted in this turn. The provider maps this to
   * OpenAI `tool_calls` so a subsequent request can continue the conversation
   * after tool results are appended.
   */
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
}

export interface AgentToolSpec {
  /** Tool name (must match the tool registry). */
  name: string;
  /** JSON-schema-like description for the LLM. */
  description: string;
  /** JSON Schema for the tool's input arguments. */
  parameters: Record<string, unknown>;
}

export interface AgentHarnessConfig {
  /** Model identifier (e.g. 'grok-4', 'MiniMax-M2.5'). */
  model: string;
  /** Provider id (e.g. 'grok', 'minimax', 'glm', 'custom'). */
  provider: string;
  /** Conversation transcript (system prompt is composed by the caller). */
  messages: AgentMessage[];
  /** Tools available to the agent (may be empty). */
  tools: AgentToolSpec[];
  /** Optional event bus. When omitted, events are silently dropped. */
  eventBus?: EventBus;
  /** Optional session id for event grouping. Defaults to a UUID. */
  sessionId?: string;
  /**
   * Provider function that yields raw text deltas + finish reason.
   * Implementation in Task 12.5 (currently lives in llm.ts).
   */
  providerStream: ProviderStreamFn;
  /**
   * Optional tool registry. When provided, tool_call deltas trigger real
   * tool execution and emit a matching `tool_execution_end` event.
   */
  toolRegistry?: ToolRegistry;
  /** Optional cwd for tool execution. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Maximum tool calls per single turn (Task G.2, carryover from v3-C
   * C.1.5). When the harness sees more than this many `tool_call`
   * deltas in a single turn, the extra ones are NOT executed by the
   * registry — instead a synthetic `tool_execution_end` event is
   * emitted with `isError: true, result: '[skipped] maxToolCallsPerTurn
   * reached'`. The `tool_execution_start` event still fires so the UI
   * can render the tool attempt.
   *
   * Default: undefined (no limit — backward compatible with v3-C behavior).
   * Council sets it to 5 by default via `PureCouncilConfig.maxToolCallsPerTurn`.
   *
   * Mitigation rationale: a council member prompted with "explore the repo"
   * could otherwise fire 50 read_file calls in one turn, ballooning the
   * message context to the point where the next provider call fails with
   * HTTP 400 (context length exceeded).
   */
  maxToolCallsPerTurn?: number;
  /**
   * Maximum number of drained queued prompts per run() invocation.
   * When the queue is non-empty after a turn, the harness re-enters
   * the providerStream loop up to this many times before yielding
   * agent_end. Default 3. Set to 0 to disable queue draining.
   */
  maxQueuedIterations?: number;
  /**
   * Soft maximum of tool-loop iterations (observe → reason → act cycles)
   * per run() before the harness considers extending or forcing a final
   * answer. Default 30. Overridable via ZELARI_MAX_TOOL_LOOP_ITERATIONS.
   *
   * v1.8.3: this is a SOFT budget — if the model still wants tools and the
   * hard cap has not been reached, the harness auto-extends in chunks so
   * multi-step implementation can finish without a premature "budget
   * exhausted" summary.
   */
  maxToolLoopIterations?: number;
  /**
   * Hard ceiling on tool-loop iterations (absolute stop). Default =
   * max(soft×3, soft+60), overridable via ZELARI_MAX_TOOL_LOOP_HARD.
   * Set equal to soft to disable dynamic extension (pre-1.8.3 behavior).
   * Set 0 to use the computed default.
   *
   * @since v1.8.3
   */
  maxToolLoopHardCap?: number;
  /**
   * Optional council-member identity, propagated to every event the
   * harness emits (`agent_start`, `agent_end`, `message_start`,
   * `message_delta`, `message_end`). When set, the event stream
   * becomes self-describing for visible-reasoning UIs.
   *
   * Direct user prompts (non-council) leave this undefined.
   *
   * @since 0.5.0
   */
  memberId?: string;
  /** Human-readable member label (e.g. "Caronte"). See `memberId`. */
  memberName?: string;
}

export type ProviderStreamFn = (params: {
  messages: AgentMessage[];
  model: string;
  provider: string;
  tools: AgentToolSpec[];
  signal?: AbortSignal;
}) => AsyncIterable<ProviderDelta>;

/** Provider-neutral streaming delta (one chunk from a provider). */
export type ProviderDelta =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool_call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { kind: 'finish'; reason: string }
  | { kind: 'error'; message: string }
  /** Provider-reported token usage (Task G.4). Emitted as a standalone
   * delta so it can arrive anywhere in the stream — typically right
   * before `[DONE]` when `stream_options.include_usage` is set. */
  | { kind: 'usage'; usage: UsageBreakdown };

// --- Harness ----------------------------------------------------------------

export class AgentHarness {
  private readonly config: AgentHarnessConfig;
  private readonly eventBus: EventBus | undefined;
  private readonly sessionId: string;
  private readonly maxQueuedIterations: number;
  private readonly maxToolLoopIterations: number;
  private readonly maxToolLoopHardCap: number;
  private cancelled = false;
  private activeController: AbortController | null = null;
  private queue: string[] = [];
  /**
   * Per-run cache of executed tool calls keyed by `hash(toolName + canonical
   * args)`. v0.7.1 (A2): when the model re-issues an identical call (a
   * observed failure mode where read_file hit the same path ×3 / cat the
   * same file ×3), the cached result is replayed with a "duplicate call"
   * prefix instead of re-executing — preserving the iteration budget for
   * real progress. Reset on every `run()` so it does not leak across turns.
   */
  private toolCallCache: Map<string, string> = new Map();

  /**
   * How many times this run re-entered the provider because the model emitted
   * tool calls as a `---TOOLS---` text block (fallback format) instead of native
   * tool_calls. Capped so a model that keeps re-emitting the same block can't
   * loop forever. Reset on every `run()`.
   */
  private textToolReentries = 0;

  constructor(config: AgentHarnessConfig) {
    this.config = config;
    this.eventBus = config.eventBus;
    this.sessionId = config.sessionId ?? crypto.randomUUID();
    this.maxQueuedIterations = config.maxQueuedIterations ?? 3;
    this.maxToolLoopIterations = config.maxToolLoopIterations ?? 30;
    // Hard cap: explicit config, else soft×3 (min soft+60) so long builds
    // can finish without unbounded loops.
    const soft = this.maxToolLoopIterations;
    const hardCfg = config.maxToolLoopHardCap;
    this.maxToolLoopHardCap =
      typeof hardCfg === 'number' && hardCfg > 0
        ? Math.max(soft, hardCfg)
        : Math.max(soft * 3, soft + 60);
  }

  /**
   * Snapshot of the live transcript (`this.config.messages`) as mutated
   * across `run()` iterations — the seed passed at construction plus any
   * assistant turns (with `toolCalls`) and tool results the loop appended.
   *
   * Used by the single-agent chat loop to carry rolling history across
   * turns: after a run completes, the caller reads the tail of this array
   * (the assistant/tool messages produced this turn) and feeds it back as
   * the seed for the next turn, so the model sees its own prior question
   * when the user answers with a short reply.
   *
   * The returned reference is the live array — callers MUST treat it as
   * read-only (do not mutate). Copy (`[...harness.getMessages()]`) before
   * retaining across runs.
   *
   * @since v1.6.0
   */
  getMessages(): readonly AgentMessage[] {
    return this.config.messages;
  }

  /**
   * Member identity fields (memberId + memberName) to merge into every
   * event payload. Returns an empty object when the run is a direct
   * user prompt (no member context), so call sites can spread it
   * unconditionally.
   *
   * @since v0.5.0
   */
  private memberFields(): { memberId?: string; memberName?: string } {
    return {
      ...(this.config.memberId ? { memberId: this.config.memberId } : {}),
      ...(this.config.memberName ? { memberName: this.config.memberName } : {}),
    };
  }

  /**
   * v1.8.0: true when a tool may run concurrently with other parallel-safe
   * tools. Write/execute tools stay serial (preserve file/order safety).
   * `task` is parallel-safe (read-only sub-agents). Opt out: ZELARI_PARALLEL_TOOLS=0.
   */
  private isParallelSafeTool(toolName: string): boolean {
    if (process.env.ZELARI_PARALLEL_TOOLS === '0') return false;
    if (toolName === 'task') return true;
    const def = this.config.toolRegistry?.get(toolName);
    if (!def) {
      // Unknown / MCP: allow parallel for search-like MCP tools; serial otherwise.
      if (toolName.startsWith('mcp_')) {
        const lower = toolName.toLowerCase();
        if (lower.includes('write') || lower.includes('edit') || lower.includes('delete')) {
          return false;
        }
        return true;
      }
      return false;
    }
    const perms = def.permissions ?? [];
    if (perms.includes('write') || perms.includes('execute')) return false;
    return true;
  }

  /**
   * Execute buffered native tool calls: consecutive parallel-safe tools run
   * via Promise.all (chunked by ZELARI_MAX_PARALLEL_TOOLS, default 6); write/
   * execute tools run one-at-a-time in order.
   */
  private async executePendingTools(
    pending: ReadonlyArray<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      skipped: boolean;
      cached?: string;
    }>,
    maxToolCalls: number | undefined,
  ): Promise<
    Array<{
      toolCallId: string;
      content: string;
      isError: boolean;
      endEvent: BrainToolExecutionEndEvent;
      cacheKey?: string;
    }>
  > {
    const out: Array<{
      toolCallId: string;
      content: string;
      isError: boolean;
      endEvent: BrainToolExecutionEndEvent;
      cacheKey?: string;
    }> = new Array(pending.length);

    const maxParallel = Math.max(
      1,
      Number.parseInt(process.env.ZELARI_MAX_PARALLEL_TOOLS ?? '6', 10) || 6,
    );

    // In-flight map so identical tool+args within a parallel batch share one
    // invoke (duplicate short-circuit still holds when tools run concurrently).
    const inflight = new Map<
      string,
      Promise<{ content: string; isError: boolean; durationMs: number }>
    >();

    const invokeOne = async (
      p: (typeof pending)[number],
    ): Promise<{ content: string; isError: boolean; durationMs: number; cacheKey?: string }> => {
      if (p.cached !== undefined) {
        return {
          content: p.cached,
          isError: p.skipped || p.cached.startsWith('[skipped]'),
          durationMs: 0,
        };
      }
      if (p.skipped || !this.config.toolRegistry) {
        return {
          content: `[skipped] maxToolCallsPerTurn reached (limit=${maxToolCalls})`,
          isError: true,
          durationMs: 0,
        };
      }
      const callKey = hashToolCall(p.toolName, p.args);
      const fromRunCache = this.toolCallCache.get(callKey);
      if (fromRunCache !== undefined) {
        return {
          content: `[duplicate call — result repeated; do not call this tool again with the same arguments]\n${fromRunCache}`,
          isError: false,
          durationMs: 0,
        };
      }
      const existing = inflight.get(callKey);
      if (existing) {
        const shared = await existing;
        return {
          content: `[duplicate call — result repeated; do not call this tool again with the same arguments]\n${shared.content}`,
          isError: false,
          durationMs: 0,
        };
      }
      const startMs = Date.now();
      const prom = (async () => {
        const result = await this.config.toolRegistry!.invoke<unknown>(p.toolName, p.args, {
          cwd: this.config.cwd,
          sessionId: this.sessionId,
          signal: this.activeController?.signal,
        });
        let resultStr = '';
        if (result.ok) {
          if (typeof result.value === 'string') resultStr = result.value;
          else if (typeof result.value === 'object' && result.value !== null) {
            resultStr = JSON.stringify(result.value, null, 2);
          } else resultStr = String(result.value);
        } else {
          resultStr = result.error;
        }
        return {
          content: resultStr,
          isError: !result.ok,
          durationMs: Date.now() - startMs,
        };
      })();
      inflight.set(callKey, prom);
      const r = await prom;
      if (!r.isError) this.toolCallCache.set(callKey, r.content);
      return { ...r, cacheKey: callKey };
    };

    const toOut = (
      p: (typeof pending)[number],
      r: { content: string; isError: boolean; durationMs: number; cacheKey?: string },
    ) => {
      const endEvent = createBrainEvent('tool_execution_end', this.sessionId, {
        toolCallId: p.toolCallId,
        result: r.content,
        isError: r.isError,
        durationMs: r.durationMs,
      }) as BrainToolExecutionEndEvent;
      return {
        toolCallId: p.toolCallId,
        content: r.content,
        isError: r.isError,
        endEvent,
        // Cache already written in invokeOne; no need to re-set.
      };
    };

    let i = 0;
    while (i < pending.length) {
      const p = pending[i]!;
      if (p.skipped || p.cached !== undefined || !this.isParallelSafeTool(p.toolName)) {
        out[i] = toOut(p, await invokeOne(p));
        i += 1;
        continue;
      }

      // Consecutive parallel-safe tools → one or more Promise.all chunks.
      let j = i;
      while (
        j < pending.length &&
        !pending[j]!.skipped &&
        pending[j]!.cached === undefined &&
        this.isParallelSafeTool(pending[j]!.toolName)
      ) {
        j += 1;
      }
      for (let off = i; off < j; off += maxParallel) {
        const end = Math.min(off + maxParallel, j);
        const slice = pending.slice(off, end);
        const results = await Promise.all(slice.map((item) => invokeOne(item)));
        for (let k = 0; k < results.length; k++) {
          out[off + k] = toOut(slice[k]!, results[k]!);
        }
      }
      i = j;
    }

    return out;
  }

  /**
   * Cancel the in-flight run. Events drain until end of stream.
   *
   * Idempotent: calling cancel() multiple times is safe — the cancelled
   * flag stays true and AbortController.abort() is itself a no-op on
   * already-aborted controllers. If no turn is running, this is a
   * no-op (the next run() invocation will check the cancelled flag
   * and emit `agent_end` with `reason: 'cancelled'` before any work).
   *
   * After cancel() returns, the harness should be discarded by the
   * caller (the run() generator finishes after the current turn ends).
   * For mid-stream interrupt + new-prompt injection, see Task C.3.2.
   */
  cancel(): void {
    if (this.cancelled) return; // idempotent — don't re-abort
    this.cancelled = true;
    this.activeController?.abort();
  }

  /** Current size of the queued user-prompt buffer. */
  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Enqueue a user prompt to be processed at the next opportunity.
   * The next prompt in the queue will be appended to the conversation
   * transcript and re-enter the provider stream loop after the current
   * turn finishes. Emits a `queue_update` event so UIs can refresh
   * the displayed counter.
   *
   * If `run()` has already returned (no active loop), the queued
   * prompt will be picked up on the *next* run() call — note this
   * helper does NOT itself trigger a run. Callers wire the
   * dequeue step inside `run()` (Task 18.1).
   */
  enqueue(userText: string): void {
    this.queue.push(userText);
    const queueEvent: BrainQueueUpdateEvent = createBrainEvent('queue_update', this.sessionId, {
      queuedCount: this.queue.length,
    });
    this.emit(queueEvent);
  }

  /**
   * Dequeue the next queued prompt, or `null` if the queue is empty.
   * Emits a `queue_update` event with the new length so UIs can
   * decrement the counter.
   */
  dequeueNext(): string | null {
    const next = this.queue.shift() ?? null;
    const queueEvent: BrainQueueUpdateEvent = createBrainEvent('queue_update', this.sessionId, {
      queuedCount: this.queue.length,
    });
    this.emit(queueEvent);
    return next;
  }

  /**
   * Run a single agent turn and yield provider-neutral BrainEvents.
   * The returned AsyncIterable emits all BrainEvents for the run, then completes.
   * Callers can subscribe via eventBus AND iterate the returned iterable.
   */
  async *run(): AsyncIterable<BrainEvent> {
    const startTime = Date.now();
    this.activeController = new AbortController();
    // Reset the per-run duplicate-call cache (v0.7.1 A2).
    this.toolCallCache = new Map();
    this.textToolReentries = 0;

    // Emit agent_start
    const startEvent: BrainAgentStartEvent = createBrainEvent('agent_start', this.sessionId, {
      model: this.config.model,
      provider: this.config.provider,
      ...this.memberFields(),
    });
    this.emit(startEvent);
    yield startEvent;

    // === Initial turn (always runs to preserve Phase 12.x behavior) ===
    // The harness processes the messages buffer that was provided in
    // the config. Backward compat: existing callers expect a single
    // provider call here even when the queue is empty.
    const initialMessageId = crypto.randomUUID();
    let totalLength = 0;
    let hadError = false;

    const initialMsgStart: BrainMessageStartEvent = createBrainEvent(
      'message_start',
      this.sessionId,
      { messageId: initialMessageId, role: 'assistant', ...this.memberFields() },
    );
    this.emit(initialMsgStart);
    yield initialMsgStart;

    let initialTurnLength = 0;
    const initialFinishRef = { value: 'stop' };
    // Task G.4.3 — capture real provider usage for this turn. The ref
    // is read after runSingleTurn returns and attached to message_end.
    const initialUsageRef = { value: null as UsageBreakdown | null };
    for await (const ev of this.runSingleTurn(initialMessageId, initialFinishRef, initialUsageRef)) {
      if (ev.type === 'message_delta') {
        initialTurnLength += (ev as BrainMessageDeltaEvent).delta.length;
      } else if (ev.type === 'error') {
        // Cancellations are emitted as error events with severity='cancelled'
        // (Task C.3.1) — they must NOT set hadError, otherwise the final
        // agent_end would emit reason='error' instead of 'cancelled'.
        if (ev.severity !== 'cancelled') {
          hadError = true;
        }
      }
      yield ev;
    }
    totalLength += initialTurnLength;

    const initialMsgEnd: BrainMessageEndEvent = createBrainEvent('message_end', this.sessionId, {
      messageId: initialMessageId,
      totalLength: initialTurnLength,
      finishReason: initialFinishRef.value,
      ...this.memberFields(),
      ...(initialUsageRef.value ? { usage: initialUsageRef.value } : {}),
    });
    this.emit(initialMsgEnd);
    yield initialMsgEnd;

    // === Agentic tool-call loop ===
    // Soft budget (maxToolLoopIterations) can auto-extend up to the hard cap
    // when the model still wants tools — multi-step work finishes instead of
    // dying mid-task with "budget exhausted". Absolute hard cap still bounds
    // runaway loops. Env: ZELARI_MAX_TOOL_LOOP_ITERATIONS / _HARD.
    let toolLoopTurns = 0;
    let softCap = this.maxToolLoopIterations;
    const hardCap = this.maxToolLoopHardCap;
    let extensions = 0;
    const maxExtensions = 8;

    while (
      !this.cancelled &&
      !hadError &&
      toolLoopTurns < softCap &&
      initialFinishRef.value === 'tool_calls'
    ) {
      toolLoopTurns++;

      const turnMessageId = crypto.randomUUID();
      const msgStart: BrainMessageStartEvent = createBrainEvent(
        'message_start',
        this.sessionId,
        { messageId: turnMessageId, role: 'assistant', ...this.memberFields() },
      );
      this.emit(msgStart);
      yield msgStart;

      let turnLength = 0;
      const turnFinishRef = { value: 'stop' };
      const turnUsageRef = { value: null as UsageBreakdown | null };
      for await (const ev of this.runSingleTurn(turnMessageId, turnFinishRef, turnUsageRef)) {
        if (ev.type === 'message_delta') {
          turnLength += (ev as BrainMessageDeltaEvent).delta.length;
        } else if (ev.type === 'error') {
          if (ev.severity !== 'cancelled') hadError = true;
        }
        yield ev;
      }
      totalLength += turnLength;

      const msgEnd: BrainMessageEndEvent = createBrainEvent('message_end', this.sessionId, {
        messageId: turnMessageId,
        totalLength: turnLength,
        finishReason: turnFinishRef.value,
        ...this.memberFields(),
        ...(turnUsageRef.value ? { usage: turnUsageRef.value } : {}),
      });
      this.emit(msgEnd);
      yield msgEnd;

      // Drive the loop: keep going only if this turn again requested tool calls.
      initialFinishRef.value = turnFinishRef.value;
      if (hadError || this.cancelled) break;

      // Soft-cap hit but model still wants tools → extend until hard cap.
      if (
        initialFinishRef.value === 'tool_calls' &&
        toolLoopTurns >= softCap &&
        toolLoopTurns < hardCap &&
        extensions < maxExtensions
      ) {
        extensions++;
        const chunk = this.maxToolLoopIterations;
        softCap = Math.min(hardCap, softCap + chunk);
        this.config.messages.push({
          role: 'user',
          content:
            `[system] Soft tool budget reached (${toolLoopTurns}/${hardCap} hard). ` +
            `Work may be incomplete — CONTINUE with tools as needed to finish remaining steps. ` +
            `Prefer concrete progress over summarizing. Do not apologize for budgets.`,
        });
        const note = createBrainEvent('error', this.sessionId, {
          severity: 'recoverable',
          message: `Tool budget extended (${toolLoopTurns}→${softCap}, hard ${hardCap}) to allow completion.`,
          code: 'tool_budget_extended',
        });
        this.emit(note);
        yield note;
      }
    }

    // === Final-answer guarantee (v0.7.1 A2 / v1.8.3 hard cap only) ===
    // Only force a no-tools closing answer when the HARD cap is hit (or soft
    // equals hard and we cannot extend). Soft exhaustion alone is handled by
    // the extension block above.
    const hitHardCap =
      toolLoopTurns >= hardCap ||
      (toolLoopTurns >= softCap && softCap >= hardCap);
    if (
      !this.cancelled &&
      !hadError &&
      initialFinishRef.value === 'tool_calls' &&
      hitHardCap
    ) {
      yield* this.runFinalAnswerTurn();
    }

    // === Queue drain (Task 18.1) ===
    // After the initial turn, drain queued user prompts up to
    // maxQueuedIterations. Each iteration appends the next dequeued
    // user prompt to messages, then re-enters the provider stream.
    // Loop terminates on cancel, error, empty queue, or max iterations.
    let turns = 0;
    while (turns < this.maxQueuedIterations) {
      if (this.cancelled) break;
      if (this.queue.length === 0) break;

      const queuedPrompt = this.dequeueNext();
      if (queuedPrompt === null) break;

      // Append to conversation transcript for this turn
      this.config.messages.push({ role: 'user', content: queuedPrompt });

      const turnMessageId = crypto.randomUUID();
      const msgStart: BrainMessageStartEvent = createBrainEvent('message_start', this.sessionId, {
        messageId: turnMessageId,
        role: 'assistant',
        ...this.memberFields(),
      });
      this.emit(msgStart);
      yield msgStart;

      let turnLength = 0;
      const turnFinishRef = { value: 'stop' };
      const turnUsageRef = { value: null as UsageBreakdown | null };
      for await (const ev of this.runSingleTurn(turnMessageId, turnFinishRef, turnUsageRef)) {
        if (ev.type === 'message_delta') {
          turnLength += (ev as BrainMessageDeltaEvent).delta.length;
        } else if (ev.type === 'error') {
          hadError = true;
        }
        yield ev;
      }
      totalLength += turnLength;

      const msgEnd: BrainMessageEndEvent = createBrainEvent('message_end', this.sessionId, {
        messageId: turnMessageId,
        totalLength: turnLength,
        finishReason: turnFinishRef.value,
        ...this.memberFields(),
        ...(turnUsageRef.value ? { usage: turnUsageRef.value } : {}),
      });
      this.emit(msgEnd);
      yield msgEnd;

      turns++;
    }

    // Emit agent_end
    const agentEnd: BrainAgentEndEvent = createBrainEvent('agent_end', this.sessionId, {
      reason: hadError ? 'error' : this.cancelled ? 'cancelled' : 'completed',
      durationMs: Date.now() - startTime,
      ...this.memberFields(),
    });
    this.emit(agentEnd);
    yield agentEnd;

    this.activeController = null;
  }

  /**
   * Run a single provider turn for the current message buffer.
   * Streams from the provider, dispatches deltas to events, executes
   * any tool calls (if a registry was provided). Yields each
   * `BrainEvent` it produces so the caller can re-emit them in
   * the outer generator.
   *
   * Does NOT emit `message_start` / `message_end` — those are the
   * caller's responsibility (so the outer generator can wrap them
   * around the yielded event stream and compute the right
   * `totalLength` from observed deltas).
   *
   * Extracted from the original monolithic `run()` body to enable
   * the queue-draining loop in Task 18.1.
   */
  private async *runSingleTurn(
    messageId: string,
    finishRef: { value: string },
    usageRef: { value: UsageBreakdown | null },
  ): AsyncIterable<BrainEvent> {
    try {
      const stream = this.config.providerStream({
        messages: this.config.messages,
        model: this.config.model,
        provider: this.config.provider,
        tools: this.config.tools,
        signal: this.activeController?.signal,
      });

      // Per-turn tool call counter (Task G.2). Reset on every turn so
      // queue-drained turns don't accumulate across prompts.
      let toolCallsThisTurn = 0;
      const maxToolCalls = this.config.maxToolCallsPerTurn;

      // Accumulate this turn's text + tool calls so we can append an assistant
      // message (with tool_calls) to the transcript before re-entering the
      // provider. Without this, tool results would arrive at the API with no
      // preceding assistant tool_calls message → HTTP 400.
      let turnText = '';
      const turnToolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
      // Buffer this turn's tool results and flush them AFTER the assistant
      // message (with tool_calls) on `finish`. OpenAI ordering requires every
      // role:'tool' message to follow the assistant message that declared the
      // matching tool_calls. Pushing results inline (as they execute) put them
      // BEFORE the assistant message → strict providers reject the next request
      // (MiniMax: "tool result's tool id ... not found (2013)"). xAI/grok
      // tolerated the reversed order; MiniMax/GLM do not.
      const turnToolResults: { toolCallId: string; content: string }[] = [];
      // v1.8.0: queue native tool_call deltas; execute on `finish` so
      // consecutive read-only tools (and multi-`task`) run in parallel.
      type PendingNativeTool = {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        skipped: boolean;
        cached?: string;
      };
      const pendingNativeTools: PendingNativeTool[] = [];

      for await (const delta of stream) {
        if (this.cancelled) {
          // Emit a cancellation error event so consumers (CLI, tests) can
          // observe the mid-stream interrupt (Task C.3.1).
          const cancelEvent = createBrainEvent('error', this.sessionId, {
            severity: 'cancelled',
            message: 'Run cancelled by user.',
            code: 'cancelled',
          });
          this.emit(cancelEvent);
          yield cancelEvent;
          break;
        }

        if (delta.kind === 'text') {
          turnText += delta.delta;
          const deltaEvent: BrainMessageDeltaEvent = createBrainEvent(
            'message_delta',
            this.sessionId,
            { messageId, delta: delta.delta, ...this.memberFields() },
          );
          this.emit(deltaEvent);
          yield deltaEvent;
        } else if (delta.kind === 'thinking') {
          const thinkEvent = createBrainEvent('thinking_delta', this.sessionId, {
            messageId,
            delta: delta.delta,
          });
          this.emit(thinkEvent);
          yield thinkEvent;
        } else if (delta.kind === 'tool_call') {
          toolCallsThisTurn++;
          // Record this tool call so the assistant message (appended after the
          // turn) carries the full tool_calls list the model emitted.
          turnToolCalls.push({ id: delta.toolCallId, name: delta.toolName, args: delta.args });
          const toolStartEvent = createBrainEvent('tool_execution_start', this.sessionId, {
            toolCallId: delta.toolCallId,
            toolName: delta.toolName,
            args: delta.args,
          });
          this.emit(toolStartEvent);
          yield toolStartEvent;

          // Queue for execution on `finish` (parallel-safe batches). Without a
          // registry we only emit start (legacy — no end events).
          const skipped = typeof maxToolCalls === 'number' && toolCallsThisTurn > maxToolCalls;
          if (!this.config.toolRegistry) {
            // no-op: start already yielded; no end (pre-v1.8.0 contract)
          } else if (skipped) {
            pendingNativeTools.push({
              toolCallId: delta.toolCallId,
              toolName: delta.toolName,
              args: delta.args,
              skipped: true,
            });
          } else {
            const callKey = hashToolCall(delta.toolName, delta.args);
            const cached = this.toolCallCache.get(callKey);
            if (cached !== undefined) {
              pendingNativeTools.push({
                toolCallId: delta.toolCallId,
                toolName: delta.toolName,
                args: delta.args,
                skipped: false,
                cached: `[duplicate call — result repeated; do not call this tool again with the same arguments]\n${cached}`,
              });
            } else {
              pendingNativeTools.push({
                toolCallId: delta.toolCallId,
                toolName: delta.toolName,
                args: delta.args,
                skipped: false,
              });
            }
          }
        } else if (delta.kind === 'finish') {
          // Capture the finish reason via the shared ref so the caller
          // can synthesize the matching `message_end`.
          finishRef.value = delta.reason;

          // v1.8.0: execute queued native tools (parallel read-only batches).
          if (pendingNativeTools.length > 0) {
            const executed = await this.executePendingTools(
              pendingNativeTools,
              maxToolCalls,
            );
            for (const item of executed) {
              this.emit(item.endEvent);
              yield item.endEvent;
              turnToolResults.push({
                toolCallId: item.toolCallId,
                content: item.content,
              });
              if (item.cacheKey && item.content && !item.isError) {
                this.toolCallCache.set(item.cacheKey, item.content);
              }
            }
            pendingNativeTools.length = 0;
          }
          // Fallback text-format tools: ---TOOLS--- JSON, MiniMax invoke XML,
          // and garbled invoke dumps. Run any text tools not already executed
          // natively this turn (so updateTask still runs after a native read).
          const textTools = parseTextToolCalls(turnText);
          const toolsToRun = textTools.filter((tt) => {
            const key = hashToolCall(tt.name, tt.args);
            return !turnToolCalls.some(
              (n) => hashToolCall(n.name, n.args) === key,
            );
          });
          if (
            (/---TOOLS---/.test(turnText) ||
              /minimax|invoke\s+name=/i.test(turnText)) &&
            textTools.length === 0
          ) {
            const parseErr = createBrainEvent('error', this.sessionId, {
              severity: 'recoverable',
              message:
                'Found text-format tool block but parse failed; tool calls were not executed. ' +
                'Prefer native tool_call, or ---TOOLS--- with ONE valid JSON array.',
              code: 'text_tools_parse_failed',
            });
            this.emit(parseErr);
            yield parseErr;
          }
          if (
            toolsToRun.length > 0 &&
            this.config.toolRegistry &&
            !this.cancelled &&
            this.textToolReentries < 4
          ) {
            let executedAny = false;
            for (let ti = 0; ti < toolsToRun.length; ti++) {
              const tt = toolsToRun[ti]!;
              if (typeof maxToolCalls === 'number' && toolCallsThisTurn + 1 > maxToolCalls) break;
              toolCallsThisTurn++;
              const toolCallId = `text-${crypto.randomUUID().slice(0, 8)}`;
              turnToolCalls.push({ id: toolCallId, name: tt.name, args: tt.args });
              const startEv = createBrainEvent('tool_execution_start', this.sessionId, {
                toolCallId,
                toolName: tt.name,
                args: tt.args,
              });
              this.emit(startEv);
              yield startEv;
              let resultStr = '';
              let isError = false;
              const startMs = Date.now();
              try {
                const normalizedArgs = normalizeTextToolArgs(tt.name, tt.args);
                const result = await this.config.toolRegistry.invoke<unknown>(
                  tt.name,
                  normalizedArgs,
                  {
                  cwd: this.config.cwd,
                  sessionId: this.sessionId,
                  signal: this.activeController?.signal,
                });
                if (result.ok) {
                  const val = result.value as { occurrencesReplaced?: number };
                  if (tt.name === 'edit_file' && (val.occurrencesReplaced ?? 0) === 0) {
                    resultStr =
                      'edit_file: oldString not found (0 replacements). read_file the target and retry with exact text.';
                    isError = true;
                  } else {
                    resultStr =
                      typeof result.value === 'string'
                        ? result.value
                        : typeof result.value === 'object' && result.value !== null
                          ? JSON.stringify(result.value, null, 2)
                          : String(result.value);
                  }
                } else {
                  resultStr = result.error;
                  isError = true;
                }
              } catch (err) {
                resultStr = err instanceof Error ? err.message : String(err);
                isError = true;
              }
              const endEv = createBrainEvent('tool_execution_end', this.sessionId, {
                toolCallId,
                result: resultStr,
                isError,
                durationMs: Date.now() - startMs,
              });
              this.emit(endEv);
              yield endEv;
              turnToolResults.push({ toolCallId, content: resultStr });
              executedAny = true;
            }
            if (executedAny) {
              this.textToolReentries += 1;
              finishRef.value = 'tool_calls';
            }
          }
          // === Truncated tool-call detection ===
          // If the provider sent finish_reason='tool_calls' but NO tool_call
          // was emitted (native or text-format), the stream was truncated mid-
          // args (common with MiniMax on long write_file content). Without
          // this guard the loop re-enters the provider, which re-emits the
          // same truncated call forever — the desktop freezes on "Running
          // write_file…" with no error, no completion ("muore e basta").
          // Treat it as a recoverable error and force finish='stop' so the
          // turn ends and the model gets a chance to recover on the next turn.
          if (
            finishRef.value === 'tool_calls' &&
            turnToolCalls.length === 0 &&
            turnToolResults.length === 0
          ) {
            const truncErr = createBrainEvent('error', this.sessionId, {
              severity: 'recoverable',
              message:
                'Tool call was truncated (finish_reason=tool_calls but no complete tool_call received). ' +
                'The provider cut the response mid-arguments. Retry with a shorter payload or split the work.',
              code: 'tool_call_truncated',
            });
            this.emit(truncErr);
            yield truncErr;
            // Force-exit the tool loop: pretend the turn finished normally so
            // the outer loop doesn't re-enter the provider for the same doomed
            // truncated call.
            finishRef.value = 'stop';
          }
          // Append the assistant turn (text + any tool_calls) to the transcript.
          // This MUST happen before the loop re-enters the provider (either via
          // queue drain or a follow-up tool-result turn) so the conversation
          // history stays valid: every role:'tool' message needs a preceding
          // assistant message that declared the matching tool_calls.
          if (turnToolCalls.length > 0 || turnText.length > 0) {
            this.config.messages.push({
              role: 'assistant',
              content: turnText,
              ...(turnToolCalls.length > 0 ? { toolCalls: turnToolCalls } : {}),
            });
          }
          // Flush buffered tool results AFTER the assistant tool_calls message
          // so the transcript order is assistant(tool_calls) → tool(results),
          // as the OpenAI schema requires. Strict providers (MiniMax/GLM) 400
          // otherwise; grok tolerated the reversed order.
          for (const tr of turnToolResults) {
            this.config.messages.push({
              role: 'tool',
              toolCallId: tr.toolCallId,
              content: tr.content,
            });
          }
          break;
        } else if (delta.kind === 'error') {
          const errEvent = createBrainEvent('error', this.sessionId, {
            severity: 'recoverable',
            message: delta.message,
          });
          this.emit(errEvent);
          yield errEvent;
        } else if (delta.kind === 'usage') {
          // Provider-reported token usage (Task G.4). The breakdown is
          // captured in the shared ref so the caller's `message_end`
          // synthesis can attach it. The delta itself does not become a
          // standalone BrainEvent (it would be noise in the chat stream);
          // consumers wanting real-time token counts hook the message_end
          // and read `event.usage`.
          usageRef.value = delta.usage;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errEvent = createBrainEvent('error', this.sessionId, {
        severity: 'recoverable',
        message: errorMessage,
      });
      this.emit(errEvent);
      yield errEvent;
    }
  }

  private emit(event: BrainEvent): void {
    if (this.eventBus) {
      try {
        this.eventBus.emit(event);
      } catch (err) {
        console.error('[AgentHarness] eventBus.emit failed:', err);
      }
    }
  }

  /**
   * Final-answer turn (v0.7.1 A2). Called when the tool-call loop hit its
   * iteration cap without the model producing a non-tool finish. Makes ONE
   * provider call with `tools` OMITTED and a synthetic system nudge appended,
   * so the run always ends with assistant text answering the user with what
   * has been gathered — instead of trailing off after the last tool box.
   *
   * Yields the full message lifecycle (start/deltas/end) so the UI renders
   * the closing answer like any other assistant turn. Errors are swallowed
   * into a recoverable error event (best-effort: the guarantee must never
   * turn a near-success into a hard failure).
   */
  private async *runFinalAnswerTurn(): AsyncIterable<BrainEvent> {
    const messageId = crypto.randomUUID();
    const msgStart: BrainMessageStartEvent = createBrainEvent('message_start', this.sessionId, {
      messageId,
      role: 'assistant',
      ...this.memberFields(),
    });
    this.emit(msgStart);
    yield msgStart;

    // Append a synthetic system nudge telling the model to answer now, and
    // run with NO tools so it cannot start another tool chain.
    this.config.messages.push({
      role: 'user',
      content:
        '[system] Hard tool-iteration ceiling reached. Stop calling tools and give a clear status: what is DONE, what remains, and the exact next steps. Use what you already gathered. Do not apologize for the tools.',
    });

    let totalLength = 0;
    const finishRef = { value: 'stop' };
    const usageRef = { value: null as UsageBreakdown | null };
    // Temporarily drop tools for this call by building a no-tools provider
    // invocation. We re-enter runSingleTurn but with an empty tools list via
    // a throwaway config override is not possible (config is readonly), so we
    // call the providerStream directly with tools: [].
    try {
      const stream = this.config.providerStream({
        messages: this.config.messages,
        model: this.config.model,
        provider: this.config.provider,
        tools: [],
        signal: this.activeController?.signal,
      });
      for await (const delta of stream) {
        if (this.cancelled) break;
        if (delta.kind === 'text') {
          totalLength += delta.delta.length;
          const deltaEvent: BrainMessageDeltaEvent = createBrainEvent(
            'message_delta',
            this.sessionId,
            { messageId, delta: delta.delta, ...this.memberFields() },
          );
          this.emit(deltaEvent);
          yield deltaEvent;
        } else if (delta.kind === 'usage') {
          usageRef.value = delta.usage;
        } else if (delta.kind === 'finish') {
          finishRef.value = delta.reason;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errEvent = createBrainEvent('error', this.sessionId, {
        severity: 'recoverable',
        message: `final-answer turn failed: ${errorMessage}`,
      });
      this.emit(errEvent);
      yield errEvent;
    }

    const msgEnd: BrainMessageEndEvent = createBrainEvent('message_end', this.sessionId, {
      messageId,
      totalLength: totalLength,
      finishReason: finishRef.value,
      ...this.memberFields(),
      ...(usageRef.value ? { usage: usageRef.value } : {}),
    });
    this.emit(msgEnd);
    yield msgEnd;
  }
}

/**
 * Stable hash key for a tool call (v0.7.1 A2). Canonicalizes args via a sorted
 * JSON.stringify so `{a:1,b:2}` and `{b:2,a:1}` collide (same logical call).
 * Exported for unit tests.
 */
export function hashToolCall(toolName: string, args: unknown): string {
  const canonical = stableStringify(args);
  return `${toolName}::${canonical}`;
}

/** Deterministic JSON stringify (object keys sorted ascending). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Parse a `---TOOLS---[json]---END---` block out of assistant text. This is the
 * fallback tool-call format documented in the agent system prompt
 * (promptModules.ts). Some models emit tool calls this way instead of native
 * tool_calls; without parsing, those calls are silently lost (the model
 * "describes" edits it never made). Returns [] when no valid block is present.
 * Exported for unit tests.
 */
/** Map common snake_case arg aliases for text-format tool calls. */
export function normalizeTextToolArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name !== 'edit_file') return args;
  const out = { ...args };
  if (out.oldString === undefined && typeof out.old_string === 'string') {
    out.oldString = out.old_string;
  }
  if (out.newString === undefined && typeof out.new_string === 'string') {
    out.newString = out.new_string;
  }
  if (out.replaceAll === undefined && typeof out.replace_all === 'boolean') {
    out.replaceAll = out.replace_all;
  }
  return out;
}

/**
 * Parse a `---TOOLS--- … ---END---` block. Models frequently mis-emit:
 *   - multiple JSON arrays back-to-back (`][{...}][{...}]`)
 *   - markdown fences around the JSON
 *   - lightly over-escaped quotes (`\"` inside an already-JSON string)
 * This parser tries several recovery strategies before giving up.
 */
export function parseTextToolCalls(
  text: string,
): { name: string; args: Record<string, unknown> }[] {
  // 1) Canonical ---TOOLS--- … ---END--- block
  const m = /---TOOLS---\s*([\s\S]*?)---END---/.exec(text);
  if (m?.[1]) {
    let body = m[1].trim();
    body = body
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const candidates: string[] = [body];
    if (/\]\s*\[/.test(body)) {
      candidates.push(body.replace(/\]\s*\[/g, ','));
    }
    if (body.includes('\\"')) {
      candidates.push(body.replace(/\\"/g, '"'));
      if (/\]\s*\[/.test(body)) {
        candidates.push(body.replace(/\\"/g, '"').replace(/\]\s*\[/g, ','));
      }
    }

    for (const cand of candidates) {
      const items = tryParseToolArray(cand);
      if (items.length > 0) return items;
    }

    const arrays = extractJsonArrays(body);
    if (arrays.length > 1) {
      const merged: { name: string; args: Record<string, unknown> }[] = [];
      for (const a of arrays) {
        merged.push(...tryParseToolArray(a));
      }
      if (merged.length > 0) return merged;
    }

    const objs = extractToolObjects(body);
    if (objs.length > 0) return objs;
  }

  // 2) MiniMax / XML-style invoke dumps (and garbled variants from some UIs)
  const mini = parseMinimaxStyleToolCalls(text);
  if (mini.length > 0) return mini;

  return [];
}

/**
 * Parse MiniMax-style and garbled invoke tool dumps, e.g.:
 *   <minimax:tool_call><invoke name="updateTask">...</invoke></minimax:tool_call>
 *   invoke name="updateTask" … taskId>foo status>done
 *   ]<]minimax[>[<invoke name="updateTask">  (display-mangled form)
 */
export function parseMinimaxStyleToolCalls(
  text: string,
): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];

  // Normalize common mangling: ]<]minimax[>[ → <minimax:  and ]< → <
  const normalized = text
    .replace(/\]\s*<\s*\]\s*minimax\s*\[\s*>\s*\[</gi, '<minimax:')
    .replace(/\]\s*<\s*\]\s*minimax\s*\[\s*>/gi, '<minimax:')
    .replace(/minimax\s*\[\s*>\s*\[</gi, 'minimax:')
    .replace(/\]\s*</g, '<');

  // Blocks: <minimax:tool_call>...</minimax:tool_call> or bare <invoke name="...">...</invoke>
  const blockRe =
    /<(?:minimax:)?tool_call[^>]*>([\s\S]*?)<\/(?:minimax:)?tool_call>|<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/invoke>|(?=<invoke\s+name=)|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(normalized)) !== null) {
    if (match[2]) {
      // <invoke name="X"> body
      out.push({ name: match[2], args: parseLooseArgs(match[3] ?? '') });
    } else if (match[1]) {
      const inner = match[1];
      const inv = /invoke\s+name=["']([^"']+)["']/i.exec(inner);
      if (inv) {
        out.push({ name: inv[1]!, args: parseLooseArgs(inner) });
      } else {
        // JSON body inside minimax block?
        const jsonish = tryParseToolArray(inner.trim()) ;
        if (jsonish.length) out.push(...jsonish);
        else {
          const objs = extractToolObjects(inner);
          if (objs.length) out.push(...objs);
        }
      }
    }
  }

  // Fallback: scan for invoke name="..." even without closing tags
  if (out.length === 0) {
    const loose = /invoke\s+name=["']([^"']+)["']([\s\S]*?)(?=invoke\s+name=|$)/gi;
    let lm: RegExpExecArray | null;
    while ((lm = loose.exec(normalized)) !== null) {
      const name = lm[1]!;
      const args = parseLooseArgs(lm[2] ?? '');
      if (name) out.push({ name, args });
    }
  }

  return out;
}

/** Extract key/value args from XML-ish or "key>value" / "key: value" fragments. */
function parseLooseArgs(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  // <parameter name="k">v</parameter> or <k>v</k>
  const paramTag =
    /(?:parameter\s+name=|<\s*)["']?([a-zA-Z_][\w]*)["']?\s*(?:>|=\s*["']?)([^<\]\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = paramTag.exec(body)) !== null) {
    const key = m[1]!;
    if (key === 'invoke' || key === 'minimax' || key === 'tool_call') continue;
    args[key] = m[2]!.replace(/^["']|["']$/g, '').trim();
  }
  // key>value or key: value lines
  const lineRe = /(?:^|[\s\[>])([a-zA-Z_][\w]*)\s*[>:=]\s*([^\n<\]]+)/g;
  while ((m = lineRe.exec(body)) !== null) {
    const key = m[1]!;
    if (args[key] !== undefined) continue;
    if (['invoke', 'name', 'minimax', 'tool_call', 'parameter'].includes(key)) continue;
    args[key] = m[2]!.replace(/^["']|["']$/g, '').trim();
  }
  // JSON object somewhere in body
  if (Object.keys(args).length === 0) {
    const brace = body.indexOf('{');
    if (brace >= 0) {
      try {
        const parsed = JSON.parse(body.slice(brace));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return args;
}

function tryParseToolArray(
  raw: string,
): { name: string; args: Record<string, unknown> }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    // Single object form: {"name":"x","args":{}}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsed = [parsed];
    } else {
      return [];
    }
  }
  return normalizeToolItems(parsed as unknown[]);
}

function normalizeToolItems(
  items: unknown[],
): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const item of items) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { name?: unknown }).name === 'string'
    ) {
      const rawArgs = (item as { args?: unknown }).args;
      out.push({
        name: (item as { name: string }).name,
        args:
          rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {},
      });
    }
  }
  return out;
}

/** Extract balanced top-level `[...]` substrings (best-effort, string-aware). */
function extractJsonArrays(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '[') {
      i++;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end > i) {
      out.push(text.slice(i, end + 1));
      i = end + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Regex-scan for individual tool call objects when full JSON parse fails. */
function extractToolObjects(
  text: string,
): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  // Match {"name":"tool", ... } with nested braces best-effort via extractJsonArrays
  // on each {...} region is hard; use a simpler name+args capture.
  const re =
    /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = match[1]!;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(match[2]!);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // leave empty args
    }
    out.push({ name, args });
  }
  return out;
}
