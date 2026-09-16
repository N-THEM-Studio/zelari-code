// @vitest-environment jsdom
/**
 * ChatList windowing (W3.3): the message list mounts only the trailing
 * WINDOW_SIZE rows on first paint, exposes an explicit "load earlier" control,
 * and collapses the window back when the active conversation changes.
 *
 * CopyButton resolves a second React copy under jsdom (a pre-existing repo
 * quirk, see MessageContent.test.tsx), so it is stubbed. Windowing is about
 * how many message ROWS ChatList mounts, not about bubble internals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatList } from "./ChatList";
import type { ChatMessage } from "../types";

// Pin React to the root copy: apps/desktop ships its own node_modules/react
// while @testing-library/react (root) uses the root one — two Reacts in one
// module graph break hooks. Same pin as Sidebar.test.tsx / QueuedFollowUps.test.tsx.
vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

vi.mock("./CopyButton", () => ({
  CopyButton: () => <div data-testid="copy-stub" />,
}));

afterEach(cleanup);

/** n alternating user/assistant messages; `prefix` isolates ids per case. */
function makeMessages(n: number, prefix = "m"): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
    createdAt: i,
  }));
}

const noop = () => {};

function props(messages: ChatMessage[], conversationId?: string) {
  return {
    messages,
    running: false,
    onClarificationChoose: noop,
    onPermissionDecide: noop,
    onAskUserChoose: noop,
    conversationId,
  };
}

const rowCount = (container: HTMLElement) =>
  container.querySelectorAll(".message").length;

describe("ChatList windowing", () => {
  it("mounts only the trailing window for a long conversation", () => {
    const { container } = render(
      <ChatList {...props(makeMessages(200), "c1")} />,
    );
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(".message"),
    );
    expect(rows.length).toBeLessThanOrEqual(60);
    expect(rows.length).toBe(60);
    // Window is the tail: newest mounted, the head is not.
    expect(rows[0]?.textContent).toContain("message 140");
    expect(rows[rows.length - 1]?.textContent).toContain("message 199");
  });

  it("renders everything (and offers no control) when the chat is short", () => {
    const { container } = render(<ChatList {...props(makeMessages(10))} />);
    expect(rowCount(container)).toBe(10);
    expect(screen.queryByRole("button", { name: /load earlier/i })).toBeNull();
  });

  it("extends the window by WINDOW_SIZE when 'load earlier' is clicked", () => {
    const { container } = render(
      <ChatList {...props(makeMessages(200), "c2")} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /load earlier/i }));
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(".message"),
    );
    expect(rows.length).toBe(120);
    expect(rows[0]?.textContent).toContain("message 80");
    // Still older content, so the control stays.
    expect(screen.queryByRole("button", { name: /load earlier/i })).not.toBeNull();
  });

  it("loads the remainder in one click when only a window is left", () => {
    const { container } = render(
      <ChatList {...props(makeMessages(90), "c3")} />,
    );
    // 90 messages → 30 hidden behind the control.
    fireEvent.click(screen.getByRole("button", { name: /load earlier/i }));
    expect(rowCount(container)).toBe(90);
    expect(screen.queryByRole("button", { name: /load earlier/i })).toBeNull();
  });

  it("collapses the window back when the conversation changes", () => {
    const { container, rerender } = render(
      <ChatList {...props(makeMessages(200, "a"), "a")} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /load earlier/i }));
    expect(rowCount(container)).toBe(120);

    rerender(<ChatList {...props(makeMessages(200, "b"), "b")} />);
    expect(rowCount(container)).toBe(60);
  });

  it("keeps the newest message mounted when the tail grows (streaming append)", () => {
    const { container, rerender } = render(
      <ChatList {...props(makeMessages(200), "c4")} />,
    );
    rerender(<ChatList {...props(makeMessages(201), "c4")} />);
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(".message"),
    );
    expect(rows.length).toBeLessThanOrEqual(60);
    expect(rows[rows.length - 1]?.textContent).toContain("message 200");
  });
});
