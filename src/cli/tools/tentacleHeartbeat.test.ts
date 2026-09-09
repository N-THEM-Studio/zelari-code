import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatTentacleElapsed,
  resolveTentacleHeartbeatMs,
  startTentacleHeartbeat,
  TENTACLE_HEARTBEAT_DEFAULT_MS,
  tentacleHeartbeatCaption,
} from './tentacleHeartbeat.js';

describe('tentacleHeartbeat', () => {
  afterEach(() => {
    delete process.env.ZELARI_TENTACLE_HEARTBEAT_MS;
    vi.useRealTimers();
  });

  it('formats elapsed as Ns then Mm Ss', () => {
    expect(formatTentacleElapsed(0)).toBe('0s');
    expect(formatTentacleElapsed(1_400)).toBe('1s');
    expect(formatTentacleElapsed(61_000)).toBe('1m 1s');
    expect(tentacleHeartbeatCaption(125_000)).toBe('reasoning · 2m 5s');
  });

  it('default interval is 15s; 0/off disables', () => {
    expect(resolveTentacleHeartbeatMs({})).toBe(TENTACLE_HEARTBEAT_DEFAULT_MS);
    expect(resolveTentacleHeartbeatMs({ ZELARI_TENTACLE_HEARTBEAT_MS: '0' })).toBe(0);
    expect(resolveTentacleHeartbeatMs({ ZELARI_TENTACLE_HEARTBEAT_MS: 'off' })).toBe(0);
    expect(resolveTentacleHeartbeatMs({ ZELARI_TENTACLE_HEARTBEAT_MS: '8000' })).toBe(8_000);
  });

  it('emits captions on the interval and stops', () => {
    vi.useFakeTimers();
    const beats: string[] = [];
    let t = 0;
    const stop = startTentacleHeartbeat((c) => beats.push(c), {
      intervalMs: 1_000,
      now: () => t,
    });
    t = 1_000;
    vi.advanceTimersByTime(1_000);
    t = 2_000;
    vi.advanceTimersByTime(1_000);
    expect(beats).toEqual(['reasoning · 1s', 'reasoning · 2s']);
    stop();
    t = 3_000;
    vi.advanceTimersByTime(1_000);
    expect(beats).toHaveLength(2);
  });
});
