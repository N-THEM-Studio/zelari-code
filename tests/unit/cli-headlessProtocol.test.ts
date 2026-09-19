/**
 * cli-headlessProtocol.test.ts — the headless control-plane protocol v2
 * factories (src/cli/headless/protocol.ts).
 *
 * Covers the two invariants that apply to this NDJSON stream: every rejection
 * ack carries a STABLE STRING error code (never a number, never a message used
 * as a code) and a clamped `reason` is ALWAYS disclosed with truncated: true.
 */
import { describe, expect, it } from 'vitest';
import {
  HEADLESS_ERROR_CODES,
  HEADLESS_PROTOCOL_CAPABILITIES,
  HEADLESS_PROTOCOL_VERSION,
  HEADLESS_REASON_MAX_CHARS,
  controlAcceptedEvent,
  controlAppliedEvent,
  controlRejectedEvent,
  protocolInfoEvent,
} from '../../src/cli/headless/protocol.js';

describe('headless/protocol — handshake + acks', () => {
  it('advertises the version and the capability set', () => {
    const info = protocolInfoEvent();
    expect(info.type).toBe('protocol_info');
    expect(info.version).toBe(HEADLESS_PROTOCOL_VERSION);
    expect(info.capabilities).toEqual(HEADLESS_PROTOCOL_CAPABILITIES);
    expect(typeof info.ts).toBe('number');
  });

  it('keeps accepted/applied acks free of error codes and truncation flags', () => {
    const accepted = controlAcceptedEvent('c1', 'steer');
    expect(accepted).toMatchObject({ type: 'control_accepted', controlId: 'c1', controlType: 'steer' });
    expect(accepted.code).toBeUndefined();

    const applied = controlAppliedEvent('c1', 'steer', 'turn-end');
    expect(applied).toMatchObject({
      type: 'control_applied',
      controlId: 'c1',
      controlType: 'steer',
      boundary: 'turn-end',
    });
    expect(applied.truncated).toBeUndefined();
  });
});

describe('headless/protocol — invariant 3: stable string codes on rejections', () => {
  it('every rejection carries a snake_case string code, never a message', () => {
    const rejected = controlRejectedEvent('c9', 'pause is not supported yet');
    expect(rejected.type).toBe('control_rejected');
    expect(rejected.controlId).toBe('c9');
    expect(rejected.code).toBe(HEADLESS_ERROR_CODES.CONTROL_REJECTED);
    expect(rejected.reason).toBe('pause is not supported yet');
    for (const code of Object.values(HEADLESS_ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(new Set(Object.values(HEADLESS_ERROR_CODES)).size).toBe(
      Object.values(HEADLESS_ERROR_CODES).length,
    );
  });

  it('lets a caller pick a more specific code without touching the reason', () => {
    const rejected = controlRejectedEvent('c9', 'run already finished', HEADLESS_ERROR_CODES.RUN_ALREADY_FINISHED);
    expect(rejected.code).toBe(HEADLESS_ERROR_CODES.RUN_ALREADY_FINISHED);
    expect(rejected.reason).toBe('run already finished');
  });
});

describe('headless/protocol — invariant 2: no silent truncation', () => {
  it('leaves a normal reason untouched and unflagged', () => {
    const short = 'x'.repeat(HEADLESS_REASON_MAX_CHARS);
    const rejected = controlRejectedEvent('c1', short);
    expect(rejected.reason).toBe(short);
    expect(rejected.truncated).toBeUndefined();
  });

  it('clamps an oversized reason AND discloses it', () => {
    const huge = 'y'.repeat(HEADLESS_REASON_MAX_CHARS + 500);
    const rejected = controlRejectedEvent('c1', huge);
    expect(rejected.reason).toHaveLength(HEADLESS_REASON_MAX_CHARS);
    expect(rejected.truncated).toBe(true);
    // The clamp is never silent: the flag is what makes the cut observable.
    const withoutFlag = { ...rejected };
    delete withoutFlag.truncated;
    expect(withoutFlag.reason).toHaveLength(HEADLESS_REASON_MAX_CHARS);
    expect(rejected.truncated).toBe(true);
  });
});
