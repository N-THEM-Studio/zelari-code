// @vitest-environment jsdom
/**
 * RunsTrigger (F4 polish) — contract under test:
 *   - the button is the trigger the sidebar rail used to host: same 4-square
 *     grid glyph, same aria-label, one click → App is asked to open the drawer
 *     (the flag stays App's, this component holds no state);
 *   - the badge paints the live count of runs in flight, exactly like the old
 *     sidebar badge, and disappears at 0;
 *   - App mounts it on the RIGHT side of the topbar, so the trigger and the
 *     right-hand drawer share one corner (source-level pin: App cannot be
 *     rendered here — same idiom as grokRoundWiring.contract.test.ts).
 *
 * vi.mock('react'): same duplicate-React pin as Sidebar.test.tsx.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunsTrigger } from "./RunsTrigger";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

afterEach(cleanup);

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("RunsTrigger", () => {
  it("asks App to open the dashboard and keeps the old grid glyph", () => {
    let opened = 0;
    const { container } = render(
      <RunsTrigger
        activeCount={0}
        onOpen={() => {
          opened += 1;
        }}
      />,
    );
    const button = container.querySelector<HTMLButtonElement>(".topbar-runs")!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Apri la dashboard delle run");
    expect(button.textContent).toContain("Runs");
    // The 4 squares of the old `.sidebar-dash-icon`, unchanged.
    expect(container.querySelectorAll(".topbar-runs-icon rect")).toHaveLength(4);
    fireEvent.click(button);
    expect(opened).toBe(1);
  });

  it("paints the active-run count and drops the badge at 0", () => {
    const busy = render(<RunsTrigger activeCount={3} onOpen={() => {}} />);
    const badge = busy.container.querySelector(".topbar-runs-badge");
    expect(badge?.textContent).toBe("3");
    expect(badge?.getAttribute("title")).toBe("3 run in corso");
    expect(busy.container.querySelector(".topbar-runs")?.getAttribute("title")).toContain(
      "tutte le run",
    );

    const idle = render(<RunsTrigger activeCount={0} onOpen={() => {}} />);
    expect(idle.container.querySelector(".topbar-runs-badge")).toBeNull();
  });

  it("is mounted by App on the topbar RIGHT side, next to the folder picker", () => {
    const app = read("../App.tsx");
    const start = app.indexOf('className="topbar-right"');
    expect(start).toBeGreaterThan(-1);
    const topbarRight = app.slice(start, app.indexOf("</header>", start));
    expect(topbarRight).toContain("<RunsTrigger");
    expect(topbarRight).toContain("activeCount={runsActive}"); // live badge source
    expect(topbarRight).toContain("onOpen={() => setDashboardOpen(true)}");
    expect(topbarRight).toContain("topbar-folder"); // still the right-hand cluster
    // The sidebar must not render a second trigger.
    expect(read("./Sidebar.tsx")).not.toContain("sidebar-dash-btn");
  });
});
