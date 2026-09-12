// @vitest-environment jsdom
/**
 * QueuedFollowUps (F3) — "the chat stays responsive while a mission runs".
 *
 * Contract under test:
 *   - while a run is live the composer keeps accepting text: `send()` routes it
 *     through `classifyLiveSend` (liveSend.ts) to a steer or to the local
 *     queue — a mid-run send is NEVER dropped;
 *   - the queued text shows up as a visibly labelled chip ("Queued i/N" while
 *     running, "Next i/N" when idle), announced politely (`role=status`);
 *   - it is not a fake send: nothing here renders a sent user message, and
 *     removing a chip hands the text back through `onRemove` (App restores the
 *     draft) instead of quietly losing it.
 *
 * `vi.mock('react')`: apps/desktop ships its own React copy while
 * @testing-library/react at the root uses the root one — two Reacts in one
 * module graph break rendering. Same pin as Sidebar.test.tsx.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueuedFollowUps } from "./QueuedFollowUps";
import { classifyLiveSend } from "../liveSend";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

afterEach(cleanup);

describe("QueuedFollowUps — labelled local queue", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = render(
      <QueuedFollowUps items={[]} running onRemove={() => {}} />,
    );
    expect(container.querySelector(".attach-strip")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("labels a mid-run message as Queued (not sent) and shows the text", () => {
    const items = ["sistema il badge del tentacle", "poi rifai il typecheck"];
    const { container } = render(
      <QueuedFollowUps items={items} running onRemove={() => {}} />,
    );

    const strip = screen.getByLabelText("Queued follow-ups");
    expect(strip.getAttribute("role")).toBe("status");
    expect(strip.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Queued 1/2")).toBeTruthy();
    expect(screen.getByText("Queued 2/2")).toBeTruthy();
    expect(screen.getByText("sistema il badge del tentacle")).toBeTruthy();
    // A queued message is a pending affordance, never a rendered turn.
    expect(container.querySelector(".message")).toBeNull();
    expect(screen.queryByText(/sent/i)).toBeNull();
  });

  it("says Next — not Queued — when no run holds the queue", () => {
    render(<QueuedFollowUps items={["domani"]} running={false} onRemove={() => {}} />);
    expect(screen.getByText("Next 1/1")).toBeTruthy();
    expect(screen.queryByText(/^Queued/)).toBeNull();
  });

  it("hands the text back by index instead of dropping it", () => {
    const removed: number[] = [];
    render(
      <QueuedFollowUps items={["prima", "seconda"]} running onRemove={(i) => removed.push(i)} />,
    );
    fireEvent.click(screen.getByLabelText("Remove queued message 2 from the queue"));
    expect(removed).toEqual([1]);
  });

  it("truncates the chip but keeps the full text in the title", () => {
    const long = "x".repeat(100);
    render(<QueuedFollowUps items={[long]} running onRemove={() => {}} />);
    const chip = screen.getByTitle(long);
    expect(chip.querySelector(".attach-chip-sub")?.textContent).toBe(`${"x".repeat(72)}…`);
    expect(screen.getByText("Queued 1/1")).toBeTruthy();
  });

  it("mid-run input is routed, never dropped: every live send is steer or queue", () => {
    // Exactly what App's `send()` computes before touching anything.
    for (const steerSupported of [true, false]) {
      for (const alreadySteeredThisRun of [true, false]) {
        expect(
          classifyLiveSend({ running: true, steerSupported, alreadySteeredThisRun }),
        ).toMatch(/^(steer|queue)$/);
      }
    }
    // …and the queue arm is the visibly labelled chip above.
    render(<QueuedFollowUps items={["tieni questa per dopo"]} running onRemove={() => {}} />);
    expect(screen.getByText("Queued 1/1")).toBeTruthy();
    expect(screen.getByText("tieni questa per dopo")).toBeTruthy();
  });
});
