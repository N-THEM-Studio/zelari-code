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

// The real hook subscribes to the harness-event stream (Tauri IPC).
vi.mock("../harnessState", () => ({
  useHarnessState: () => ({ view: null, receivedAt: null }),
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
