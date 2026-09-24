// @vitest-environment jsdom
/**
 * ProviderSection — Settings → Models & Providers (2026-09-24 simplification).
 *
 * Contract under test:
 *   - the page reads as three steps: choose → connect → model;
 *   - connection state is spelled out on every provider card;
 *   - "Other…" in the model picker reveals a free-text id that autosaves
 *     through the same `set_app_config` channel (no separate duplicate row);
 *   - advanced connection settings stay collapsed for hosted providers and
 *     open for endpoint-driven ones (openai-compatible / custom);
 *   - the API format is a described choice that writes `apiStyle`.
 *
 * vi.mock('react'): same root-React pin as the other settings tests.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAppConfig } from "../../agentClient";
import type { DesktopConfig } from "../../types";
import { ProviderSection } from "./ProviderSection";
import { SettingsToastProvider } from "./primitives";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../../node_modules/react/index.js");
});

vi.mock("../../agentClient", () => ({
  setAppConfig: vi.fn(async () => ({ ok: true })),
  setApiKey: vi.fn(async () => ({ ok: true })),
  loginOAuth: vi.fn(async () => ({ ok: true })),
  logoutOAuth: vi.fn(async () => ({ ok: true })),
  refreshOAuth: vi.fn(async () => ({ ok: true })),
}));

const setConfigMock = vi.mocked(setAppConfig);

afterEach(() => {
  cleanup();
  setConfigMock.mockClear();
});

function config(activeProviderId = "grok"): DesktopConfig {
  return {
    activeProviderId,
    modelByProvider: { grok: "grok-4", "openai-compatible": "llama3" },
    providers: [
      {
        id: "grok",
        displayName: "Grok",
        hasKey: true,
        authKind: "oauth",
        envVar: "GROK_API_KEY",
        models: ["grok-4", "grok-3-fast"],
        defaultModel: "grok-4",
      },
      {
        id: "openai-compatible",
        displayName: "OpenAI-compatible",
        hasKey: false,
        envVar: "OPENAI_API_KEY",
        models: [],
        apiStyle: "chat",
        baseUrl: "https://api.example/v1",
      },
    ],
    cliVersion: "2.63.1",
    configPaths: { provider: "P/provider.json", keys: "P/keys.json" },
  } as DesktopConfig;
}

function renderSection(activeProviderId?: string) {
  const onRefresh = vi.fn(async () => {});
  const onActiveProviderChange = vi.fn();
  render(
    <SettingsToastProvider>
      <ProviderSection
        config={config(activeProviderId)}
        onRefresh={onRefresh}
        onActiveProviderChange={onActiveProviderChange}
      />
    </SettingsToastProvider>,
  );
  return { onRefresh, onActiveProviderChange };
}

describe("ProviderSection — guided steps", () => {
  it("reads as choose → connect → model, with connection state on every card", () => {
    renderSection();
    const titles = Array.from(document.querySelectorAll(".s-card-title")).map((h) => h.textContent ?? "");
    expect(titles[0]).toMatch(/^1 · Choose a provider/);
    expect(titles[1]).toMatch(/^2 · Connect Grok/);
    expect(titles[2]).toMatch(/^3 · Model — Grok/);
    expect(document.body.textContent).toContain("Connected · sign-in");
    expect(document.body.textContent).toContain("Not connected");
  });

  it("'Other…' reveals a model id field that saves through set_app_config", async () => {
    const { onActiveProviderChange } = renderSection();
    expect(screen.queryByRole("textbox", { name: "Model id" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "__other__" } });
    const field = screen.getByRole("textbox", { name: "Model id" });
    fireEvent.change(field, { target: { value: "grok-5-preview" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(setConfigMock).toHaveBeenCalledWith({ provider: "grok", model: "grok-5-preview" }),
    );
    await waitFor(() => expect(onActiveProviderChange).toHaveBeenCalledWith("grok", "grok-5-preview"));
  });

  it("keeps advanced connection settings collapsed for hosted providers", () => {
    renderSection("grok");
    const details = document.querySelector("details.s-collapsible") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it("opens them for endpoint-driven providers and writes the API format", async () => {
    renderSection("openai-compatible");
    const details = document.querySelector("details.s-collapsible") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Responses API/ }));
    await waitFor(() =>
      expect(setConfigMock).toHaveBeenCalledWith({ provider: "openai-compatible", apiStyle: "responses" }),
    );
  });
});
