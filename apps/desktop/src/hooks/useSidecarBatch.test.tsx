// @vitest-environment jsdom
/**
 * SLICE3(sidecar-batching) — regression tests for the coalescing state holder.
 *
 * Bug being locked down: every sidecar event during a Kraken turn called a
 * `setState` on App (~4000 lines, 50+ hooks), so a burst of tentacle / tool /
 * progress events re-rendered the whole app once per event and the composer
 * stuttered while the user typed.
 *
 * What must hold after batching:
 *  1. many events inside one window = ONE commit (that is the whole point);
 *  2. the settled state is identical to the un-batched sequence — coalescing
 *     is a merge, never a drop (asserted against a plain-`useState` control
 *     running the very same sequence);
 *  3. a run boundary can force the pending batch out immediately;
 *  4. a continuous stream still paints every window (throttle, not debounce).
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Two-React guard: apps/desktop has its own node_modules copy of React
// (npm --prefix install) while @testing-library/react at the root uses the
// root copy — two Reacts in one module graph break hooks (dispatcher null).
// Same pin as useRunActivity.test.tsx / ChatComposer.test.tsx.
vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

import { useState } from "react";
import {
  SIDECAR_BATCH_MS,
  flushSidecarBatches,
  sidecarBatchRegistrySize,
  useBatchedState,
  type StateUpdate,
} from "./useSidecarBatch";

type LabelMap = Record<string, string | null>;
type StepMap = Record<string, string[]>;
/** The real shapes: a label map (liveToolLabelByConv) + an append-only map. */
type SidecarState = { labels: LabelMap; steps: StepMap };

/** Deterministic sidecar-ish sequence: functional appends interleaved with
 * direct assignments (exactly how App writes these slices). */
const SEQUENCE: Array<StateUpdate<SidecarState>> = Array.from(
  { length: 12 },
  (_unused, i) => (prev: SidecarState): SidecarState => ({
    labels: { ...prev.labels, "conv-A": i % 3 === 0 ? null : `tool-${i}` },
    steps: {
      ...prev.steps,
      "conv-A": [...(prev.steps["conv-A"] ?? []), `s${i}`],
    },
  }),
);
// A bare assignment (no updater) must not be swallowed by a neighbouring one.
SEQUENCE.push({ labels: { "conv-A": "final-label" }, steps: { "conv-A": ["x"] } });

interface Harness {
  /** Commit counter: renders of the harness component, mount excluded. */
  commits: () => number;
  state: () => SidecarState;
  enqueue: (update: StateUpdate<SidecarState>) => void;
}

function mountBatched(): Harness {
  const stats = { commits: 0, current: { labels: {}, steps: {} } as SidecarState };
  let enqueue: (update: StateUpdate<SidecarState>) => void = () => {};
  function View() {
    const [state, setState] = useBatchedState<SidecarState>({
      labels: {},
      steps: {},
    });
    stats.commits += 1;
    stats.current = state;
    enqueue = setState;
    return <div data-testid="labels">{Object.keys(state.labels).length}</div>;
  }
  render(<View />);
  stats.commits = 0; // the mount commit is not what we are counting
  return {
    commits: () => stats.commits,
    state: () => stats.current,
    enqueue: (update) => enqueue(update),
  };
}

/** Un-batched reference: the same sequence through a plain `useState`. */
function mountControl(): Harness {
  const stats = { commits: 0, current: { labels: {}, steps: {} } as SidecarState };
  let enqueue: (update: StateUpdate<SidecarState>) => void = () => {};
  function View() {
    const [state, setState] = useState<SidecarState>({ labels: {}, steps: {} });
    stats.commits += 1;
    stats.current = state;
    enqueue = setState;
    return <div />;
  }
  render(<View />);
  stats.commits = 0;
  return {
    commits: () => stats.commits,
    state: () => stats.current,
    enqueue: (update) => enqueue(update),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useBatchedState — sidecar coalescing", () => {
  it("coalesces a burst of sidecar updates into a single commit", () => {
    const h = mountBatched();
    act(() => {
      for (let i = 0; i < 40; i += 1) {
        h.enqueue((prev) => ({
          ...prev,
          labels: { ...prev.labels, "conv-A": `tool-${i}` },
          steps: {
            ...prev.steps,
            "conv-A": [...(prev.steps["conv-A"] ?? []), `s${i}`],
          },
        }));
      }
    });

    // The window is still open: nothing has been painted yet.
    expect(h.commits()).toBe(0);
    expect(h.state().steps["conv-A"]).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(SIDECAR_BATCH_MS);
    });
    // 40 events, ONE commit.
    expect(h.commits()).toBe(1);
    expect(h.state().labels["conv-A"]).toBe("tool-39");
    expect(h.state().steps["conv-A"]).toHaveLength(40);
  });

  it("settles on the exact un-batched state (merge, never drop)", () => {
    const batched = mountBatched();
    const control = mountControl();

    // Control: one commit PER EVENT, exactly the pre-fix behaviour.
    for (const update of SEQUENCE) {
      act(() => {
        control.enqueue(update);
      });
    }
    act(() => {
      for (const update of SEQUENCE) batched.enqueue(update);
    });
    act(() => {
      vi.advanceTimersByTime(SIDECAR_BATCH_MS);
    });

    expect(control.commits()).toBe(SEQUENCE.length);
    // The batched holder committed once, and landed on the SAME state.
    expect(batched.commits()).toBe(1);
    expect(batched.state()).toEqual(control.state());
    // The tail of SEQUENCE is a bare assignment (no updater): it replaces the
    // accumulated slice in both holders. Exact equality with the control above
    // is the real assertion — this one pins the slot it lands in.
    expect(control.state().steps["conv-A"]).toEqual(["x"]);
    expect(batched.state().steps["conv-A"]).toEqual(["x"]);
  });

  it("flushSidecarBatches lands the pending batch at a run boundary", () => {
    const h = mountBatched();
    act(() => {
      h.enqueue({ labels: { "conv-A": "tool-1" }, steps: { "conv-A": ["s0"] } });
    });
    expect(h.commits()).toBe(0);

    // Run finished / message_end path: no timer wait, straight to paint.
    act(() => {
      flushSidecarBatches();
    });
    expect(h.commits()).toBe(1);
    expect(h.state().labels["conv-A"]).toBe("tool-1");
    expect(h.state().steps["conv-A"]).toEqual(["s0"]);
  });

  it("keeps painting a continuous stream (throttle, not debounce)", () => {
    const h = mountBatched();
    for (let tick = 0; tick < 10; tick += 1) {
      act(() => {
        h.enqueue((prev) => ({
          ...prev,
          labels: { ...prev.labels, "conv-A": `t${tick}` },
          steps: prev.steps,
        }));
      });
      act(() => {
        vi.advanceTimersByTime(60); // events every 60ms, window is 180ms
      });
    }
    // 600ms of streaming at 60ms: three windows closed, one batch still open.
    expect(h.commits()).toBe(3);
    expect(h.state().labels["conv-A"]).toBe("t8");
  });

  it("registers and unregisters its flusher (no leak across remounts)", () => {
    const before = sidecarBatchRegistrySize();
    mountBatched();
    mountBatched();
    expect(sidecarBatchRegistrySize()).toBe(before + 2);
    cleanup();
    expect(sidecarBatchRegistrySize()).toBe(before);
  });
});
