// @vitest-environment jsdom
/**
 * SystemNotice — rendering contract: tone class + ARIA role, title / body /
 * hint, collapsed technical details, and the compact one-line variant.
 *
 * vi.mock('react'): same root-React pin as the other desktop component tests.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeSystemMessage } from "../systemNotice";
import { SystemNotice } from "./SystemNotice";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

afterEach(() => cleanup());

describe("SystemNotice", () => {
  it("renders a provider error as an alert card with details collapsed", () => {
    const raw = 'HTTP 404: {"error":"The model default-grok does not exist"}';
    render(<SystemNotice notice={describeSystemMessage(raw)} raw={raw} />);
    const card = screen.getByRole("alert");
    expect(card.className).toContain("notice-error");
    expect(screen.getByText("Model not found")).toBeTruthy();
    expect(screen.getByText(/Pick another model/)).toBeTruthy();
    const details = card.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("default-grok");
  });

  it("renders notes as a compact status line without a card", () => {
    render(<SystemNotice notice={describeSystemMessage("[zelari] indexing done")} raw="[zelari] indexing done" />);
    const line = screen.getByRole("status");
    expect(line.className).toContain("notice-compact");
    expect(line.textContent).toContain("indexing done");
    expect(line.querySelector("details")).toBeNull();
  });
});
