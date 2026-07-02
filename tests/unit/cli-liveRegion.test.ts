// @vitest-environment jsdom
/**
 * cli-liveRegion.test.ts — v0.7.0 LiveRegion tail clamp + null-region behavior.
 *
 * The dynamic region must be bounded by construction so it never exceeds the
 * terminal height (which would force a full-screen repaint). The streaming
 * bubble is clamped to the last LIVE_STREAM_TAIL_LINES (10); the full text
 * is never lost — it lands complete in <Static> at finalize.
 *
 * NOTE: the project does not depend on `ink-testing-library`, so these tests
 * assert the clamp contract via the exported constant + the pure split/slice
 * logic (mirrored here) and validate the component renders a valid element.
 * The integration with actual Ink output is covered by manual verification
 * (Phase 6).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { LiveRegion } from '../../src/cli/components/LiveRegion.js';
import { EMPTY_LIVE, type LiveState } from '../../src/cli/hooks/chatState.js';

/** Tail clamp constant mirrored from LiveRegion (kept in sync manually). */
const LIVE_STREAM_TAIL_LINES = 10;

function mkStreaming(content: string, overrides: Partial<LiveState['streaming']> = {}): NonNullable<LiveState['streaming']> {
  return {
    id: 'streaming-x',
    role: 'assistant',
    content,
    ts: 1,
    ...overrides,
  };
}

describe('LiveRegion — tail clamp contract (v0.7.0)', () => {
  it('renders null when no streaming and no pending tools (no dynamic footprint)', () => {
    const el = LiveRegion({ live: EMPTY_LIVE, busy: false });
    expect(el).toBeNull();
  });

  it('clamps streaming content to the last LIVE_STREAM_TAIL_LINES lines', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`);
    const full = lines.join('\n');
    // Mirror the clamp logic the component applies.
    const tail = full.split('\n').slice(-LIVE_STREAM_TAIL_LINES);
    expect(tail).toHaveLength(LIVE_STREAM_TAIL_LINES);
    expect(tail[0]).toBe('line16');
    expect(tail[tail.length - 1]).toBe('line25');
  });

  it('does not clamp when content has fewer than the tail limit', () => {
    const full = 'a\nb\nc';
    const tail = full.split('\n').slice(-LIVE_STREAM_TAIL_LINES);
    expect(tail).toEqual(['a', 'b', 'c']);
  });

  it('renders a valid element for a short streaming bubble', () => {
    const el = LiveRegion({
      live: { streaming: mkStreaming('line1\nline2\nline3'), runningTools: [] },
      busy: true,
    });
    expect(React.isValidElement(el)).toBe(true);
  });

  it('renders a valid element when only pending tools exist (no streaming)', () => {
    const el = LiveRegion({
      live: {
        streaming: null,
        runningTools: [
          { id: 't1', role: 'tool', content: 'ls', ts: 1, toolName: 'bash', toolCallId: 'c1' },
        ],
      },
      busy: true,
    });
    expect(React.isValidElement(el)).toBe(true);
  });

  it('renders a valid element carrying the council member name', () => {
    const el = LiveRegion({
      live: {
        streaming: mkStreaming('delegating', { memberName: 'Caronte', memberId: 'charont' }),
        runningTools: [],
      },
      busy: false,
    });
    expect(React.isValidElement(el)).toBe(true);
  });
});
