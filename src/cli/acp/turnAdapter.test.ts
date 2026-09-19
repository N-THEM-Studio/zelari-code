/**
 * ACP turn adapter — the two runtime seams (stdout capture + stdin-ownership
 * marker), exercised with an INJECTED dispatcher that writes the same NDJSON
 * the real headless turn writes on stdout. No provider, no model, no network.
 */
import { describe, expect, it } from 'vitest';
import type { HeadlessOptions } from '../headless.js';
import {
  captureStdout,
  createHeadlessTurnDispatcher,
  type AcpTurnRequest,
  type AcpTurnResult,
} from './turnAdapter.js';
import type { SessionUpdate } from './protocol.js';

function request(overrides: Partial<AcpTurnRequest> = {}): AcpTurnRequest {
  return {
    sessionId: 's1',
    cwd: process.cwd(),
    prompt: 'do the thing',
    onUpdate: () => {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

const stream = async () => ({ provider: 'fake', model: 'fake-1', stream: {} });

/** Emulate emitEvent(): the turn streams NDJSON onto process.stdout. */
function emit(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

describe('acp/turnAdapter — captureStdout', () => {
  it('swallows writes while capturing and restores the original afterwards', () => {
    const original = process.stdout.write;
    const chunks: string[] = [];
    const restore = captureStdout((c) => chunks.push(c));
    process.stdout.write('a');
    process.stdout.write(Buffer.from('b', 'utf8'));
    restore();
    expect(chunks).toEqual(['a', 'b']);
    expect(process.stdout.write).toBe(original);
  });

  it('is a no-op passthrough for a throwing capture callback', () => {
    const original = process.stdout.write;
    const restore = captureStdout(() => {
      throw new Error('capture bug');
    });
    expect(() => process.stdout.write('x')).not.toThrow();
    restore();
    expect(process.stdout.write).toBe(original);
  });
});

describe('acp/turnAdapter — headless dispatcher', () => {
  it('projects the captured NDJSON stream into ordered updates', async () => {
    const updates: SessionUpdate[] = [];
    const dispatcher = createHeadlessTurnDispatcher({
      resolveStream: stream,
      dispatch: async () => {
        emit({ type: 'message_delta', delta: 'reading ' });
        emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read_file' });
        emit({ type: 'tool_execution_end', toolCallId: 'c1' });
        emit({ type: 'kraken_metrics', metrics: {} }); // not mapped
        process.stdout.write('plain trail'); // no newline: flushed at turn end
        return 0;
      },
    });
    const result = await dispatcher(request({ onUpdate: (u) => updates.push(u) }));
    expect(result).toEqual({ stopReason: 'end_turn', exitCode: 0 });
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reading ' } },
      { sessionUpdate: 'tool_call', callId: 'c1', title: 'read_file', kind: 'execute', status: 'pending' },
      { sessionUpdate: 'tool_call_update', callId: 'c1', status: 'completed' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'plain trail' } },
    ]);
  });

  it('runs the headless dispatch with json output in the session cwd', async () => {
    let seen: HeadlessOptions | undefined;
    const dispatcher = createHeadlessTurnDispatcher({
      resolveStream: stream,
      dispatch: async (opts) => {
        seen = opts;
        return 0;
      },
    });
    await dispatcher(request({ cwd: '/some/workspace', prompt: 'goal' }));
    expect(seen).toMatchObject({
      task: 'goal',
      output: 'json',
      mode: 'kraken',
      phase: 'build',
      useCouncil: false,
      cwd: '/some/workspace',
    });
  });

  it('marks the host as stdin owner for the turn and restores the prior value', async () => {
    const prior = process.env['ZELARI_SERVE_HARNESS'];
    const original = process.stdout.write;
    const seen: Array<string | undefined> = [];
    const dispatcher = createHeadlessTurnDispatcher({
      resolveStream: stream,
      dispatch: async () => {
        seen.push(process.env['ZELARI_SERVE_HARNESS']);
        return 0;
      },
    });
    await dispatcher(request());
    expect(seen).toEqual(['1']);
    expect(process.env['ZELARI_SERVE_HARNESS']).toBe(prior);
    expect(process.stdout.write).toBe(original); // capture window closed
  });

  it('restores stdout even when the turn throws, and reports the failure as text', async () => {
    const original = process.stdout.write;
    const updates: SessionUpdate[] = [];
    const dispatcher = createHeadlessTurnDispatcher({
      resolveStream: stream,
      dispatch: async () => {
        throw new Error('kaboom');
      },
    });
    const result = await dispatcher(request({ onUpdate: (u) => updates.push(u) }));
    expect(process.stdout.write).toBe(original);
    expect(result).toEqual({ stopReason: 'refusal', exitCode: 2 });
    expect(updates).toHaveLength(1);
    expect(String((updates[0] as { content: { text: string } }).content.text)).toContain('kaboom');
  });

  it('maps a non-zero exit to refusal (strict gates / runtime errors included)', async () => {
    const dispatcher = createHeadlessTurnDispatcher({
      resolveStream: stream,
      dispatch: async () => 6, // STRICT_DONE gate exit code
    });
    await expect(dispatcher(request())).resolves.toEqual({ stopReason: 'refusal', exitCode: 6 });
  });

  it('short-circuits an already-cancelled request without dispatching', async () => {
    let called = 0;
    const controller = new AbortController();
    controller.abort();
    const dispatcher = createHeadlessTurnDispatcher({
      resolveStream: stream,
      dispatch: async () => {
        called += 1;
        return 0;
      },
    });
    await expect(dispatcher(request({ signal: controller.signal }))).resolves.toEqual({
      stopReason: 'cancelled',
      exitCode: 0,
    });
    expect(called).toBe(0);
  });

  it('serializes turns (the stdout capture is process-global): never two at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatcher = createHeadlessTurnDispatcher({
      resolveStream: stream,
      dispatch: async (): Promise<number> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return 0;
      },
    });
    await Promise.all([dispatcher(request()), dispatcher(request()), dispatcher(request())]);
    expect(maxInFlight).toBe(1);
  });

  it('resolves the provider/stream lazily, once, and retries after a failure', async () => {
    let resolved = 0;
    let attempts = 0;
    const dispatcher = createHeadlessTurnDispatcher({
      resolveStream: async () => {
        resolved += 1;
        return { provider: 'p', model: 'm', stream: {} };
      },
      dispatch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('no key yet');
        return 0;
      },
    });
    await dispatcher(request());
    await dispatcher(request());
    expect(resolved).toBe(1); // memoized across turns
    expect(attempts).toBe(2);
  });

  it('a failing provider resolution surfaces as a rejected turn (server maps it)', async () => {
    const dispatcher = createHeadlessTurnDispatcher({
      resolveStream: async () => {
        throw new Error('missing API key');
      },
      dispatch: async (): Promise<number> => 0,
    });
    await expect(dispatcher(request())).rejects.toThrow('missing API key');
  });
});
