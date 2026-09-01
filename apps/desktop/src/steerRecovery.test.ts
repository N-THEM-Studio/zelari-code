import { describe, expect, it } from 'vitest';
import { parseSteerSendResult } from './steerRecovery.js';

describe('parseSteerSendResult (FIX-4 FE: noop steer must not lose the text)', () => {
  it('authoritative object shape: {accepted:false, outcome:"already_finished"}', () => {
    // Exact harnessServer.ts session.steer noop payload, resolved as a
    // parsed object by the new send_control bridge.
    const result = parseSteerSendResult({
      accepted: false,
      outcome: 'already_finished',
      controlId: 'ctrl-1',
      controlType: 'steer',
    });
    expect(result).toEqual({ status: 'already_finished' });
  });

  it('accepted:true → null (real acks arrive as events, never recovered)', () => {
    expect(
      parseSteerSendResult({ accepted: true, controlId: 'ctrl-1', controlType: 'steer', boundary: 'turn-end' }),
    ).toBeNull();
    // Belt and braces: even a nonsensical accepted+outcome mix defers to the
    // ack-event flow.
    expect(parseSteerSendResult({ accepted: true, outcome: 'already_finished' })).toBeNull();
  });

  it('authoritative JSON string shape tolerated', () => {
    expect(
      parseSteerSendResult('{"accepted":false,"outcome":"already_finished","controlId":"c","controlType":"steer"}'),
    ).toEqual({ status: 'already_finished' });
  });

  it('legacy {status:…} object and string shapes still classify', () => {
    expect(parseSteerSendResult({ status: 'already_finished' })).toEqual({ status: 'already_finished' });
    expect(parseSteerSendResult('{"status":"follow_up_queued"}')).toEqual({ status: 'follow_up_queued' });
    expect(parseSteerSendResult('…already_finished…')).toEqual({ status: 'already_finished' });
  });

  it('case-insensitive on both fields', () => {
    expect(parseSteerSendResult({ outcome: 'ALREADY_FINISHED' })).toEqual({ status: 'already_finished' });
    expect(parseSteerSendResult({ status: 'Follow_Up_Queued' })).toEqual({ status: 'follow_up_queued' });
  });

  it('backward compatible: falsy/old-build results → null (behavior unchanged)', () => {
    expect(parseSteerSendResult(undefined)).toBeNull();
    expect(parseSteerSendResult(null)).toBeNull();
    expect(parseSteerSendResult('')).toBeNull();
    expect(parseSteerSendResult({})).toBeNull();
    expect(parseSteerSendResult({ accepted: false })).toBeNull();
    expect(parseSteerSendResult({ outcome: 'something_else' })).toBeNull();
    expect(parseSteerSendResult(42)).toBeNull();
  });
});
