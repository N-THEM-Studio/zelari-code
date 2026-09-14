// @vitest-environment jsdom
/**
 * PermissionCard density contract (readability pass).
 *
 * Bug: a tool ask left a full card — preview open, four buttons — in the
 * transcript FOREVER, long after the decision was made, dominating the chat.
 * Contract under test:
 *   - PENDING keeps kicker, question, reason, category chip and the SAME four
 *     decisions (TUI parity);
 *   - a long preview is collapsed behind a "Show preview (N lines)" summary
 *     and the open <pre> can never exceed the 140px scroll box;
 *   - a short preview renders open (cheaper to read than a click);
 *   - SETTLED renders ONE line — chip class + ✓/✕ tone, role=status, the
 *     existing label, the tool — with no buttons and no preview at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PermissionCard } from "./PermissionCard";
import type { PermissionAskState } from "../inChatAsk";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

afterEach(cleanup);

function ask(over: Partial<PermissionAskState> = {}): PermissionAskState {
  return {
    requestId: "req-1",
    tool: "bash",
    category: "shell",
    categories: ["shell"],
    reason: "Runs the test suite",
    status: "pending",
    ...over,
  };
}

function previewBlock(): HTMLDetailsElement | null {
  return document.querySelector("details.permission-preview-block");
}

describe("PermissionCard — pending ask", () => {
  it("keeps the ask, the reason, the category and the four decisions", () => {
    render(<PermissionCard ask={ask()} onDecide={() => {}} />);
    expect(screen.getByText(/Allow tool “bash”\?/)).toBeTruthy();
    expect(screen.getByText("Runs the test suite")).toBeTruthy();
    expect(screen.getByText("shell")).toBeTruthy();
    expect(screen.getByText("Allow once")).toBeTruthy();
    expect(screen.getByText("Always this session · tool bash")).toBeTruthy();
    expect(screen.getByText("Always this session · shell")).toBeTruthy();
    expect(screen.getByText("Deny")).toBeTruthy();
  });

  it("collapses a long preview behind a line count", () => {
    const preview = Array.from({ length: 40 }, (_, i) => `diff line ${i}`).join("\n");
    render(<PermissionCard ask={ask({ preview })} onDecide={() => {}} />);

    const block = previewBlock();
    expect(block).toBeTruthy();
    expect(block!.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Show preview (40 lines)")).toBeTruthy();
    // The payload is still there, one click away.
    expect(screen.getByText(/diff line 39/)).toBeTruthy();
  });

  it("collapses a huge payload even when it is only a few lines", () => {
    const preview = "x".repeat(1200) + "\n" + "y".repeat(1200);
    render(<PermissionCard ask={ask({ preview })} onDecide={() => {}} />);
    expect(previewBlock()!.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Show preview (2 lines)")).toBeTruthy();
  });

  it("opens a short preview inline", () => {
    render(
      <PermissionCard
        ask={ask({ preview: 'npm test -- --run\ncwd: "Z:/repo"' })}
        onDecide={() => {}}
      />,
    );
    expect(previewBlock()!.hasAttribute("open")).toBe(true);
    expect(screen.getByText("Preview")).toBeTruthy();
  });

  it("renders no preview block when the ask carries none", () => {
    render(<PermissionCard ask={ask({ preview: undefined })} onDecide={() => {}} />);
    expect(previewBlock()).toBeNull();
  });
});

describe("PermissionCard — settled ask (compact chip)", () => {
  it("renders a one-line allow chip with no buttons and no preview", () => {
    render(
      <PermissionCard
        ask={ask({ status: "allow", preview: Array.from({ length: 30 }, () => "x").join("\n") })}
        onDecide={() => {}}
      />,
    );

    const chip = document.querySelector(".permission-chip");
    expect(chip).toBeTruthy();
    expect(chip!.classList.contains("is-allow")).toBe(true);
    expect(chip!.classList.contains("is-deny")).toBe(false);
    expect(chip!.getAttribute("role")).toBe("status");
    expect(chip!.getAttribute("aria-label")).toBe("Tool permission — Allowed once: bash");
    expect(screen.getByText("Allowed once")).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();

    // The big card, its preview and its buttons are gone for good.
    expect(document.querySelector(".clarification-card")).toBeNull();
    expect(previewBlock()).toBeNull();
    expect(screen.queryByText("Allow once")).toBeNull();
    expect(screen.queryByText("Deny")).toBeNull();
    expect(screen.queryByText(/Allow tool/)).toBeNull();
  });

  it("keeps the always-* labels verbatim on the chip", () => {
    render(<PermissionCard ask={ask({ status: "always-category" })} onDecide={() => {}} />);
    expect(screen.getByText("Allowed for this session (category)")).toBeTruthy();
    expect(document.querySelector(".permission-chip")!.classList.contains("is-allow")).toBe(
      true,
    );
  });

  it("tones a deny and a timeout as denials", () => {
    const { unmount } = render(<PermissionCard ask={ask({ status: "deny" })} onDecide={() => {}} />);
    expect(screen.getByText("Denied")).toBeTruthy();
    expect(document.querySelector(".permission-chip")!.classList.contains("is-deny")).toBe(true);
    unmount();

    render(<PermissionCard ask={ask({ status: "timeout" })} onDecide={() => {}} />);
    expect(screen.getByText("Timed out — denied")).toBeTruthy();
    expect(document.querySelector(".permission-chip")!.classList.contains("is-deny")).toBe(true);
  });
});
