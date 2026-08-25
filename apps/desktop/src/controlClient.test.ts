import { describe, expect, it } from 'vitest';
import { controlEvent, supportsControl } from './controlClient.js';

describe('controlClient capability gate (§35)', () => {
  it('no protocol_info (v1 CLI) → nothing supported', () => {
    expect(supportsControl(null, 'steer')).toBe(false);
    expect(supportsControl(undefined, 'cancel')).toBe(false);
  });

  it('protocol v1 → disabled even with capabilities list', () => {
    expect(
      supportsControl({ type: 'protocol_info', version: 1, capabilities: ['steer'] }, 'steer'),
    ).toBe(false);
  });

  it('protocol v2 → only advertised kinds', () => {
    const info = { type: 'protocol_info' as const, version: 2, capabilities: ['stdin-control', 'steer', 'follow_up', 'cancel'] };
    expect(supportsControl(info, 'steer')).toBe(true);
    expect(supportsControl(info, 'follow_up')).toBe(true);
    expect(supportsControl(info, 'cancel')).toBe(true);
  });

  it('pause/resume never supported on v2', () => {
    const info = { type: 'protocol_info' as const, version: 2, capabilities: ['steer', 'pause'] };
    expect(supportsControl(info, 'pause')).toBe(false);
    expect(supportsControl(info, 'resume')).toBe(false);
  });

  it('partial capabilities → only what the CLI declared', () => {
    const info = { type: 'protocol_info' as const, version: 2, capabilities: ['cancel'] };
    expect(supportsControl(info, 'steer')).toBe(false);
    expect(supportsControl(info, 'cancel')).toBe(true);
  });

  it('controlEvent builds unique ids and stable shape', () => {
    const a = controlEvent('steer', { text: 'do not touch the db' });
    const b = controlEvent('follow_up', { text: 'add tests' });
    expect(a.id).not.toBe(b.id);
    expect(a.type).toBe('steer');
    expect(a.text).toBe('do not touch the db');
    expect(b.ts).toBeGreaterThanOrEqual(a.ts);
    const c = controlEvent('cancel', { reason: 'user' });
    expect(c.text).toBeUndefined();
    expect(c.reason).toBe('user');
  });
});
