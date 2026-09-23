/**
 * Unit tests — tool heartbeat (A3: anti-stall for long-running tool calls).
 *
 * Uses a fake clock (injectable now/setTimeout) so no real timers fire.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createToolHeartbeat,
  formatToolElapsed,
  resolveToolHeartbeatMs,
  toolHeartbeatCaption,
  TOOL_HEARTBEAT_DEFAULT_MS,
} from './toolHeartbeat.js';

// ---------------------------------------------------------------------------
// resolveToolHeartbeatMs
// ---------------------------------------------------------------------------

describe('resolveToolHeartbeatMs', () => {
  it('returns default when env is unset', () => {
    expect(resolveToolHeartbeatMs({})).toBe(TOOL_HEARTBEAT_DEFAULT_MS);
  });

  it('returns 0 for "0"', () => {
    expect(resolveToolHeartbeatMs({ ZELARI_TOOL_HEARTBEAT_MS: '0' })).toBe(0);
  });

  it('returns 0 for "off"', () => {
    expect(resolveToolHeartbeatMs({ ZELARI_TOOL_HEARTBEAT_MS: 'off' })).toBe(0);
  });

  it('parses a valid positive integer', () => {
    expect(resolveToolHeartbeatMs({ ZELARI_TOOL_HEARTBEAT_MS: '5000' })).toBe(5000);
  });

  it('falls back to default for non-numeric', () => {
    expect(resolveToolHeartbeatMs({ ZELARI_TOOL_HEARTBEAT_MS: 'abc' })).toBe(
      TOOL_HEARTBEAT_DEFAULT_MS,
    );
  });

  it('trims whitespace', () => {
    expect(resolveToolHeartbeatMs({ ZELARI_TOOL_HEARTBEAT_MS: '  10000  ' })).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// formatToolElapsed
// ---------------------------------------------------------------------------

describe('formatToolElapsed', () => {
  it('formats seconds only', () => {
    expect(formatToolElapsed(12_000)).toBe('12s');
  });

  it('formats minutes and seconds', () => {
    expect(formatToolElapsed(90_000)).toBe('1m 30s');
  });

  it('handles zero', () => {
    expect(formatToolElapsed(0)).toBe('0s');
  });

  it('floors sub-second', () => {
    expect(formatToolElapsed(1500)).toBe('1s');
  });
});

// ---------------------------------------------------------------------------
// toolHeartbeatCaption
// ---------------------------------------------------------------------------

describe('toolHeartbeatCaption', () => {
  it('produces a readable caption', () => {
    expect(toolHeartbeatCaption('bash', 45_000)).toBe('bash running · 45s');
  });
});

// ---------------------------------------------------------------------------
// createToolHeartbeat
// ---------------------------------------------------------------------------

describe('createToolHeartbeat', () => {
  function fakeClock() {
    let t = 1000;
    const pending = new Map<number, { cb: () => void; at: number }>();
    let nextId = 1;
    const now = () => t;
    const advance = (ms: number) => {
      t += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= t) {
          pending.delete(id);
          entry.cb();
        }
      }
    };
    const setTimeout = ((cb: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { cb, at: t + ms });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;
    const clearTimeout = ((id: unknown) => {
      pending.delete(id as number);
    }) as unknown as typeof globalThis.clearTimeout;
    return { now, setTimeout, clearTimeout, advance };
  }

  it('fires once when threshold is exceeded', () => {
    const clock = fakeClock();
    const beats: Array<{ id: string; name: string; ms: number }> = [];
    const hb = createToolHeartbeat(
      (id, name, ms) => beats.push({ id, name, ms }),
      { thresholdMs: 5000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    );

    const stop = hb.start('call-1', 'bash');
    clock.advance(6000);
    expect(beats).toHaveLength(1);
    expect(beats[0]!.id).toBe('call-1');
    expect(beats[0]!.name).toBe('bash');
    expect(beats[0]!.ms).toBe(6000);
    stop();
  });

  it('does not fire when stopped before threshold', () => {
    const clock = fakeClock();
    const beats: unknown[] = [];
    const hb = createToolHeartbeat(
      (...args) => beats.push(args),
      { thresholdMs: 5000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    );

    const stop = hb.start('call-1', 'bash');
    clock.advance(3000);
    stop();
    clock.advance(5000);
    expect(beats).toHaveLength(0);
  });

  it('fires at most once per start (one-shot)', () => {
    const clock = fakeClock();
    const beats: unknown[] = [];
    const hb = createToolHeartbeat(
      (...args) => beats.push(args),
      { thresholdMs: 5000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    );

    const stop = hb.start('call-1', 'bash');
    clock.advance(6000);
    clock.advance(6000);
    expect(beats).toHaveLength(1);
    stop();
  });

  it('tracks multiple calls independently', () => {
    const clock = fakeClock();
    const beats: Array<{ id: string }> = [];
    const hb = createToolHeartbeat(
      (id) => beats.push({ id }),
      { thresholdMs: 5000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    );

    const stop1 = hb.start('call-1', 'bash');
    clock.advance(2000);
    const stop2 = hb.start('call-2', 'write');
    clock.advance(4000); // call-1 at 6s, call-2 at 4s
    expect(beats).toHaveLength(1);
    expect(beats[0]!.id).toBe('call-1');

    clock.advance(2000); // call-2 at 6s
    expect(beats).toHaveLength(2);
    expect(beats[1]!.id).toBe('call-2');

    stop1();
    stop2();
  });

  it('stop after fire is a no-op (cleanup safe)', () => {
    const clock = fakeClock();
    const hb = createToolHeartbeat(
      () => {},
      { thresholdMs: 1000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    );

    const stop = hb.start('call-1', 'bash');
    clock.advance(2000);
    // Should not throw
    stop();
    stop();
  });

  it('returns thresholdMs=0 when disabled', () => {
    const hb = createToolHeartbeat(() => {}, { thresholdMs: 0 });
    expect(hb.thresholdMs).toBe(0);
    const stop = hb.start('c1', 'bash');
    stop(); // no-op
  });
});
