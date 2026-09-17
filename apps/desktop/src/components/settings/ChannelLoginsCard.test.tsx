// @vitest-environment jsdom
/**
 * ChannelLoginsCard — Settings → Automations: browser login + session health.
 *
 * Contract under test:
 *   - a row per supported login channel (x, facebook); health is probed on mount;
 *   - loggedIn:true → "loggato", loggedIn:false (exit 4) → "ri-login richiesto";
 *   - a technical failure surfaces as an error chip, never a crash;
 *   - "Login" starts the manual login for the clicked channel and reflects the ok.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  automationChannelHealth,
  automationChannelLogin,
  automationChannelProbe,
  manageChannelCredential,
} from "../../agentClient";
import { ChannelLoginsCard } from "./ChannelLoginsCard";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../../node_modules/react/index.js");
});

vi.mock("../../agentClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agentClient")>();
  return {
    ...actual,
    automationChannelHealth: vi.fn(),
    automationChannelLogin: vi.fn(),
    automationChannelProbe: vi.fn(),
    manageChannelCredential: vi.fn(),
  };
});

const healthMock = vi.mocked(automationChannelHealth);
const loginMock = vi.mocked(automationChannelLogin);
const probeMock = vi.mocked(automationChannelProbe);
const credMock = vi.mocked(manageChannelCredential);

function renderCard(workdir: string | null = "Z:/repo") {
  render(<ChannelLoginsCard workdir={workdir} />);
}

beforeEach(() => {
  healthMock.mockReset();
  loginMock.mockReset();
  probeMock.mockReset();
  credMock.mockReset();
  credMock.mockResolvedValue({ channel: "website", configured: false });
});

afterEach(cleanup);

describe("ChannelLoginsCard", () => {
  it("shows a 'loggato' chip when the session is healthy", async () => {
    healthMock.mockResolvedValue({ channel: "x", loggedIn: true, exitCode: 0, message: "ok" });
    renderCard();

    await waitFor(() => expect(healthMock).toHaveBeenCalledWith("x", "Z:/repo"));
    expect(healthMock).toHaveBeenCalledWith("facebook", "Z:/repo");
    expect((await screen.findAllByText("loggato")).length).toBe(2);
  });

  it("shows 'ri-login richiesto' when the profile is not logged in (exit 4)", async () => {
    healthMock.mockResolvedValue({
      channel: "x",
      loggedIn: false,
      exitCode: 4,
      message: "relogin_required",
    });
    renderCard();

    expect((await screen.findAllByText("ri-login richiesto")).length).toBe(2);
    expect(screen.getAllByText("relogin_required").length).toBe(2);
  });

  it("surfaces an error chip when the health probe fails", async () => {
    healthMock.mockRejectedValue('{"message":"Playwright missing","exitCode":1}');
    renderCard();

    expect((await screen.findAllByText(/Playwright missing \(exit 1\)/)).length).toBe(2);
    expect(screen.getAllByText("errore").length).toBe(2);
  });

  it("starts a manual login and flips the clicked channel to logged-in", async () => {
    healthMock.mockResolvedValue({
      channel: "x",
      loggedIn: false,
      exitCode: 4,
      message: "relogin_required",
    });
    loginMock.mockResolvedValue({ ok: true, message: "x: logged in ✓" });
    renderCard();
    await screen.findAllByText("ri-login richiesto");

    const logins = screen.getAllByRole("button", { name: "Login" });
    expect(logins).toHaveLength(2);
    fireEvent.click(logins[0]);

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith("x", "Z:/repo"));
    await waitFor(() => expect(screen.getAllByText("loggato").length).toBe(1));
  });

  it("disables login/verify with no workspace open", async () => {
    healthMock.mockResolvedValue({ channel: "x", loggedIn: false, exitCode: 4 });
    renderCard(null);

    const logins = screen.getAllByRole("button", { name: "Login" }) as HTMLButtonElement[];
    expect(logins.every((b) => b.disabled)).toBe(true);
    expect(healthMock).not.toHaveBeenCalled();
  });
});

describe("ChannelLoginsCard — website credentials", () => {
  it("loads the masked status on mount and stores the credential", async () => {
    healthMock.mockResolvedValue({ channel: "x", loggedIn: true, exitCode: 0, message: "ok" });
    credMock.mockResolvedValueOnce({ channel: "website", configured: false });
    credMock.mockResolvedValueOnce({
      channel: "website",
      configured: true,
      endpoint: "https://hook.test/x",
      secret: "s3cr…alue",
    });
    renderCard();

    await waitFor(() =>
      expect(credMock).toHaveBeenCalledWith({ action: "show", repoPath: "Z:/repo" }),
    );

    fireEvent.change(await screen.findByLabelText("Website endpoint"), {
      target: { value: "https://hook.test/x" },
    });
    fireEvent.change(screen.getByLabelText("Website secret"), {
      target: { value: "s3cr3t-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salva" }));

    await waitFor(() =>
      expect(credMock).toHaveBeenCalledWith({
        action: "store",
        repoPath: "Z:/repo",
        endpoint: "https://hook.test/x",
        secret: "s3cr3t-value",
      }),
    );
    expect(await screen.findByText("configurato")).toBeTruthy();
    expect(screen.getByText("s3cr…alue")).toBeTruthy();
  });

  it("removes the credential and flips the chip back to non configurato", async () => {
    healthMock.mockResolvedValue({ channel: "x", loggedIn: true, exitCode: 0, message: "ok" });
    credMock.mockResolvedValueOnce({
      channel: "website",
      configured: true,
      endpoint: "https://hook.test/x",
      secret: "s3cr…alue",
    });
    credMock.mockResolvedValueOnce({ channel: "website", configured: false, removed: true });
    renderCard();
    await screen.findAllByText("configurato");

    fireEvent.click(screen.getByRole("button", { name: "Rimuovi" }));

    await waitFor(() =>
      expect(credMock).toHaveBeenCalledWith({ action: "remove", repoPath: "Z:/repo" }),
    );
    expect(await screen.findByText("non configurato")).toBeTruthy();
  });
});

describe("ChannelLoginsCard — channel probe", () => {
  it("renders the probe step list on demand (a failed probe is not an error)", async () => {
    healthMock.mockResolvedValue({ channel: "x", loggedIn: true, exitCode: 0, message: "ok" });
    probeMock.mockResolvedValue({
      channel: "x",
      ok: false,
      checkedAt: "2026-01-01T00:00:00.000Z",
      steps: [
        { step: "browser-available", ok: true },
        { step: "login-state", ok: false, detail: "no selector matched" },
      ],
    });
    renderCard();

    const buttons = await screen.findAllByRole("button", { name: "Diagnostica" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(probeMock).toHaveBeenCalledWith("x", "Z:/repo"));
    expect(await screen.findByText("login-state")).toBeTruthy();
    expect(screen.getByText("no selector matched")).toBeTruthy();
    expect(screen.getByText("problemi")).toBeTruthy();
  });
});
