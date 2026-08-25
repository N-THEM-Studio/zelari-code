/**
 * MetricsObserver — aggregate runtime counters (Frontier upgrade, PHASE 1
 * observer set).
 *
 * Purely observational: counts loop activity (model attempts/deltas/responses,
 * tool calls/results/failures, turns, run endings, cancellations) and tracks
 * first/last event timestamps. Never returns an intervention. Failure mode
 * should be `ignore` (§7.1: MetricsObserver → ignore).
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
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
} from './types.js';

export interface RuntimeMetricsSnapshot {
  runsStarted: number;
  modelAttempts: number;
  modelDeltas: number;
  modelResponses: number;
  toolCalls: number;
  toolResults: number;
  toolFailures: number;
  turnsEnded: number;
  runsEnded: number;
  cancelled: number;
  firstEventTs?: number;
  lastEventTs?: number;
}

export class MetricsObserver implements AgentObserver {
  private runsStarted = 0;
  private modelAttempts = 0;
  private modelDeltas = 0;
  private modelResponses = 0;
  private toolCalls = 0;
  private toolResults = 0;
  private toolFailures = 0;
  private turnsEnded = 0;
  private runsEnded = 0;
  private cancelled = 0;
  private firstEventTs: number | undefined;
  private lastEventTs: number | undefined;

  async onRunStart(event: RunStartEvent): Promise<ObserverResult> {
    this.tick(event.ts);
    this.runsStarted += 1;
    return CONTINUE;
  }

  async onModelAttempt(event: ModelAttemptEvent): Promise<ObserverResult> {
    this.tick(event.ts);
    this.modelAttempts += 1;
    return CONTINUE;
  }

  async onModelDelta(event: ModelDeltaEvent): Promise<ObserverResult> {
    this.tick(event.ts);
    this.modelDeltas += 1;
    return CONTINUE;
  }

  async onModelResponse(event: ModelResponseEvent): Promise<ObserverResult> {
    this.tick(event.ts);
    this.modelResponses += 1;
    return CONTINUE;
  }

  async onToolCall(event: ToolCallEvent): Promise<ObserverResult> {
    this.tick(event.ts);
    this.toolCalls += 1;
    return CONTINUE;
  }

  async onToolResult(event: ToolResultEvent): Promise<ObserverResult> {
    this.tick(event.ts);
    this.toolResults += 1;
    if (!event.ok) this.toolFailures += 1;
    return CONTINUE;
  }

  async onTurnEnd(event: TurnEndEvent): Promise<ObserverResult> {
    this.tick(event.ts);
    this.turnsEnded += 1;
    return CONTINUE;
  }

  async onRunEnd(event: RunEndEvent): Promise<ObserverResult> {
    this.tick(event.ts);
    this.runsEnded += 1;
    return CONTINUE;
  }

  async onCancelled(event: RunCancelledEvent): Promise<ObserverResult> {
    this.tick(event.ts);
    this.cancelled += 1;
    return CONTINUE;
  }

  snapshot(): RuntimeMetricsSnapshot {
    return {
      runsStarted: this.runsStarted,
      modelAttempts: this.modelAttempts,
      modelDeltas: this.modelDeltas,
      modelResponses: this.modelResponses,
      toolCalls: this.toolCalls,
      toolResults: this.toolResults,
      toolFailures: this.toolFailures,
      turnsEnded: this.turnsEnded,
      runsEnded: this.runsEnded,
      cancelled: this.cancelled,
      firstEventTs: this.firstEventTs,
      lastEventTs: this.lastEventTs,
    };
  }

  reset(): void {
    this.runsStarted = 0;
    this.modelAttempts = 0;
    this.modelDeltas = 0;
    this.modelResponses = 0;
    this.toolCalls = 0;
    this.toolResults = 0;
    this.toolFailures = 0;
    this.turnsEnded = 0;
    this.runsEnded = 0;
    this.cancelled = 0;
    this.firstEventTs = undefined;
    this.lastEventTs = undefined;
  }

  private tick(ts: number): void {
    if (this.firstEventTs === undefined || ts < this.firstEventTs) {
      this.firstEventTs = ts;
    }
    if (this.lastEventTs === undefined || ts > this.lastEventTs) {
      this.lastEventTs = ts;
    }
  }
}
