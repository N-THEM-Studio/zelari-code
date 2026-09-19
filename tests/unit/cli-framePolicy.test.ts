/**
 * cli-framePolicy.test.ts — v2.53 fail-loudly frame-type allowlist
 * (OpenHarness post-mortem): a frame type the code can emit but the companion
 * display allowlist does not know must fail the serve boot, not vanish.
 *
 * Covers the pure gate + the REAL pair (a green boot) and the throwing path
 * (message must contain every offending type name). The wiring itself sits at
 * the top of startHarnessServer (src/cli/serve/harnessServer.ts) — covered
 * end-to-end by tests/unit/cli-harnessServer.test.ts, which boots the real
 * server over in-memory streams.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPANION_DISPLAY_FRAME_ALLOWLIST,
  COMPANION_DISPLAY_FRAME_TYPES,
  EMITTED_FRAME_TYPES,
  assertCompanionFramePolicy,
  assertFramePolicyComplete,
} from '../../src/cli/companion/framePolicy.js';

describe('assertFramePolicyComplete (v2.53)', () => {
  it('passes silently when every emitted type is allowlisted', () => {
    expect(() =>
      assertFramePolicyComplete(['log', 'run_finished'], new Set(['log', 'run_finished'])),
    ).not.toThrow();
  });

  it('accepts an empty emitted list (nothing to police)', () => {
    expect(() => assertFramePolicyComplete([], new Set(['log']))).not.toThrow();
  });

  it('accepts extra allowlist entries (a policy may lead the emitters)', () => {
    expect(() =>
      assertFramePolicyComplete(['log'], new Set(['log', 'future_frame'])),
    ).not.toThrow();
  });

  it('throws naming the single missing type', () => {
    let error: unknown;
    try {
      assertFramePolicyComplete(['log', 'brand_new_frame'], new Set(['log']));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('brand_new_frame');
    expect(message).toContain('framePolicy.ts'); // actionable: where to fix it
    expect(message).not.toContain('log '); // the allowlisted type is not blamed
  });

  it('lists EVERY offending type, de-duplicated and sorted', () => {
    const message = (() => {
      try {
        assertFramePolicyComplete(['zeta', 'alpha', 'zeta', 'mid'], new Set());
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    expect(message).toContain('3 emitted frame type(s)');
    expect(message).toContain('alpha, mid, zeta');
  });
});

describe('the real emit/display pair (v2.53)', () => {
  it('boots green: every emitted frame type is allowlisted', () => {
    expect(() => assertCompanionFramePolicy()).not.toThrow();
  });

  it('allowlist covers the emitted vocabulary', () => {
    for (const type of EMITTED_FRAME_TYPES) {
      expect(COMPANION_DISPLAY_FRAME_ALLOWLIST.has(type)).toBe(true);
    }
    expect(COMPANION_DISPLAY_FRAME_TYPES.length).toBeGreaterThanOrEqual(
      EMITTED_FRAME_TYPES.length,
    );
  });

  it('tracks the real emitters (protocol, bridges, companion wrapper)', () => {
    for (const type of [
      'protocol_info',
      'control_accepted',
      'permission.request',
      'permission.settled',
      'ask_user.request',
      'ask_user.settled',
      'trust.pending',
      'log',
      'run_finished',
      'message_delta',
    ]) {
      expect(EMITTED_FRAME_TYPES).toContain(type);
    }
  });

  it('has no duplicate literals to keep the list honest', () => {
    expect(new Set(EMITTED_FRAME_TYPES).size).toBe(EMITTED_FRAME_TYPES.length);
  });
});
