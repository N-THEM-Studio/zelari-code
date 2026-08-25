/**
 * TraceObserver + MetricsObserver unit tests.
 */
import { describe, expect, it } from 'vitest';
import { TraceObserver } from './TraceObserver.js';
import type { TraceEntry } from './TraceObserver.js';
import { MetricsObserver } from './MetricsObserver.js';
import type {
  RunStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from './types.js';

let seq = 0;

function identity() {
  return {
    runId: 'run-1',
    agentId: 'agent-lead',
    role: 'lead' as const,
    mode: 'kraken' as const,
  };
}

function runStart(): RunStartEvent {
  return { id: `e-${++seq}`, ts: 100, identity: identity(), turn: 0 };
}

function toolCall(): ToolCallEvent {
  return {
    id: `e-${++seq}`,
    ts: 200,
    identity: identity(),
    turn: 1,
    toolCallId: `tc-${seq}`,
    toolName: 'bash',
    args: { command: 'npm test' },
  };
}

function toolResult(ok: boolean): ToolResultEvent {
  return {
    id: `e-${++seq}`,
    ts: 300,
    identity: identity(),
    turn: 1,
    toolCallId: `tc-${seq}`,
    toolName: 'bash',
    result: '…',
    ok,
  };
}

describe('TraceObserver', () => {
  it('records every observed hook with identity and turn', async () => {
    const trace = new TraceObserver();

    await trace.onRunStart(runStart());
    await trace.onToolCall(toolCall());
    await trace.onToolResult(toolResult(false));

    const entries = trace.getEntries();
    expect(entries.map((entry) => entry.hook)).toEqual([
      'onRunStart',
      'onToolCall',
      'onToolResult',
    ]);
    expect(entries[0]).toMatchObject({
      eventId: 'e-1',
      agentId: 'agent-lead',
      role: 'lead',
      turn: 0,
    });
    expect(trace.size).toBe(3);
  });

  it('trims the ring buffer to capacity', async () => {
    const trace = new TraceObserver({ capacity: 2 });

    const first = runStart();
    const second = runStart();
    const third = runStart();
    await trace.onRunStart(first);
    await trace.onRunStart(second);
    await trace.onRunStart(third);

    expect(trace.size).toBe(2);
    expect(trace.getEntries().map((entry) => entry.eventId)).toEqual([
      second.id,
      third.id,
    ]);
  });

  it('forwards entries to the sink and swallows sink errors', async () => {
    const received: TraceEntry[] = [];
    const trace = new TraceObserver({ sink: (entry) => received.push(entry) });
    await trace.onRunStart(runStart());
    expect(received).toHaveLength(1);
    expect(received[0]?.hook).toBe('onRunStart');

    const broken = new TraceObserver({
      sink: () => {
        throw new Error('sink down');
      },
    });
    await expect(broken.onRunStart(runStart())).resolves.toEqual({
      action: 'continue',
    });
    expect(broken.size).toBe(1);
  });

  it('clear empties the buffer', async () => {
    const trace = new TraceObserver();
    await trace.onRunStart(runStart());
    trace.clear();
    expect(trace.size).toBe(0);
  });
});

describe('MetricsObserver', () => {
  it('counts calls, failures and event timestamps', async () => {
    const metrics = new MetricsObserver();

    await metrics.onRunStart(runStart());
    await metrics.onToolCall(toolCall());
    await metrics.onToolResult(toolResult(true));
    await metrics.onToolCall(toolCall());
    await metrics.onToolResult(toolResult(false));

    expect(metrics.snapshot()).toMatchObject({
      runsStarted: 1,
      toolCalls: 2,
      toolResults: 2,
      toolFailures: 1,
      firstEventTs: 100,
      lastEventTs: 300,
    });
  });

  it('reset zeroes everything', async () => {
    const metrics = new MetricsObserver();
    await metrics.onRunStart(runStart());
    metrics.reset();
    expect(metrics.snapshot()).toMatchObject({
      runsStarted: 0,
      firstEventTs: undefined,
      lastEventTs: undefined,
    });
  });
});
