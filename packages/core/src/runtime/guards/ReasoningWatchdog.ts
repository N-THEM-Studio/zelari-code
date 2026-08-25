/**
 * ReasoningWatchdog — provider latency telemetry (Frontier upgrade, PHASE 1B §17).
 *
 * Tracks time-to-first-token, generation duration and stream idle gaps per
 * model attempt, and records `provider_idle` warnings when thresholds are
 * exceeded. It NEVER interrupts the provider on its own: observers here are
 * telemetry-only (§17 — do not auto-abort providers that support long
 * reasoning). Warnings and metrics are exposed via accessors for the CLI /
 * future Run Flight Recorder.
 *
 * Env thresholds (config overrides win):
 *   ZELARI_MODEL_FIRST_TOKEN_WARN_MS  (default 60000)
 *   ZELARI_MODEL_STREAM_IDLE_WARN_MS  (default 30000)
 */
import { CONTINUE } from '../observers/types.js';
import type {
  AgentObserver,
  ModelAttemptEvent,
  ModelDeltaEvent,
  ModelResponseEvent,
  ObserverResult,
  RunCancelledEvent,
  RunEndEvent,
} from '../observers/types.js';

export interface ReasoningWatchdogConfig {
  /** Warn when the first token takes longer than this (ms). */
  firstTokenWarnMs?: number;
  /** Warn when the gap between two stream deltas exceeds this (ms). */
  streamIdleWarnMs?: number;
}

export interface ProviderAttemptMetrics {
  attemptId: string;
  startedAt: number;
  firstTokenAt?: number;
  endedAt?: number;
  timeToFirstTokenMs?: number;
  generationDurationMs?: number;
  maxStreamIdleMs?: number;
  deltas: number;
}

export interface ProviderIdleWarning {
  code: 'provider_idle';
  metric: 'time_to_first_token' | 'stream_idle';
  attemptId: string;
  valueMs: number;
  thresholdMs: number;
  message: string;
  ts: number;
}

const DEFAULT_FIRST_TOKEN_WARN_MS = 60_000;
const DEFAULT_STREAM_IDLE_WARN_MS = 30_000;
const MAX_COMPLETED = 100;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface AttemptState extends ProviderAttemptMetrics {
  warnedFirstToken: boolean;
  warnedIdle: boolean;
}

export class ReasoningWatchdog implements AgentObserver {
  private readonly firstTokenWarnMs: number;
  private readonly streamIdleWarnMs: number;
  private readonly now: () => number;

  private current: AttemptState | null = null;
  private lastDeltaAt: number | undefined;
  private readonly completed: ProviderAttemptMetrics[] = [];
  private readonly warnings: ProviderIdleWarning[] = [];

  constructor(config: ReasoningWatchdogConfig = {}, now: () => number = Date.now) {
    this.firstTokenWarnMs =
      config.firstTokenWarnMs ??
      envPositiveInt('ZELARI_MODEL_FIRST_TOKEN_WARN_MS', DEFAULT_FIRST_TOKEN_WARN_MS);
    this.streamIdleWarnMs =
      config.streamIdleWarnMs ??
      envPositiveInt('ZELARI_MODEL_STREAM_IDLE_WARN_MS', DEFAULT_STREAM_IDLE_WARN_MS);
    this.now = now;
  }

  async onModelAttempt(event: ModelAttemptEvent): Promise<ObserverResult> {
    this.finalizeCurrent();
    this.current = {
      attemptId: event.id,
      startedAt: this.now(),
      deltas: 0,
      warnedFirstToken: false,
      warnedIdle: false,
    };
    this.lastDeltaAt = undefined;
    return CONTINUE;
  }

  async onModelDelta(event: ModelDeltaEvent): Promise<ObserverResult> {
    const attempt = this.current;
    if (!attempt) return CONTINUE;

    const at = this.now();
    attempt.deltas += 1;

    if (attempt.firstTokenAt === undefined) {
      attempt.firstTokenAt = at;
      const ttft = at - attempt.startedAt;
      attempt.timeToFirstTokenMs = ttft;
      if (!attempt.warnedFirstToken && ttft > this.firstTokenWarnMs) {
        attempt.warnedFirstToken = true;
        this.warn('time_to_first_token', attempt, ttft, this.firstTokenWarnMs);
      }
    } else {
      const gap = at - (this.lastDeltaAt ?? attempt.firstTokenAt);
      if (gap > (attempt.maxStreamIdleMs ?? 0)) attempt.maxStreamIdleMs = gap;
      if (!attempt.warnedIdle && gap > this.streamIdleWarnMs) {
        attempt.warnedIdle = true;
        this.warn('stream_idle', attempt, gap, this.streamIdleWarnMs);
      }
    }

    this.lastDeltaAt = at;
    return CONTINUE;
  }

  async onModelResponse(_event: ModelResponseEvent): Promise<ObserverResult> {
    this.finalizeCurrent();
    return CONTINUE;
  }

  async onRunEnd(_event: RunEndEvent): Promise<ObserverResult> {
    this.finalizeCurrent();
    return CONTINUE;
  }

  async onCancelled(_event: RunCancelledEvent): Promise<ObserverResult> {
    this.finalizeCurrent();
    return CONTINUE;
  }

  /** Completed attempt metrics, oldest first (bounded). */
  getAttemptMetrics(): ProviderAttemptMetrics[] {
    return this.completed.map((attempt) => ({ ...attempt }));
  }

  getWarnings(): ProviderIdleWarning[] {
    return this.warnings.map((warning) => ({ ...warning }));
  }

  reset(): void {
    this.current = null;
    this.lastDeltaAt = undefined;
    this.completed.length = 0;
    this.warnings.length = 0;
  }

  private finalizeCurrent(): void {
    const attempt = this.current;
    if (!attempt) return;
    attempt.endedAt = this.now();
    if (attempt.firstTokenAt !== undefined) {
      attempt.generationDurationMs = attempt.endedAt - attempt.startedAt;
    }
    this.completed.push({ ...attempt });
    if (this.completed.length > MAX_COMPLETED) this.completed.shift();
    this.current = null;
    this.lastDeltaAt = undefined;
  }

  private warn(
    metric: 'time_to_first_token' | 'stream_idle',
    attempt: AttemptState,
    valueMs: number,
    thresholdMs: number,
  ): void {
    this.warnings.push({
      code: 'provider_idle',
      metric,
      attemptId: attempt.attemptId,
      valueMs,
      thresholdMs,
      message:
        metric === 'time_to_first_token'
          ? `Provider first token took ${valueMs}ms (threshold ${thresholdMs}ms).`
          : `Provider stream idle for ${valueMs}ms between deltas (threshold ${thresholdMs}ms).`,
      ts: this.now(),
    });
  }
}
