import { describe, expect, it } from 'vitest';
import {
  SIDECAR_LOG_RING_CAPACITY,
  isSidecarErrorLine,
  pushSidecarLogLine,
  sidecarLogLineFromPayload,
} from './sidecarLog.js';

describe('pushSidecarLogLine (FIX-6: ring buffer capped at 200)', () => {
  it('appends and drops the oldest beyond capacity (pure)', () => {
    const seed = Array.from({ length: SIDECAR_LOG_RING_CAPACITY }, (_, i) => `l${i}`);
    const next = pushSidecarLogLine(seed, 'newest');
    expect(next).toHaveLength(SIDECAR_LOG_RING_CAPACITY);
    expect(next[0]).toBe('l1');
    expect(next[next.length - 1]).toBe('newest');
    expect(seed).toHaveLength(SIDECAR_LOG_RING_CAPACITY); // input untouched
    expect(seed[0]).toBe('l0');
  });

  it('grows normally below capacity', () => {
    expect(pushSidecarLogLine(['a'], 'b')).toEqual(['a', 'b']);
  });
});

describe('isSidecarErrorLine', () => {
  it('flags error/fatal/panic/stack framing', () => {
    expect(isSidecarErrorLine('Error: ECONNREFUSED 127.0.0.1:9253')).toBe(true);
    expect(isSidecarErrorLine("thread 'main' panicked at src/lib.rs:1:")).toBe(true);
    expect(isSidecarErrorLine('stack backtrace:')).toBe(true);
    expect(isSidecarErrorLine('child exited with code 1')).toBe(true);
  });

  it('leaves plain stderr lines alone', () => {
    expect(isSidecarErrorLine('[headless] mode=kraken phase=build')).toBe(false);
    expect(isSidecarErrorLine('MCP tools: 42 registered')).toBe(false);
  });
});

describe('sidecarLogLineFromPayload (string | {line} normalization)', () => {
  it('object payload from the Rust emit', () => {
    expect(sidecarLogLineFromPayload({ line: 'boom' })).toBe('boom');
  });

  it('bare string tolerated', () => {
    expect(sidecarLogLineFromPayload('raw line')).toBe('raw line');
  });

  it('junk normalizes to "" so the caller drops it', () => {
    expect(sidecarLogLineFromPayload({ line: 42 })).toBe('');
    expect(sidecarLogLineFromPayload({})).toBe('');
    expect(sidecarLogLineFromPayload(null)).toBe('');
    expect(sidecarLogLineFromPayload(undefined)).toBe('');
    expect(sidecarLogLineFromPayload(7)).toBe('');
  });
});
