// @vitest-environment node
/**
 * Silent Grok renew — the shared lock and the chat-pick decision.
 * App.tsx cannot be mounted (Tauri surface); the picker calls
 * `renewGrokAfterChatPersist` after persist, pinned below.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginOAuth, refreshOAuth } from "./agentClient";
import {
  renewGrokAfterChatPersist,
  renewGrokSession,
  resetGrokRenewForTests,
} from "./grokSessionRenew";

vi.mock("./agentClient", () => ({
  refreshOAuth: vi.fn(async () => ({ ok: true, message: "Refreshed grok OAuth token." })),
  loginOAuth: vi.fn(async () => ({ ok: true })),
}));

const refreshMock = vi.mocked(refreshOAuth);
const loginMock = vi.mocked(loginOAuth);

afterEach(() => {
  refreshMock.mockReset();
  refreshMock.mockResolvedValue({ ok: true, message: "Refreshed grok OAuth token." });
  loginMock.mockClear();
  resetGrokRenewForTests();
});

describe("renewGrokAfterChatPersist", () => {
  it("renews Grok when a refresh token exists and does not login", async () => {
    const refreshConfig = vi.fn(async () => {});
    const setStatus = vi.fn();
    await renewGrokAfterChatPersist({
      providerId: "grok",
      hasRefreshToken: true,
      refreshConfig,
      setStatus,
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith({ provider: "grok" });
    expect(loginMock).not.toHaveBeenCalled();
    expect(refreshConfig).toHaveBeenCalledTimes(1);
    expect(refreshMock.mock.invocationCallOrder[0]).toBeLessThan(
      refreshConfig.mock.invocationCallOrder[0],
    );
    expect(setStatus).toHaveBeenCalledWith("Refreshed grok OAuth token.");
  });

  it("does not renew a different provider even if that account has a refresh token", async () => {
    const refreshConfig = vi.fn(async () => {});
    await renewGrokAfterChatPersist({
      providerId: "anthropic",
      hasRefreshToken: true,
      refreshConfig,
      setStatus: vi.fn(),
    });
    expect(refreshMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
    expect(refreshConfig).toHaveBeenCalledTimes(1);
  });

  it("does nothing extra when Grok has no refresh token", async () => {
    const refreshConfig = vi.fn(async () => {});
    const setStatus = vi.fn();
    await renewGrokAfterChatPersist({
      providerId: "grok",
      hasRefreshToken: false,
      refreshConfig,
      setStatus,
    });
    expect(refreshMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(refreshConfig).toHaveBeenCalledTimes(1);
  });

  it("surfaces invalid_grant and does not start login", async () => {
    refreshMock.mockResolvedValue({ ok: false, error: "invalid_grant" });
    const setStatus = vi.fn();
    const refreshConfig = vi.fn(async () => {});
    await renewGrokAfterChatPersist({
      providerId: "grok",
      hasRefreshToken: true,
      refreshConfig,
      setStatus,
    });
    expect(setStatus).toHaveBeenCalledWith("invalid_grant");
    expect(loginMock).not.toHaveBeenCalled();
    expect(refreshConfig).toHaveBeenCalledTimes(1);
  });
});

describe("renewGrokSession in-flight lock", () => {
  it("joins a second call onto the same refresh instead of starting another", async () => {
    let release: (value: { ok: boolean; message: string }) => void = () => {};
    refreshMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const reloads: string[] = [];
    const first = renewGrokSession(async () => {
      reloads.push("a");
    });
    const second = renewGrokSession(async () => {
      reloads.push("b");
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    release({ ok: true, message: "Refreshed grok OAuth token." });
    const [a, b] = await Promise.all([first, second]);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(loginMock).not.toHaveBeenCalled();
    expect(a).toEqual(b);
    expect(a.message).toBe("Refreshed grok OAuth token.");
    expect(reloads).toEqual(["a"]);
  });
});

describe("App wires the chat picker to the silent renew", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = app.indexOf("const onProviderChange");
  const end = app.indexOf("const onModelChange", start);
  const onProviderChange = app.slice(start, end);

  it("renews after persist and never calls loginOAuth", () => {
    expect(start).toBeGreaterThan(-1);
    expect(onProviderChange).toContain('await persistChatModel(id, nextModel, "provider")');
    expect(onProviderChange).toContain("await renewGrokAfterChatPersist(");
    expect(onProviderChange).toContain("hasRefreshToken: p?.hasRefreshToken");
    expect(onProviderChange).not.toContain("loginOAuth");
    expect(app).toContain("onRenewGrokSession:");
    expect(app).toContain("renewGrokSession");
    expect(app).not.toContain("loginOAuth(");
  });
});
