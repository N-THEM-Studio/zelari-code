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

import { EventBus } from '../../shared/eventBus.js';
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
} from '../../shared/events.js';
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
  private cancelled = false;
  private activeController: AbortController | null = null;
  private queue: string[] = [];

  constructor(config: AgentHarnessConfig) {
    this.config = config;
    this.eventBus = config.eventBus;
    this.sessionId = config.sessionId ?? crypto.randomUUID();
    this.maxQueuedIterations = config.maxQueuedIterations ?? 3;
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

    // Emit agent_start
    const startEvent: BrainAgentStartEvent = createBrainEvent('agent_start', this.sessionId, {
      model: this.config.model,
      provider: this.config.provider,
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
      { messageId: initialMessageId, role: 'assistant' },
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
      ...(initialUsageRef.value ? { usage: initialUsageRef.value } : {}),
    });
    this.emit(initialMsgEnd);
    yield initialMsgEnd;

    // === Agentic tool-call loop ===
    // When the model's finish reason is 'tool_calls', the turn produced tool
    // invocations whose results are now in the transcript (appended by
    // runSingleTurn). Re-enter the provider so the model can consume those
    // results and continue — this is the core agent loop (reason → act →
    // observe → reason). Bounded by MAX_TOOL_LOOP_ITERATIONS to prevent runaway.
    const MAX_TOOL_LOOP_ITERATIONS = 12;
    let toolLoopTurns = 0;
    while (
      !this.cancelled &&
      !hadError &&
      toolLoopTurns < MAX_TOOL_LOOP_ITERATIONS &&
      initialFinishRef.value === 'tool_calls'
    ) {
      toolLoopTurns++;

      const turnMessageId = crypto.randomUUID();
      const msgStart: BrainMessageStartEvent = createBrainEvent(
        'message_start',
        this.sessionId,
        { messageId: turnMessageId, role: 'assistant' },
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
        ...(turnUsageRef.value ? { usage: turnUsageRef.value } : {}),
      });
      this.emit(msgEnd);
      yield msgEnd;

      // Drive the loop: keep going only if this turn again requested tool calls.
      initialFinishRef.value = turnFinishRef.value;
      if (hadError || this.cancelled) break;
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
            { messageId, delta: delta.delta },
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

          // Skip registry execution if we've exceeded the per-turn limit
          // (Task G.2, carryover from v3-C C.1.5). Emit a synthetic
          // `tool_execution_end` so the UI can still render the attempt
          // and downstream consumers (e.g. the LLM context) see a clean
          // closure. Without this guard, a council member could fire 50
          // read_file calls in one turn and blow the message context.
          const skipped = typeof maxToolCalls === 'number' && toolCallsThisTurn > maxToolCalls;

          if (this.config.toolRegistry && !skipped) {
            const startMs = Date.now();
            const result = await this.config.toolRegistry.invoke<unknown>(
              delta.toolName,
              delta.args,
              {
                cwd: this.config.cwd,
                sessionId: this.sessionId,
                signal: this.activeController?.signal,
              },
            );
            const resultStr = result.ok ? String(result.value) : result.error;
            const endEvent: BrainToolExecutionEndEvent = createBrainEvent(
              'tool_execution_end',
              this.sessionId,
              {
                toolCallId: delta.toolCallId,
                result: resultStr,
                isError: !result.ok,
                durationMs: Date.now() - startMs,
              },
            );
            this.emit(endEvent);
            yield endEvent;
            // Append the tool result to the transcript so the next provider
            // turn can see what the tool returned (OpenAI role:'tool' message).
            this.config.messages.push({
              role: 'tool',
              toolCallId: delta.toolCallId,
              content: resultStr,
            });
          } else if (skipped) {
            // Synthetic end event — no registry call, just close out the
            // tool_execution_start with an explicit skip reason. The LLM
            // can see in the next provider turn that this tool didn't run.
            const endEvent: BrainToolExecutionEndEvent = createBrainEvent(
              'tool_execution_end',
              this.sessionId,
              {
                toolCallId: delta.toolCallId,
                result: `[skipped] maxToolCallsPerTurn reached (limit=${maxToolCalls})`,
                isError: true,
                durationMs: 0,
              },
            );
            this.emit(endEvent);
            yield endEvent;
            this.config.messages.push({
              role: 'tool',
              toolCallId: delta.toolCallId,
              content: `[skipped] maxToolCallsPerTurn reached (limit=${maxToolCalls})`,
            });
          }
        } else if (delta.kind === 'finish') {
          // Capture the finish reason via the shared ref so the caller
          // can synthesize the matching `message_end`.
          finishRef.value = delta.reason;
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
}
