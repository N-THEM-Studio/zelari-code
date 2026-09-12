// @vitest-environment jsdom
/**
 * AutomationsSection — Settings → Automations (gardener scheduled task).
 *
 * Contract under test:
 *   - the card queries `manage_automation { action: "status" }` on mount and
 *     reports Registered / Not registered (+ next run when schtasks has one);
 *   - Register / Remove ship the CURRENT prefs (interval + budget cap) and the
 *     workspace path as camelCase Tauri args (snake_case Rust params);
 *   - with no workspace open the actions stay disabled — nothing to schedule;
 *   - every control autosaves through onPrefsChange (including the numeric
 *     budget, which falls back to the default on an empty/garbage commit).
 *
 * vi.mock('react'): apps/desktop has its own React copy (npm --prefix install)
 * while the root @testing-library/react uses the root copy — two Reacts in one
 * module graph break hooks. Same pin as LiveTasksPanel.test.tsx.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manageAutomation } from "../../agentClient";
import { DEFAULT_DESKTOP_PREFS, type DesktopPrefs } from "../../desktopPrefs";
import { AutomationsSection } from "./AutomationsSection";
import { SettingsToastProvider } from "./primitives";

vi.mock("react", async () => {
  // Direct .js import on purpose: it must resolve to the ROOT React copy
  // regardless of the nested apps/desktop/node_modules install.
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../../node_modules/react/index.js");
});

vi.mock("../../agentClient", () => ({ manageAutomation: vi.fn() }));

const manageMock = vi.mocked(manageAutomation);

const NOT_REGISTERED = {
  registered: false,
  detail: "Not registered (schtasks /Query exit code 1).",
  nextRun: null,
};

function prefs(overrides: Partial<DesktopPrefs> = {}): DesktopPrefs {
  return { ...DEFAULT_DESKTOP_PREFS, ...overrides };
}

function renderSection(options?: {
  prefs?: DesktopPrefs;
  workdir?: string | null;
}): { onPrefsChange: ReturnType<typeof vi.fn> } {
  const onPrefsChange = vi.fn();
  render(
    <SettingsToastProvider>
      <AutomationsSection
        prefs={options?.prefs ?? prefs()}
        onPrefsChange={onPrefsChange}
        workdir={options?.workdir === undefined ? "Z:/repo" : options.workdir}
      />
    </SettingsToastProvider>,
  );
  return { onPrefsChange };
}

beforeEach(() => {
  manageMock.mockReset();
  manageMock.mockResolvedValue(NOT_REGISTERED);
});

afterEach(cleanup);

describe("AutomationsSection — gardener card", () => {
  it("queries the scheduled task on mount and reports the status", async () => {
    renderSection();
    expect(await screen.findByText("Not registered")).toBeTruthy();
    expect(manageMock).toHaveBeenCalledWith({
      action: "status",
      intervalMin: 30,
      maxCostUsd: 2,
      repoPath: "Z:/repo",
    });
    // The Rust detail line is surfaced verbatim.
    expect(screen.getByText(NOT_REGISTERED.detail)).toBeTruthy();
  });

  it("registers with the current prefs and shows the next run time", async () => {
    manageMock.mockImplementation(async ({ action }) =>
      action === "register"
        ? {
            registered: true,
            detail: "Registered — every 60 min, budget cap $7.50 per run.",
            nextRun: "12/09/2026 10:30:00",
          }
        : NOT_REGISTERED,
    );
    renderSection({
      prefs: prefs({ gardenerEnabled: true, gardenerIntervalMin: 60, gardenerMaxCostUsd: 7.5 }),
    });
    expect(await screen.findByText("Not registered")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Register task" }));

    expect(await screen.findByText("Registered · next 12/09/2026 10:30:00")).toBeTruthy();
    expect(manageMock).toHaveBeenLastCalledWith({
      action: "register",
      intervalMin: 60,
      maxCostUsd: 7.5,
      repoPath: "Z:/repo",
    });
  });

  it("removes the task and flips the status row back to Not registered", async () => {
    manageMock.mockImplementation(async ({ action }) =>
      action === "remove"
        ? { registered: false, detail: "Removed — the task no longer runs.", nextRun: null }
        : { registered: true, detail: "Registered — next run 12/09/2026 10:30:00.", nextRun: "12/09/2026 10:30:00" },
    );
    renderSection();
    expect(await screen.findByText("Registered · next 12/09/2026 10:30:00")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove task" }));

    expect(await screen.findByText("Not registered")).toBeTruthy();
    expect(manageMock).toHaveBeenLastCalledWith({
      action: "remove",
      intervalMin: 30,
      maxCostUsd: 2,
      repoPath: "Z:/repo",
    });
  });

  it("disables register/remove when no workspace folder is open", async () => {
    renderSection({ workdir: null });
    await screen.findByText("Not registered");
    const register = screen.getByRole("button", {
      name: "Register task",
    }) as HTMLButtonElement;
    const remove = screen.getByRole("button", { name: "Remove task" }) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
  });

  it("autosaves every control through onPrefsChange", async () => {
    const { onPrefsChange } = renderSection();
    await screen.findByText("Not registered");

    fireEvent.click(screen.getByRole("switch", { name: "Enable gardener automation" }));
    expect(onPrefsChange).toHaveBeenCalledWith({ gardenerEnabled: true });

    fireEvent.change(screen.getByLabelText("Gardener interval"), { target: { value: "60" } });
    expect(onPrefsChange).toHaveBeenCalledWith({ gardenerIntervalMin: 60 });

    const cost = screen.getByLabelText("Gardener max cost");
    fireEvent.change(cost, { target: { value: "4.5" } });
    fireEvent.blur(cost);
    expect(onPrefsChange).toHaveBeenCalledWith({ gardenerMaxCostUsd: 4.5 });

    // Empty commit → the pref default, never NaN.
    fireEvent.change(cost, { target: { value: "" } });
    fireEvent.blur(cost);
    expect(onPrefsChange).toHaveBeenLastCalledWith({
      gardenerMaxCostUsd: DEFAULT_DESKTOP_PREFS.gardenerMaxCostUsd,
    });
  });
});
