/**
 * TraceObserver — bounded in-memory trace of every runtime event it sees
 * (Frontier upgrade, PHASE 1 observer set).
 *
 * Best-effort: keeps a ring buffer (default 500 entries) and forwards each
 * entry to an optional sink (e.g. the future Run Flight Recorder writer).
 * Sink errors are swallowed — a tracing failure must never break a run
 * (§102: recorder failure does not block; authorization does).
 */
import { CONTINUE } from './types.js';
import type {
  AgentObserver,
  ModelAttemptEvent,
  ModelDeltaEvent,
  ModelResponseEvent,
  ObserverResult,
  RunCancelledEvent,
  RunEndEvent,
  RunStartEvent,
  RuntimeAgentRole,
  RuntimeEventBase,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
} from './types.js';

export interface TraceEntry {
  hook: string;
  eventId: string;
  ts: number;
  agentId: string;
  role: RuntimeAgentRole;
  turn: number;
}

export interface TraceObserverOptions {
  /** Best-effort forward of every recorded entry. */
  sink?: (entry: TraceEntry) => void;
  /** Ring buffer capacity (default 500). */
  capacity?: number;
}

const DEFAULT_CAPACITY = 500;

export class TraceObserver implements AgentObserver {
  private readonly entries: TraceEntry[] = [];
  private readonly sink?: (entry: TraceEntry) => void;
  private readonly capacity: number;

  constructor(options: TraceObserverOptions = {}) {
    this.sink = options.sink;
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
  }

  async onRunStart(event: RunStartEvent): Promise<ObserverResult> {
    return this.record('onRunStart', event);
  }

  async onModelAttempt(event: ModelAttemptEvent): Promise<ObserverResult> {
    return this.record('onModelAttempt', event);
  }

  async onModelDelta(event: ModelDeltaEvent): Promise<ObserverResult> {
    return this.record('onModelDelta', event);
  }

  async onModelResponse(event: ModelResponseEvent): Promise<ObserverResult> {
    return this.record('onModelResponse', event);
  }

  async onToolCall(event: ToolCallEvent): Promise<ObserverResult> {
    return this.record('onToolCall', event);
  }

  async onToolResult(event: ToolResultEvent): Promise<ObserverResult> {
    return this.record('onToolResult', event);
  }

  async onTurnEnd(event: TurnEndEvent): Promise<ObserverResult> {
    return this.record('onTurnEnd', event);
  }

  async onRunEnd(event: RunEndEvent): Promise<ObserverResult> {
    return this.record('onRunEnd', event);
  }

  async onCancelled(event: RunCancelledEvent): Promise<ObserverResult> {
    return this.record('onCancelled', event);
  }

  /** Recorded entries, oldest first. */
  getEntries(): TraceEntry[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }

  private record(hook: string, event: RuntimeEventBase): ObserverResult {
    const entry: TraceEntry = {
      hook,
      eventId: event.id,
      ts: event.ts,
      agentId: event.identity.agentId,
      role: event.identity.role,
      turn: event.turn,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    try {
      this.sink?.(entry);
    } catch {
      // Best-effort sink: swallow.
    }
    return CONTINUE;
  }
}
