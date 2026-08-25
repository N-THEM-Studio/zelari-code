/**
 * ReasoningWatchdog unit tests — injected clock, no real waiting.
 */
import { describe, expect, it } from 'vitest';
import { ReasoningWatchdog } from './ReasoningWatchdog.js';
import type {
  ModelAttemptEvent,
  ModelDeltaEvent,
  ModelResponseEvent,
  RunEndEvent,
} from '../observers/types.js';

let clockMs = 0;
const clock = () => clockMs;
let seq = 0;

function attemptEvent(): ModelAttemptEvent {
  return {
    id: `att-${++seq}`,
    ts: clockMs,
    identity: {
      runId: 'run-1',
      agentId: 'agent-1',
      role: 'lead',
      mode: 'kraken',
    },
    turn: 1,
  };
}

function deltaEvent(attemptId: string): ModelDeltaEvent {
  return {
    id: `delta-${++seq}`,
    ts: clockMs,
    identity: {
      runId: 'run-1',
      agentId: 'agent-1',
      role: 'lead',
      mode: 'kraken',
    },
    turn: 1,
    delta: 'x',
  };
}

function responseEvent(): ModelResponseEvent {
  return {
    id: `resp-${++seq}`,
    ts: clockMs,
    identity: {
      runId: 'run-1',
      agentId: 'agent-1',
      role: 'lead',
      mode: 'kraken',
    },
    turn: 1,
  };
}

function runEndEvent(): RunEndEvent {
  return {
    id: `end-${++seq}`,
    ts: clockMs,
    identity: {
      runId: 'run-1',
      agentId: 'agent-1',
      role: 'lead',
      mode: 'kraken',
    },
    turn: 1,
    reason: 'completed',
  };
}

describe('ReasoningWatchdog', () => {
  it('records ttft, idle and duration without warnings when fast', async () => {
    clockMs = 0;
    const watchdog = new ReasoningWatchdog(
      { firstTokenWarnMs: 5_000, streamIdleWarnMs: 2_000 },
      clock,
    );

    await watchdog.onModelAttempt(attemptEvent());
    clockMs = 100;
    await watchdog.onModelDelta(deltaEvent('att'));
    clockMs = 300;
    await watchdog.onModelDelta(deltaEvent('att'));
    clockMs = 500;
    await watchdog.onModelResponse(responseEvent());

    expect(watchdog.getWarnings()).toEqual([]);
    const [metrics] = watchdog.getAttemptMetrics();
    expect(metrics?.timeToFirstTokenMs).toBe(100);
    expect(metrics?.maxStreamIdleMs).toBe(200);
    expect(metrics?.generationDurationMs).toBe(500);
    expect(metrics?.deltas).toBe(2);
  });

  it('warns once on slow first token and never intervenes', async () => {
    clockMs = 0;
    const watchdog = new ReasoningWatchdog(
      { firstTokenWarnMs: 1_000, streamIdleWarnMs: 60_000 },
      clock,
    );

    await watchdog.onModelAttempt(attemptEvent());
    clockMs = 5_000;
    const result = await watchdog.onModelDelta(deltaEvent('att'));

    expect(result).toEqual({ action: 'continue' });
    const warnings = watchdog.getWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'provider_idle',
      metric: 'time_to_first_token',
      valueMs: 5_000,
      thresholdMs: 1_000,
    });

    // Second slow-token attempt for the SAME attempt does not warn again
    // (once per attempt per metric).
    clockMs = 5_100;
    await watchdog.onModelDelta(deltaEvent('att'));
    expect(watchdog.getWarnings()).toHaveLength(1);
  });

  it('warns on stream idle gap between deltas', async () => {
    clockMs = 0;
    const watchdog = new ReasoningWatchdog(
      { firstTokenWarnMs: 60_000, streamIdleWarnMs: 1_000 },
      clock,
    );

    await watchdog.onModelAttempt(attemptEvent());
    clockMs = 10;
    await watchdog.onModelDelta(deltaEvent('att'));
    clockMs = 2_500;
    await watchdog.onModelDelta(deltaEvent('att'));

    const warnings = watchdog.getWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      metric: 'stream_idle',
      valueMs: 2_490,
    });

    // Metrics surface only after the attempt is finalized.
    clockMs = 2_600;
    await watchdog.onModelResponse(responseEvent());
    expect(watchdog.getAttemptMetrics()[0]?.maxStreamIdleMs).toBe(2_490);
  });

  it('handles a non-streaming response (no deltas) with duration only', async () => {
    clockMs = 0;
    const watchdog = new ReasoningWatchdog({}, clock);

    await watchdog.onModelAttempt(attemptEvent());
    clockMs = 3_000;
    await watchdog.onModelResponse(responseEvent());

    const [metrics] = watchdog.getAttemptMetrics();
    expect(metrics?.deltas).toBe(0);
    expect(metrics?.timeToFirstTokenMs).toBeUndefined();
    expect(metrics?.generationDurationMs).toBeUndefined(); // no tokens → no duration
  });

  it('finalizes an open attempt on run end', async () => {
    clockMs = 0;
    const watchdog = new ReasoningWatchdog({}, clock);

    await watchdog.onModelAttempt(attemptEvent());
    clockMs = 10;
    await watchdog.onModelDelta(deltaEvent('att'));
    clockMs = 20;
    await watchdog.onRunEnd(runEndEvent());

    expect(watchdog.getAttemptMetrics()).toHaveLength(1);
    expect(watchdog.getAttemptMetrics()[0]?.generationDurationMs).toBe(20);
  });

  it('starts a fresh attempt when a previous one never responded', async () => {
    clockMs = 0;
    const watchdog = new ReasoningWatchdog({}, clock);

    await watchdog.onModelAttempt(attemptEvent());
    clockMs = 10;
    await watchdog.onModelAttempt(attemptEvent());

    expect(watchdog.getAttemptMetrics()).toHaveLength(1); // first finalized
    await watchdog.onModelResponse(responseEvent());
    expect(watchdog.getAttemptMetrics()).toHaveLength(2);
  });

  it('reset clears state', async () => {
    clockMs = 0;
    const watchdog = new ReasoningWatchdog(
      { firstTokenWarnMs: 1, streamIdleWarnMs: 1 },
      clock,
    );

    await watchdog.onModelAttempt(attemptEvent());
    clockMs = 50;
    await watchdog.onModelDelta(deltaEvent('att'));
    expect(watchdog.getWarnings()).toHaveLength(1);

    watchdog.reset();
    expect(watchdog.getWarnings()).toEqual([]);
    expect(watchdog.getAttemptMetrics()).toEqual([]);
  });
});
