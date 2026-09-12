// @vitest-environment jsdom
/**
 * ComposerToolbar (grok-round) contract under test:
 *   - three pills render with the CURRENT values (model, permission preset,
 *     mode · phase [+ Graph/Gauntlet]) and no panel is open up front;
 *   - the model pill hosts the untouched `ProviderModelBar` — provider, model,
 *     thinking and the discover button all keep their aria-labels and their
 *     handlers, so discovery did not lose anything by moving off the topbar;
 *   - the permission pill drives the SAME pref Settings edits (same
 *     `PERMISSION_PRESETS`, same single-value select semantics);
 *   - the mode pill carries Mode / Phase / Graph / Gauntlet, with the graph
 *     exception rule preserved (Mode is disabled while Graph is on);
 *   - dismissal: Escape, a pointer-down outside, and re-clicking the pill;
 *   - `disabled` (a live run) reaches every choice control.
 *
 * vi.mock('react'): same double-React pin as Sidebar.test.tsx (apps/desktop has
 * its own node_modules copy of React while @testing-library/react at the root
 * uses the root one — two Reacts in one module graph break hooks).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_PREFS, PERMISSION_PRESETS } from "../desktopPrefs";
import type { DesktopConfig } from "../types";
import { ComposerToolbar, type ComposerToolbarProps } from "./ComposerToolbar";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

// ProviderModelBar reaches for Tauri through ./agentClient. Two models are
// already cached in the config below, so the "sparse list" effect never fires
// and the discovery path stays out of the way of every assertion here.
vi.mock("../agentClient", () => ({
  discoverModels: vi.fn(async () => ({ models: [] })),
  getAppConfig: vi.fn(async () => {
    throw new Error("not used");
  }),
}));

afterEach(cleanup);

const config: DesktopConfig = {
  activeProviderId: "grok",
  modelByProvider: { grok: "grok-4" },
  providers: [
    {
      id: "grok",
      displayName: "Grok",
      hasKey: true,
      envVar: "XAI_API_KEY",
      models: ["grok-4", "grok-4-mini"],
      defaultModel: "grok-4",
      thinking: "high",
    },
    {
      id: "anthropic",
      displayName: "Anthropic",
      hasKey: true,
      envVar: "ANTHROPIC_API_KEY",
      models: ["claude-sonnet-4"],
      defaultModel: "claude-sonnet-4",
    },
  ],
  cliVersion: "0.0.0-test",
  configPaths: { provider: "p", keys: "k" },
};

function props(over: Partial<ComposerToolbarProps> = {}): ComposerToolbarProps {
  return {
    config,
    provider: "grok",
    model: "grok-4",
    onProviderChange: () => {},
    onModelChange: () => {},
    onThinkingChange: () => {},
    permissionPreset: DEFAULT_DESKTOP_PREFS.permissionPreset,
    onPermissionPresetChange: () => {},
    mode: "kraken",
    onModeChange: () => {},
    phase: "build",
    onPhaseChange: () => {},
    krakenGraph: false,
    onKrakenGraphChange: () => {},
    gauntlet: false,
    onGauntletChange: () => {},
    ...over,
  };
}

const pill = (label: string) => screen.getByRole("button", { name: label });
const panel = (label: string) => screen.queryByRole("dialog", { name: label });

describe("ComposerToolbar - pills", () => {
  it("shows the current value on each pill and opens nothing up front", () => {
    render(<ComposerToolbar {...props()} />);
    expect(pill("Provider and model").textContent).toBe("grok-4");
    expect(pill("Tool permissions").textContent).toBe("standard");
    expect(pill("Run mode").textContent).toBe("kraken · build");
    // No panel is mounted until its pill is used.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText("Provider")).toBeNull();
  });

  it("carries Graph and Gauntlet in the mode pill label", () => {
    render(<ComposerToolbar {...props({ krakenGraph: true, gauntlet: true })} />);
    expect(pill("Run mode").textContent).toBe("kraken · build · Graph · Gauntlet");
  });

  it("falls back to the provider when no model is selected yet", () => {
    render(<ComposerToolbar {...props({ model: "" })} />);
    expect(pill("Provider and model").textContent).toBe("grok");
  });
});

describe("ComposerToolbar - model pill hosts ProviderModelBar", () => {
  const openModel = () => fireEvent.click(pill("Provider and model"));

  it("mounts provider, model, thinking and the discover button", () => {
    render(<ComposerToolbar {...props()} />);
    openModel();

    const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
    const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
    const thinkingSelect = screen.getByLabelText("Thinking effort") as HTMLSelectElement;

    expect(providerSelect.value).toBe("grok");
    expect(modelSelect.value).toBe("grok-4");
    expect(thinkingSelect.value).toBe("high"); // the provider's stored effort
    expect(screen.getByLabelText("Refresh models")).toBeTruthy();
    // The option lists come from the config, i.e. discovery data still flows.
    expect([...modelSelect.options].map((o) => o.value)).toEqual([
      "grok-4",
      "grok-4-mini",
    ]);
  });

  it("reports provider, model and thinking changes", () => {
    const calls: string[] = [];
    render(
      <ComposerToolbar
        {...props({
          onProviderChange: (id) => calls.push(`provider:${id}`),
          onModelChange: (id) => calls.push(`model:${id}`),
          onThinkingChange: (spec) => calls.push(`thinking:${spec}`),
        })}
      />,
    );
    openModel();

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "grok-4-mini" },
    });
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "anthropic" },
    });
    // The effort list is provider/model dependent, so pick a real neighbour
    // instead of hard-coding the capability table here.
    const thinking = screen.getByLabelText("Thinking effort") as HTMLSelectElement;
    const other = [...thinking.options].find((o) => o.value !== thinking.value)!;
    fireEvent.change(thinking, { target: { value: other.value } });

    expect(calls).toEqual([
      "model:grok-4-mini",
      "provider:anthropic",
      `thinking:${other.value}`,
    ]);
  });
});

describe("ComposerToolbar - permission pill", () => {
  it("edits the same preset Settings edits, with the same options", () => {
    const picked: string[] = [];
    render(
      <ComposerToolbar
        {...props({ onPermissionPresetChange: (p) => picked.push(p) })}
      />,
    );
    fireEvent.click(pill("Tool permissions"));

    const select = screen.getByLabelText("Permission preset") as HTMLSelectElement;
    expect(select.value).toBe("standard");
    expect([...select.options].map((o) => o.value)).toEqual([
      ...PERMISSION_PRESETS,
    ]);

    fireEvent.change(select, { target: { value: "yolo" } });
    expect(picked).toEqual(["yolo"]);
  });

  it("reflects the pref it is handed (one store, two UIs)", () => {
    render(<ComposerToolbar {...props({ permissionPreset: "strict" })} />);
    expect(pill("Tool permissions").textContent).toBe("strict");
    fireEvent.click(pill("Tool permissions"));
    expect(
      (screen.getByLabelText("Permission preset") as HTMLSelectElement).value,
    ).toBe("strict");
  });
});

describe("ComposerToolbar - mode pill", () => {
  it("carries mode, phase, graph and gauntlet with their handlers", () => {
    const calls: string[] = [];
    render(
      <ComposerToolbar
        {...props({
          onModeChange: (m) => calls.push(`mode:${m}`),
          onPhaseChange: (p) => calls.push(`phase:${p}`),
          onKrakenGraphChange: (v) => calls.push(`graph:${v}`),
          onGauntletChange: (v) => calls.push(`gauntlet:${v}`),
        })}
      />,
    );
    fireEvent.click(pill("Run mode"));

    fireEvent.click(screen.getByText("Council"));
    fireEvent.click(screen.getByText("Plan"));
    fireEvent.click(screen.getByText("Graph"));
    fireEvent.click(screen.getByText("Gauntlet"));

    expect(calls).toEqual([
      "mode:council",
      "phase:plan",
      "graph:true",
      "gauntlet:true",
    ]);
  });

  it("keeps mode disabled while Graph is on (the topbar rule)", () => {
    render(<ComposerToolbar {...props({ krakenGraph: true })} />);
    fireEvent.click(pill("Run mode"));
    expect((screen.getByText("Council") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Kraken") as HTMLButtonElement).disabled).toBe(true);
    // Phase and the two exception toggles stay usable.
    expect((screen.getByText("Plan") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("Graph") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ComposerToolbar - dismissal", () => {
  it("closes on Escape", () => {
    render(<ComposerToolbar {...props()} />);
    fireEvent.click(pill("Tool permissions"));
    expect(panel("Tool permissions")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel("Tool permissions")).toBeNull();
    expect(pill("Tool permissions").getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a pointer-down outside and stays open on one inside", () => {
    render(<ComposerToolbar {...props()} />);
    fireEvent.click(pill("Tool permissions"));

    // Inside the panel (and inside the pill) the popover survives…
    fireEvent.pointerDown(screen.getByLabelText("Permission preset"));
    expect(panel("Tool permissions")).toBeTruthy();

    // …outside it closes.
    fireEvent.pointerDown(document.body);
    expect(panel("Tool permissions")).toBeNull();
  });

  it("re-clicking the pill toggles it shut instead of reopening", () => {
    render(<ComposerToolbar {...props()} />);
    fireEvent.click(pill("Run mode"));
    expect(panel("Run mode")).toBeTruthy();

    fireEvent.pointerDown(pill("Run mode")); // the click a real user makes
    fireEvent.click(pill("Run mode"));
    expect(panel("Run mode")).toBeNull();
  });

  it("opening another pill closes the first", () => {
    render(<ComposerToolbar {...props()} />);
    fireEvent.click(pill("Provider and model"));
    expect(panel("Provider and model")).toBeTruthy();

    fireEvent.click(pill("Run mode"));
    expect(panel("Provider and model")).toBeNull();
    expect(panel("Run mode")).toBeTruthy();
  });
});

describe("ComposerToolbar - live run", () => {
  it("disables every pill and every choice control while running", () => {
    render(<ComposerToolbar {...props({ disabled: true })} />);
    for (const label of ["Provider and model", "Tool permissions", "Run mode"]) {
      expect((pill(label) as HTMLButtonElement).disabled).toBe(true);
    }
    // A disabled pill cannot be opened, so no control is reachable mid-run.
    fireEvent.click(pill("Tool permissions"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
