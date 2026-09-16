// @vitest-environment jsdom
/**
 * AgentsSection — Settings → Agents, model-sync slice (SLICE4).
 *
 * The desync this pins down: the chat model bar, `provider.json` and the
 * tentacle prefs are three different stores, and the Lead row used to show only
 * the FILE value while the chat bar showed its own React state — two models for
 * the same role, no way to see it from Settings.
 *
 * Contract under test:
 *   - "Lead model" renders the LIVE chat model passed from App, not the value
 *     sitting in `config.modelByProvider` (the stale provider.json read);
 *   - when the two drift, the card says which value lives where and offers the
 *     chat → config write through `setAppConfig` (the SAME `set_app_config`
 *     channel every other Settings panel uses), then refreshes;
 *   - with no chat model yet the file value is what is shown (fresh start), and
 *     with no drift there is nothing to save;
 *   - the tentacle picks stay on the prefs store and the card SAYS they do not
 *     change the main chat model.
 *
 * vi.mock('react'): apps/desktop has its own React copy (npm --prefix install)
 * while the root @testing-library/react uses the root copy — two Reacts in one
 * module graph break hooks. Same pin as AutomationsSection.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAppConfig } from "../../agentClient";
import { DEFAULT_DESKTOP_PREFS, type DesktopPrefs } from "../../desktopPrefs";
import type { DesktopConfig } from "../../types";
import { AgentsSection } from "./AgentsSection";
import { SettingsToastProvider } from "./primitives";

vi.mock("react", async () => {
  // Direct .js import on purpose: it must resolve to the ROOT React copy
  // regardless of the nested apps/desktop/node_modules install.
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../../node_modules/react/index.js");
});

// AgentsSection reaches the CLI config through agentClient only.
vi.mock("../../agentClient", () => ({
  setAppConfig: vi.fn(async () => ({ ok: true })),
}));

const setConfigMock = vi.mocked(setAppConfig);

afterEach(() => {
  cleanup();
  setConfigMock.mockClear();
});

function config(overrides: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    activeProviderId: "grok",
    modelByProvider: { grok: "grok-4" },
    providers: [
      {
        id: "grok",
        displayName: "Grok",
        hasKey: true,
        envVar: "XAI_API_KEY",
        models: ["grok-4", "grok-3-fast"],
        defaultModel: "grok-4",
      },
    ],
    cliVersion: "2.46.0",
    configPaths: { provider: "P/provider.json", keys: "P/keys.json" },
    ...overrides,
  };
}

function prefs(overrides: Partial<DesktopPrefs> = {}): DesktopPrefs {
  return { ...DEFAULT_DESKTOP_PREFS, ...overrides };
}

function renderSection(
  options: {
    config?: DesktopConfig | null;
    prefs?: DesktopPrefs;
    activeChatModel?: string;
  } = {},
): { onRefresh: ReturnType<typeof vi.fn>; onPrefsChange: ReturnType<typeof vi.fn> } {
  const onRefresh = vi.fn(async () => {});
  const onPrefsChange = vi.fn();
  render(
    <SettingsToastProvider>
      <AgentsSection
        config={options.config === undefined ? config() : options.config}
        prefs={options.prefs ?? prefs()}
        activeChatModel={options.activeChatModel ?? ""}
        onPrefsChange={onPrefsChange}
        onRefresh={onRefresh}
      />
    </SettingsToastProvider>,
  );
  return { onRefresh, onPrefsChange };
}

const leadValue = () => screen.getByText(/^Grok \/ /).textContent;
const saveDriftButton = () =>
  screen.queryByRole("button", { name: "Save chat model to provider.json" });

describe("AgentsSection - Lead model follows the active chat", () => {
  it("shows the chat model, not the stale provider.json value", () => {
    renderSection({ activeChatModel: "grok-3-fast" });

    // provider.json says grok-4; the chat is running grok-3-fast.
    expect(leadValue()).toBe("Grok / grok-3-fast");
    expect(leadValue()).not.toContain("grok-4");
  });

  it("names both values when chat and file drift apart", () => {
    renderSection({ activeChatModel: "grok-3-fast" });

    expect(document.body.textContent).toContain("The active chat uses grok-3-fast");
    expect(document.body.textContent).toContain("provider.json still stores grok-4");
    expect(saveDriftButton()).not.toBeNull();
  });

  it("saves the chat model to provider.json through the existing config channel", async () => {
    const { onRefresh } = renderSection({ activeChatModel: "grok-3-fast" });

    fireEvent.click(saveDriftButton() as HTMLButtonElement);

    await waitFor(() =>
      expect(setConfigMock).toHaveBeenCalledWith({
        provider: "grok",
        model: "grok-3-fast",
      }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("falls back to provider.json before the chat has a model (fresh start)", () => {
    renderSection({ activeChatModel: "" });

    expect(leadValue()).toBe("Grok / grok-4");
    expect(saveDriftButton()).toBeNull();
  });

  it("offers nothing to save while chat and provider.json agree", () => {
    renderSection({ activeChatModel: "grok-4" });

    expect(leadValue()).toBe("Grok / grok-4");
    expect(saveDriftButton()).toBeNull();
    expect(document.body.textContent).not.toContain("still stores");
  });
});

describe("AgentsSection - tentacle models are a separate store", () => {
  it("says tentacle models do not change the main chat model", () => {
    renderSection({ activeChatModel: "grok-3-fast" });

    expect(document.body.textContent).toContain(
      "They do not change the model of the main chat",
    );
  });

  it("keeps tentacle picks on the prefs store, never on the chat", () => {
    const { onPrefsChange } = renderSection({ activeChatModel: "grok-3-fast" });

    const explore = Array.from(document.querySelectorAll("select")).find((s) =>
      s.closest("label")?.textContent?.includes("Explore tentacles"),
    ) as HTMLSelectElement;
    expect(explore).toBeTruthy();
    fireEvent.change(explore, { target: { value: "grok-3-fast" } });

    expect(onPrefsChange).toHaveBeenCalledWith({ krakenExploreModel: "grok-3-fast" });
    // The chat model is untouched by a tentacle pick, and nothing is written
    // to provider.json from this card for sub-agent overrides.
    expect(setConfigMock).not.toHaveBeenCalled();
  });
});
