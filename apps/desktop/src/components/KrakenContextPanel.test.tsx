// @vitest-environment jsdom
/**
 * KrakenContextPanel compact-meter contract (readability pass).
 *
 * The strip used to sit at the bottom of the chat flow with every counter
 * painted at once. It is now a one-line COMPOSER meter
 * (`ctx 12.0k/200k · 6.0% est.` + phase) whose session record appears only on
 * expansion — and it renders NOTHING when it has nothing to say.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

// The real hook subscribes to the harness-event stream (Tauri IPC). The box
// is vi.hoisted so the mocked factory can read it; each compaction test
// drives view/receivedAt across rerenders of the SAME mounted strip.
const harnessBox = vi.hoisted(() => ({
  view: null as unknown,
  receivedAt: null as number | null,
}));
vi.mock("../harnessState", () => ({
  useHarnessState: () => ({
    view: harnessBox.view,
    receivedAt: harnessBox.receivedAt,
  }),
}));

import { KrakenContextPanel, type LiveCtxStats } from "./KrakenContextPanel";

afterEach(cleanup);

function live(over: Partial<LiveCtxStats> = {}): LiveCtxStats {
  return {
    ctxTokens: 12_000,
    turnTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    toolCount: 0,
    elapsedMs: null,
    streaming: false,
    ...over,
  };
}

const PROGRESS = {
  phase: "exploring",
  mode: "build" as const,
  tentacles: 2,
  exploreTentacles: 2,
  verifyTentacles: 0,
  writes: 0,
  phaseEnteredAt: 1,
};

function meterText(): string {
  return (
    document.querySelector(".kraken-ctx-meter")?.textContent?.replace(/\s+/g, " ").trim() ??
    ""
  );
}

describe("KrakenContextPanel — composer strip", () => {
  it("stays silent when there is no live signal and no phase", () => {
    const { container } = render(
      <KrakenContextPanel live={live({ ctxTokens: 0 })} progress={null} />,
    );
    expect(container.querySelector(".kraken-ctx-strip")).toBeNull();
  });

  it("keeps ONE line at rest and the record behind the click", () => {
    const { container } = render(<KrakenContextPanel live={live()} progress={PROGRESS} />);

    expect(container.querySelector(".kraken-ctx-strip")).toBeTruthy();
    expect(container.querySelector(".kraken-ctx-detail")).toBeNull();
    expect(meterText()).toBe("ctx 12.0k/200k · 6.0% est.");
    // Phase stays on the line; the tentacle counters do not.
    expect(screen.getByText("Exploring the codebase")).toBeTruthy();
    expect(screen.queryByText(/explore 2/)).toBeNull();

    const line = screen.getByRole("button", { name: /context details/ });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(line);

    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".kraken-ctx-detail")).toBeTruthy();
    expect(screen.getByText(/explore 2/)).toBeTruthy();
    // The meter itself is never duplicated into the expanded block.
    expect(document.querySelectorAll(".kraken-ctx-meter").length).toBe(1);
  });

  it("keeps the turn numbers out of the collapsed line while streaming", () => {
    const { container } = render(
      <KrakenContextPanel
        live={live({
          streaming: true,
          turnTokens: 4_200,
          promptTokens: 3_000,
          completionTokens: 1_200,
          toolCount: 3,
          elapsedMs: 12_000,
        })}
        progress={null}
      />,
    );

    expect(container.querySelector(".kraken-ctx-detail")).toBeNull();
    expect(meterText()).toBe("ctx 12.0k/200k · 6.0% est.");
    expect(screen.queryByText(/🛠 3/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /context details/ }));
    expect(screen.getByText(/🛠 3/)).toBeTruthy();
    // Locale-proof: the turn total is grouped by toLocaleString(), so compare
    // the digits instead of the separator.
    const nums = document.querySelector(".kraken-ctx-nums");
    expect(nums!.textContent).toContain("Σ");
    expect(nums!.textContent!.replace(/[^\d]/g, "")).toContain("4200");
  });
});

/** Minimal HarnessView with a compaction counter (support block only). */
function viewWith(
  compactions: number,
  support: Record<string, unknown> = {},
): unknown {
  return {
    turns: [],
    turnsTotal: 0,
    support: {
      compactions,
      contextProjections: 0,
      contextChars: 0,
      memoryEvents: 0,
      ...support,
    },
  };
}

describe("KrakenContextPanel — compaction you can see", () => {
  it("flashes the ⟲ chip the moment the spine compacts, and claims no % until the next budget event", () => {
    harnessBox.view = viewWith(0);
    harnessBox.receivedAt = 1_000;
    const props = { live: live(), progress: PROGRESS };
    const { rerender } = render(<KrakenContextPanel {...props} />);
    expect(document.querySelector(".kraken-ctx-compact-chip")).toBeNull();
    expect(meterText()).toBe("ctx 12.0k/200k · 6.0% est.");

    // The spine compacts: the next event carries compactions=1.
    harnessBox.view = viewWith(1);
    harnessBox.receivedAt = 1_500;
    rerender(<KrakenContextPanel {...props} />);

    const chip = document.querySelector(".kraken-ctx-compact-chip");
    expect(chip?.textContent).toContain("compacted");
    // Unknown ≠ 0: the meter stops claiming a percentage off the stale
    // pre-compaction proxy — this is the "stuck at 100% est." regression.
    expect(meterText()).toBe("ctx ⟲ · awaiting budget");
    const bar = document.querySelector(".kraken-ctx-bar");
    expect(bar?.getAttribute("aria-valuenow")).toBe("0");
    expect(bar?.getAttribute("role")).toBe("progressbar");
  });

  it("restores the readout when a fresh post-compaction budget event arrives", () => {
    harnessBox.view = viewWith(0);
    harnessBox.receivedAt = 1_000;
    const props = { live: live(), progress: PROGRESS };
    const { rerender } = render(<KrakenContextPanel {...props} />);

    harnessBox.view = viewWith(1);
    harnessBox.receivedAt = 1_500;
    rerender(<KrakenContextPanel {...props} />);
    expect(meterText()).toBe("ctx ⟲ · awaiting budget");

    // Next spine event: fresh (just arrived) and carrying the post-compaction
    // occupancy — the meter breathes again with real numbers.
    harnessBox.view = viewWith(1, {
      lastOccupancy: 0.22,
      contextLimit: 200_000,
      lastPolicy: "steady",
    });
    harnessBox.receivedAt = Date.now() - 1_000;
    rerender(<KrakenContextPanel {...props} />);

    expect(meterText()).toBe("ctx 44.0k/200k · 22%");
    expect(
      document.querySelector(".kraken-ctx-compact-chip")?.textContent,
    ).toContain("⟲");
  });

  it("does not flash a compaction that happened before the mount", () => {
    harnessBox.view = viewWith(3);
    harnessBox.receivedAt = Date.now() - 1_000;
    render(<KrakenContextPanel live={live()} progress={PROGRESS} />);

    const chip = document.querySelector(".kraken-ctx-compact-chip");
    expect(chip?.textContent).toContain("×3");
    expect(chip?.textContent).not.toContain("compacted");
    expect(chip?.classList.contains("is-fresh")).toBe(false);
  });
});
