// @vitest-environment jsdom
/**
 * useGitChanges — polling cadence (v2.34, slice 7 of the 2026-09-15 input-lag
 * diagnosis).
 *
 * Bug being locked down: the TUI polled `git` flat out every 4s for the whole
 * session — four child processes a minute on every terminal, even with the
 * sidebar hidden and a working tree that had not moved in hours.
 *
 * The contract now (proved with fake timers, the real hook, an injected
 * snapshot — no `git` is spawned here):
 *  1. the FIRST refresh is still immediate (unchanged behaviour);
 *  2. while `hot` (sidebar on screen / turn in flight) the fast cadence is kept;
 *  3. after GIT_IDLE_AFTER_TICKS unchanged snapshots the loop idles down to
 *     GIT_IDLE_POLL_MS;
 *  4. a change — or a `hot` flip — puts it straight back on the fast cadence.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  GIT_IDLE_AFTER_TICKS,
  GIT_IDLE_POLL_MS,
  GIT_POLL_MS,
  nextGitPollDelay,
  useGitChanges,
  type GitChanges,
  type GitFileChange,
} from "./useGitChanges.js";

const QUIET_REPO: GitChanges = {
  isRepo: true,
  branch: "main",
  files: [{ path: "src/a.ts", added: 1, removed: 0, untracked: false }],
};

/** Drive the fake clock and let the poll's promises settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("nextGitPollDelay", () => {
  const base = { pollMs: 4000, idlePollMs: 20_000, idleAfterTicks: 3, hot: false };

  it("stays fast until the quiet threshold, then idles down", () => {
    expect(nextGitPollDelay(0, base)).toBe(4000);
    expect(nextGitPollDelay(2, base)).toBe(4000);
    expect(nextGitPollDelay(3, base)).toBe(20_000);
    expect(nextGitPollDelay(99, base)).toBe(20_000);
  });

  it("never idles while hot (panel visible / turn in flight)", () => {
    expect(nextGitPollDelay(0, { ...base, hot: true })).toBe(4000);
    expect(nextGitPollDelay(99, { ...base, hot: true })).toBe(4000);
  });
});

describe("useGitChanges — adaptive cadence", () => {
  /**
   * Reference timeline for an unchanged repo (4s fast / 20s idle / 3 quiet):
   *   t=0s     poll #1 — immediate, and it CHANGES the (empty) snapshot
   *   t=4s     #2 quiet=1   t=8s #3 quiet=2   t=12s #4 quiet=3 → idle
   *   t=32s    #5 … every 20s from here on
   */
  it("refreshes immediately, then backs off to the idle cadence while nothing changes", async () => {
    const t0 = Date.now();
    const times: number[] = [];
    const snapshot = vi.fn(async (): Promise<GitChanges> => {
      times.push(Date.now() - t0);
      return QUIET_REPO;
    });
    const { unmount } = renderHook(() => useGitChanges({ snapshot }));

    // 1. The first refresh is immediate — same as before the slice.
    await advance(0);
    expect(times).toEqual([0]);

    // 2. Fast cadence while the tree is quiet-but-tolerated: 4s, 8s, 12s.
    await advance(GIT_POLL_MS * GIT_IDLE_AFTER_TICKS + 1);
    expect(times).toEqual([0, 4000, 8000, 12000]);

    // 3. Idle: not a single poll in the 15s after the idle threshold…
    await advance(15_000);
    expect(times).toEqual([0, 4000, 8000, 12000]);

    // …and exactly one when the idle interval elapses (t=32s).
    await advance(5001);
    expect(times).toEqual([0, 4000, 8000, 12000, 32_000]);

    unmount();
  });

  it("keeps polling at the fast cadence while hot", async () => {
    const snapshot = vi.fn(async () => QUIET_REPO);
    const { unmount } = renderHook(() => useGitChanges({ snapshot, hot: true }));

    await advance(0);
    expect(snapshot).toHaveBeenCalledTimes(1);

    // Ten windows later the loop is still at 4s — no back-off while watched.
    await advance(GIT_POLL_MS * 10);
    expect(snapshot).toHaveBeenCalledTimes(11);

    unmount();
  });

  it("refreshes IMMEDIATELY when the panel opens (hot flips)", async () => {
    const snapshot = vi.fn(async () => QUIET_REPO);
    const { rerender, unmount } = renderHook(
      ({ hot }: { hot: boolean }) => useGitChanges({ snapshot, hot }),
      { initialProps: { hot: false } },
    );

    // Idle all the way down first (immediate poll + 3 tolerated quiet ticks).
    await advance(0);
    await advance(GIT_POLL_MS * GIT_IDLE_AFTER_TICKS + 1);
    await advance(GIT_IDLE_POLL_MS - 1000);
    const idled = 1 + GIT_IDLE_AFTER_TICKS;
    expect(snapshot).toHaveBeenCalledTimes(idled);

    // The sidebar opens: the chip must be current NOW, not 20s from now.
    await act(async () => {
      rerender({ hot: true });
    });
    expect(snapshot).toHaveBeenCalledTimes(idled + 1);

    // …and the fast cadence is back.
    await advance(GIT_POLL_MS);
    expect(snapshot).toHaveBeenCalledTimes(idled + 2);

    unmount();
  });

  it("goes back to the fast cadence as soon as the tree changes", async () => {
    let files: GitFileChange[] = [];
    const snapshot = vi.fn(async (): Promise<GitChanges> => ({
      isRepo: true,
      branch: "main",
      files,
    }));
    const { unmount } = renderHook(() => useGitChanges({ snapshot }));

    // Quiet down to the idle cadence (t=12s, next poll due at t=32s).
    await advance(0);
    await advance(GIT_POLL_MS * GIT_IDLE_AFTER_TICKS + 1);
    const quietCalls = 1 + GIT_IDLE_AFTER_TICKS;
    expect(snapshot).toHaveBeenCalledTimes(quietCalls);

    // An out-of-band edit lands before the next (idle) poll.
    files = [{ path: "src/b.ts", added: 3, removed: 1, untracked: false }];
    await advance(GIT_IDLE_POLL_MS);
    expect(snapshot).toHaveBeenCalledTimes(quietCalls + 1);

    // The change reset the cadence: the next poll is one fast window away.
    await advance(GIT_POLL_MS);
    expect(snapshot).toHaveBeenCalledTimes(quietCalls + 2);

    unmount();
  });

  it("does not keep polling hot after git keeps failing", async () => {
    const t0 = Date.now();
    const times: number[] = [];
    const snapshot = vi.fn(async (): Promise<GitChanges> => {
      times.push(Date.now() - t0);
      throw new Error("git: not a repo");
    });
    const { unmount } = renderHook(() => useGitChanges({ snapshot }));

    await advance(0);
    await advance(GIT_POLL_MS * GIT_IDLE_AFTER_TICKS + 1);
    // A failing poll counts as quiet (there is no snapshot to compare), so the
    // loop backs off after three failures instead of hammering every 4s.
    expect(times).toEqual([0, 4000, 8000]);

    // t=12s…27s: nothing at all — the loop is idling, not polling at 4s.
    await advance(15_000);
    expect(times).toHaveLength(3);

    // t=28s: the idle poll lands.
    await advance(2000);
    expect(times).toHaveLength(4);

    unmount();
  });
});
