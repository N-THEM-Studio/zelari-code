/**
 * runDeferredUpdateCheck — the boot-time update check is a single DEFERRED
 * ticket (v2.34, slice 7 of the 2026-09-15 input-lag diagnosis).
 *
 * Bug being locked down: the TUI fired the check 3s after mount, so the
 * registry round-trip (TLS handshake + JSON + the dynamic `import`) landed
 * right when the user started typing. Two contracts must hold:
 *  1. nothing happens before the delay (which is >10s, not 3s);
 *  2. exactly ONE check per process — it is not a repeating poll.
 * No network here: `sleep`, `check` and `report` are injected, and the delay
 * is driven by fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UPDATE_CHECK_DELAY_MS,
  runDeferredUpdateCheck,
  type UpdateCheckResult,
} from './updater.js';

const OUTDATED: UpdateCheckResult = {
  currentVersion: '1.0.0',
  latestVersion: '9.9.9',
  updateAvailable: true,
};

const UP_TO_DATE: UpdateCheckResult = {
  currentVersion: '1.0.0',
  latestVersion: '1.0.0',
  updateAvailable: false,
};

/** Drive the fake clock and let the ticket's promises settle. */
async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runDeferredUpdateCheck', () => {
  it('defers the check by more than 10s and runs it exactly once', async () => {
    const check = vi.fn(async () => OUTDATED);
    const report = vi.fn();
    void runDeferredUpdateCheck({ check, report });

    // Not a startup cost any more: still nothing at 3s…
    await advance(3000);
    expect(check).not.toHaveBeenCalled();

    // …and only one tick inside the window (t=11_999ms).
    await advance(UPDATE_CHECK_DELAY_MS - 3001);
    expect(check).not.toHaveBeenCalled();
    expect(UPDATE_CHECK_DELAY_MS).toBeGreaterThan(10_000);

    // t=12s: the single check fires.
    await advance(1);
    expect(check).toHaveBeenCalledTimes(1);

    // One-shot: ten more minutes of session change nothing.
    await advance(600_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toContain('9.9.9');
  });

  it('stays silent when the running version is current', async () => {
    const check = vi.fn(async () => UP_TO_DATE);
    const report = vi.fn();
    void runDeferredUpdateCheck({ check, report });

    await advance(UPDATE_CHECK_DELAY_MS);
    expect(check).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('swallows registry failures instead of disturbing the session', async () => {
    const check = vi.fn(async () => {
      throw new Error('network down');
    });
    const report = vi.fn();
    void runDeferredUpdateCheck({ check, report });

    await advance(UPDATE_CHECK_DELAY_MS);
    expect(check).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('honours an injected delay', async () => {
    const check = vi.fn(async () => OUTDATED);
    const report = vi.fn();
    void runDeferredUpdateCheck({ delayMs: 50, check, report });

    await advance(49);
    expect(check).not.toHaveBeenCalled();
    await advance(1);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
