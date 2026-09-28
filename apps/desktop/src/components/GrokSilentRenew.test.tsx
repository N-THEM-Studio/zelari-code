// @vitest-environment jsdom
/**
 * Chat provider popover: selecting Grok renews silently; the native select
 * cannot re-fire, so the popover also hosts the Settings "Renew session" row.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_PREFS } from "../desktopPrefs";
import { loginOAuth, refreshOAuth } from "../agentClient";
import {
  renewGrokAfterChatPersist,
  renewGrokSession,
  resetGrokRenewForTests,
} from "../grokSessionRenew";
import type { DesktopConfig } from "../types";
import { ComposerToolbar, type ComposerToolbarProps } from "./ComposerToolbar";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

vi.mock("../agentClient", () => ({
  discoverModels: vi.fn(async () => ({ models: [] })),
  getAppConfig: vi.fn(async () => {
    throw new Error("not used");
  }),
  refreshOAuth: vi.fn(async () => ({ ok: true, message: "Refreshed grok OAuth token." })),
  loginOAuth: vi.fn(async () => ({ ok: true })),
}));

const refreshMock = vi.mocked(refreshOAuth);
const loginMock = vi.mocked(loginOAuth);

afterEach(() => {
  cleanup();
  refreshMock.mockReset();
  refreshMock.mockResolvedValue({ ok: true, message: "Refreshed grok OAuth token." });
  loginMock.mockClear();
  resetGrokRenewForTests();
});

function config(hasRefreshToken: boolean): DesktopConfig {
  return {
    activeProviderId: "anthropic",
    modelByProvider: { grok: "grok-4", anthropic: "claude-sonnet-4" },
    providers: [
      {
        id: "grok",
        displayName: "Grok",
        hasKey: true,
        authKind: "oauth",
        envVar: "XAI_API_KEY",
        models: ["grok-4"],
        defaultModel: "grok-4",
        hasRefreshToken,
      },
      {
        id: "anthropic",
        displayName: "Anthropic",
        hasKey: true,
        envVar: "ANTHROPIC_API_KEY",
        models: ["claude-sonnet-4"],
        defaultModel: "claude-sonnet-4",
        hasRefreshToken: true,
      },
    ],
    cliVersion: "0.0.0-test",
    configPaths: { provider: "p", keys: "k" },
  };
}

function renderBar(opts: {
  provider: string;
  hasRefreshToken: boolean;
  refreshConfig: () => Promise<void>;
  statuses: string[];
}) {
  const cfg = config(opts.hasRefreshToken);
  const props: ComposerToolbarProps = {
    config: cfg,
    provider: opts.provider,
    model: opts.provider === "grok" ? "grok-4" : "claude-sonnet-4",
    onProviderChange: (id) => {
      void renewGrokAfterChatPersist({
        providerId: id,
        hasRefreshToken: cfg.providers.find((p) => p.id === id)?.hasRefreshToken,
        refreshConfig: opts.refreshConfig,
        setStatus: (message) => opts.statuses.push(message),
      });
    },
    onModelChange: () => {},
    onThinkingChange: () => {},
    onRenewGrokSession: () => {
      void renewGrokSession(opts.refreshConfig).then((result) => {
        opts.statuses.push(result.message);
      });
    },
    permissionPreset: DEFAULT_DESKTOP_PREFS.permissionPreset,
    onPermissionPresetChange: () => {},
    tentacles: DEFAULT_DESKTOP_PREFS,
    onTentaclesChange: () => {},
    mode: "kraken",
    onModeChange: () => {},
    phase: "build",
    onPhaseChange: () => {},
    krakenGraph: false,
    onKrakenGraphChange: () => {},
    gauntlet: false,
    onGauntletChange: () => {},
  };
  render(<ComposerToolbar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Provider and model" }));
}

describe("chat provider popover — silent Grok renew", () => {
  it("selecting Grok with a refresh token calls refreshOAuth and not loginOAuth", async () => {
    const refreshConfig = vi.fn(async () => {});
    const statuses: string[] = [];
    renderBar({ provider: "anthropic", hasRefreshToken: true, refreshConfig, statuses });
    const select = screen.getByLabelText("Provider");
    expect(select.tagName).toBe("SELECT");
    fireEvent.change(select, { target: { value: "grok" } });
    await waitFor(() => expect(refreshMock).toHaveBeenCalledWith({ provider: "grok" }));
    expect(loginMock).not.toHaveBeenCalled();
    expect(refreshConfig).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["Refreshed grok OAuth token."]);
  });

  it("selecting a different provider does not refresh", async () => {
    const refreshConfig = vi.fn(async () => {});
    renderBar({
      provider: "grok",
      hasRefreshToken: true,
      refreshConfig,
      statuses: [],
    });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "anthropic" } });
    await waitFor(() => expect(refreshConfig).toHaveBeenCalledTimes(1));
    expect(refreshMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("hides Renew session unless the current provider is Grok with a refresh token", () => {
    renderBar({
      provider: "anthropic",
      hasRefreshToken: true,
      refreshConfig: async () => {},
      statuses: [],
    });
    expect(screen.queryByRole("button", { name: "Renew session" })).toBeNull();
    cleanup();
    renderBar({
      provider: "grok",
      hasRefreshToken: false,
      refreshConfig: async () => {},
      statuses: [],
    });
    expect(screen.queryByRole("button", { name: "Renew session" })).toBeNull();
  });

  it("Renew session uses the same renew and a second click does not start another refresh", async () => {
    let release: (value: { ok: boolean; message: string }) => void = () => {};
    refreshMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const statuses: string[] = [];
    renderBar({
      provider: "grok",
      hasRefreshToken: true,
      refreshConfig: async () => {},
      statuses,
    });
    const renew = screen.getByRole("button", { name: "Renew session" });
    fireEvent.click(renew);
    fireEvent.click(renew);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith({ provider: "grok" });
    expect(loginMock).not.toHaveBeenCalled();
    release({ ok: true, message: "Refreshed grok OAuth token." });
    await waitFor(() => expect(statuses.length).toBeGreaterThan(0));
    expect(statuses.every((s) => s === "Refreshed grok OAuth token.")).toBe(true);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});
