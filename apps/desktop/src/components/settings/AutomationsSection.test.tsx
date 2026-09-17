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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  automationChannelHealth,
  automationChannelLogin,
  automationChannelProbe,
  deleteAutomation,
  getAppConfig,
  listAutomationRuns,
  listAutomations,
  listPendingApprovals,
  manageAutomation,
  manageAutomationSchedule,
  manageChannelCredential,
  resolveAutomationApproval,
  runAutomationHeadless,
  runAutomationOnce,
  setAutomationEnabled,
  upsertAutomation,
  type AutomationSpecInput,
  type AutomationSummary,
} from "../../agentClient";
import { DEFAULT_DESKTOP_PREFS, type DesktopPrefs } from "../../desktopPrefs";
import { AutomationsSection } from "./AutomationsSection";
import { expiryLabel } from "./PendingApprovalsCard";
import { SettingsToastProvider } from "./primitives";

vi.mock("react", async () => {
  // Direct .js import on purpose: it must resolve to the ROOT React copy
  // regardless of the nested apps/desktop/node_modules install.
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../../node_modules/react/index.js");
});

vi.mock("../../agentClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agentClient")>();
  return {
    ...actual,
    manageAutomation: vi.fn(),
    listAutomations: vi.fn(),
    deleteAutomation: vi.fn(),
    manageAutomationSchedule: vi.fn(),
    listPendingApprovals: vi.fn(),
    resolveAutomationApproval: vi.fn(),
    runAutomationOnce: vi.fn(),
    setAutomationEnabled: vi.fn(),
    runAutomationHeadless: vi.fn(),
    upsertAutomation: vi.fn(),
    automationChannelLogin: vi.fn(),
    automationChannelHealth: vi.fn(),
    automationChannelProbe: vi.fn(),
    manageChannelCredential: vi.fn(),
    listAutomationRuns: vi.fn(),
    getAppConfig: vi.fn(),
  };
});

const manageMock = vi.mocked(manageAutomation);
const listMock = vi.mocked(listAutomations);
const deleteMock = vi.mocked(deleteAutomation);
const scheduleMock = vi.mocked(manageAutomationSchedule);
const pendingMock = vi.mocked(listPendingApprovals);
const resolveMock = vi.mocked(resolveAutomationApproval);
const runMock = vi.mocked(runAutomationOnce);
const setEnabledMock = vi.mocked(setAutomationEnabled);
const headlessMock = vi.mocked(runAutomationHeadless);
const upsertMock = vi.mocked(upsertAutomation);
const loginMock = vi.mocked(automationChannelLogin);
const healthMock = vi.mocked(automationChannelHealth);
const probeMock = vi.mocked(automationChannelProbe);
const credMock = vi.mocked(manageChannelCredential);
const runsMock = vi.mocked(listAutomationRuns);
const configMock = vi.mocked(getAppConfig);

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
  listMock.mockReset();
  listMock.mockResolvedValue({ automations: [] });
  deleteMock.mockReset();
  deleteMock.mockResolvedValue({ exitCode: 0, stdout: "" });
  scheduleMock.mockReset();
  scheduleMock.mockResolvedValue({ id: "", registered: false, platform: "win32" });
  pendingMock.mockReset();
  pendingMock.mockResolvedValue({ approvals: [] });
  resolveMock.mockReset();
  resolveMock.mockResolvedValue({ exitCode: 0, stdout: "" });
  runMock.mockReset();
  runMock.mockResolvedValue({ exitCode: 0, stdout: "" });
  setEnabledMock.mockReset();
  setEnabledMock.mockResolvedValue({ id: "", enabled: false });
  headlessMock.mockReset();
  headlessMock.mockResolvedValue({ started: true });
  upsertMock.mockReset();
  upsertMock.mockResolvedValue({} as AutomationSpecInput);
  loginMock.mockReset();
  loginMock.mockResolvedValue({ ok: true, message: "logged in" });
  healthMock.mockReset();
  healthMock.mockResolvedValue({
    channel: "x",
    loggedIn: false,
    exitCode: 4,
    message: "relogin_required",
  });
  probeMock.mockReset();
  credMock.mockReset();
  credMock.mockResolvedValue({ channel: "website", configured: false });
  runsMock.mockReset();
  runsMock.mockResolvedValue({ id: "soc", runs: [] });
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

  it("advertises cross-platform registration, never Windows-only", async () => {
    renderSection();
    await screen.findByText("Not registered");
    const text = document.body.textContent ?? "";
    // The old Windows-only wording is gone…
    expect(text).not.toMatch(/Windows-only/i);
    expect(text).not.toMatch(/Windows Task Scheduler/);
    // …replaced by the three-platform OS-scheduler copy (default off, propose-only).
    expect(text).toMatch(/Task Scheduler \/ launchd \/ cron/);
    expect(text).toMatch(/Off by default/);
    expect(text).toMatch(/propose-only/);
  });
});

const SOC_SUMMARY: AutomationSummary = {
  id: "soc",
  name: "Soc",
  kind: "social_post",
  enabled: true,
  schedule: { intervalMin: 30, timezone: "UTC" },
  lastRun: { status: "awaiting_approval", exitCode: 4 },
};

const DONE_SUMMARY: AutomationSummary = {
  id: "news",
  name: "News digest",
  kind: "social_post",
  enabled: true,
  schedule: { timezone: "UTC" },
  lastRun: { status: "completed", exitCode: 0 },
};

const GARDENER_SUMMARY: AutomationSummary = {
  id: "gardener",
  name: "Gardener job",
  kind: "gardener",
  enabled: true,
  schedule: { timezone: "UTC" },
  lastRun: null,
};

describe("AutomationsSection — registry list", () => {
  it("renders non-gardener specs with kind + schedule, skipping the gardener", async () => {
    listMock.mockResolvedValue({ automations: [GARDENER_SUMMARY, SOC_SUMMARY] });
    renderSection();

    expect(await screen.findByText("Soc")).toBeTruthy();
    // The gardener spec is filtered out of the registry list (its own card owns it).
    expect(screen.queryByText("Gardener job")).toBeNull();
    // Kind chip + schedule summary travel through.
    expect(screen.getByText("social_post")).toBeTruthy();
    expect(screen.getByText(/every 30 min/)).toBeTruthy();
  });

  it("maps run status to pills: completed→ok, awaiting_approval→awaiting", async () => {
    listMock.mockResolvedValue({ automations: [DONE_SUMMARY, SOC_SUMMARY] });
    renderSection();

    expect(await screen.findByText("ok")).toBeTruthy();
    expect(screen.getByText("awaiting")).toBeTruthy();
  });

  it("toggles enabled optimistically and calls setAutomationEnabled", async () => {
    listMock.mockResolvedValue({ automations: [SOC_SUMMARY] });
    renderSection();
    await screen.findByText("Soc");

    const toggle = screen.getByRole("checkbox", { name: "Enable Soc" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    // The optimistic flip lands before the mutation is awaited.
    expect(
      (screen.getByRole("checkbox", { name: "Enable Soc" }) as HTMLInputElement).checked,
    ).toBe(false);
    await waitFor(() => expect(setEnabledMock).toHaveBeenCalledWith("soc", false, "Z:/repo"));
  });

  it("reverts the toggle and surfaces the error when setAutomationEnabled rejects", async () => {
    listMock.mockResolvedValue({ automations: [SOC_SUMMARY] });
    setEnabledMock.mockRejectedValue(
      '{"message":"reserved automation id cannot be toggled","exitCode":1}',
    );
    renderSection();
    await screen.findByText("Soc");

    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Soc" }));

    expect(await screen.findByText(/reserved automation id cannot be toggled/)).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "Enable Soc" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("runs headless (non-blocking) and shows the background confirmation", async () => {
    listMock.mockResolvedValue({ automations: [SOC_SUMMARY] });
    renderSection();
    await screen.findByText("Soc");

    fireEvent.click(screen.getByRole("button", { name: "Run headless" }));

    await waitFor(() => expect(headlessMock).toHaveBeenCalledWith("soc", "Z:/repo"));
    expect(await screen.findByText(/Avviato in background/)).toBeTruthy();
  });

  it("shows the OS-registered hint on a registered row", async () => {
    listMock.mockResolvedValue({ automations: [SOC_SUMMARY] });
    scheduleMock.mockResolvedValue({ id: "soc", registered: true, platform: "win32" });
    renderSection();

    expect(await screen.findByText(/gira anche a Desktop chiuso/)).toBeTruthy();
  });

  it("opens the run-history card from a row's Cronologia button", async () => {
    listMock.mockResolvedValue({ automations: [DONE_SUMMARY] });
    runsMock.mockResolvedValue({
      id: "news",
      runs: [{ runId: "r1", status: "relogin_required", exitCode: 4, posts: [] }],
    });
    renderSection();
    await screen.findByText("News digest");

    fireEvent.click(screen.getByRole("button", { name: "Cronologia" }));

    expect(await screen.findByText(/Cronologia · news/)).toBeTruthy();
    await waitFor(() => expect(runsMock).toHaveBeenCalledWith("news", "Z:/repo"));
    // exit 4 renders as a neutral state chip, not an error.
    expect(await screen.findByText("exit 4 · non provato")).toBeTruthy();
  });

  it("Register OS / Run once / Delete invoke the right IPC with the repo path", async () => {
    listMock.mockResolvedValue({ automations: [DONE_SUMMARY] });
    renderSection();
    await screen.findByText("News digest");

    fireEvent.click(screen.getByRole("button", { name: "Register OS" }));
    await waitFor(() =>
      expect(scheduleMock).toHaveBeenCalledWith("news", "register", "Z:/repo"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Run once" }));
    await waitFor(() => expect(runMock).toHaveBeenCalledWith("news", "Z:/repo"));

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("news", "Z:/repo"));
  });

  it("shows an inline error (never silent) when the list IPC rejects", async () => {
    listMock.mockRejectedValue('{"message":"boom","exitCode":1}');
    renderSection();
    expect(await screen.findByText(/boom \(exit 1\)/)).toBeTruthy();
  });
});

describe("AutomationsSection — pending approvals", () => {
  const ROW = {
    runId: "r1",
    automationId: "soc",
    draftPreview: "Hello draft",
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };

  it("is hidden until there is a pending draft", async () => {
    renderSection();
    await screen.findByText("Not registered");
    expect(screen.queryByText("Pending approvals")).toBeNull();
  });

  it("Allow resolves with 'allow' and refreshes", async () => {
    pendingMock.mockResolvedValue({ approvals: [ROW] });
    renderSection();

    expect(await screen.findByText("Pending approvals")).toBeTruthy();
    expect(screen.getByText(/Hello draft/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(resolveMock).toHaveBeenCalledWith("r1", "allow", "Z:/repo", undefined),
    );
  });

  it("Deny resolves with 'deny'", async () => {
    pendingMock.mockResolvedValue({ approvals: [ROW] });
    renderSection();
    await screen.findByText("Pending approvals");

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(resolveMock).toHaveBeenCalledWith("r1", "deny", "Z:/repo", undefined),
    );
  });

  it("Edit opens a textarea and resolves with the edited text", async () => {
    pendingMock.mockResolvedValue({ approvals: [ROW] });
    renderSection();
    await screen.findByText("Pending approvals");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const area = await screen.findByLabelText("Edit draft r1");
    fireEvent.change(area, { target: { value: "Edited text" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & publish/ }));

    await waitFor(() =>
      expect(resolveMock).toHaveBeenCalledWith("r1", "edit", "Z:/repo", "Edited text"),
    );
  });
});

describe("expiryLabel", () => {
  it("reports a coarse countdown and an expired state", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(expiryLabel(undefined, now)).toBe("no expiry");
    expect(expiryLabel("2025-12-31T23:59:00.000Z", now)).toBe("expired");
    expect(expiryLabel("2026-01-01T01:00:00.000Z", now)).toBe("expires in ~1 h");
    expect(expiryLabel("2026-01-01T00:30:00.000Z", now)).toBe("expires in ~30 min");
  });
});

const SOC_FULL: AutomationSummary = {
  id: "soc",
  name: "Soc",
  kind: "social_post",
  enabled: true,
  schedule: { intervalMin: 30, timezone: "UTC" },
  lastRun: null,
  spec: {
    id: "soc",
    name: "Soc",
    enabled: true,
    kind: "social_post",
    schedule: { intervalMin: 30, timezone: "UTC" },
    budget: { maxCostUsd: 2 },
    model: { provider: "anthropic", id: "claude-sonnet-4" },
    social_post: {
      channels: ["x"],
      topicOrBrief: "hello",
      requireApproval: true,
      approvalTtlMin: 1440,
    },
  },
};

describe("AutomationsSection — channel logins + model picker", () => {
  const CONFIG = {
    activeProviderId: "glm",
    modelByProvider: { glm: "glm-4.6" },
    providers: [
      {
        id: "glm",
        displayName: "GLM",
        hasKey: true,
        envVar: "ZELARI_GLM_KEY",
        models: ["glm-4.6", "glm-4.5-flash"],
        defaultModel: "glm-4.6",
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
    cliVersion: "test",
    configPaths: { provider: "p", keys: "k" },
  } as unknown as Awaited<ReturnType<typeof getAppConfig>>;

  it("assegna il modello per task dal picker integrato (e torna al default)", async () => {
    listMock.mockResolvedValue({ automations: [SOC_FULL] });
    configMock.mockResolvedValue(CONFIG);
    renderSection();
    await screen.findByText("Soc");

    const sel = screen.getByLabelText("Modello per Soc") as HTMLSelectElement;
    // SOC_FULL has model anthropic/claude-sonnet-4 → the composed value is selected.
    expect(sel.value).toBe("anthropic::claude-sonnet-4");
    expect(Array.from(sel.options).some((o) => o.value === "glm::glm-4.6")).toBe(true);

    fireEvent.change(sel, { target: { value: "glm::glm-4.6" } });
    await waitFor(() =>
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "soc", model: { provider: "glm", id: "glm-4.6" } }),
        "Z:/repo",
      ),
    );

    fireEvent.change(sel, { target: { value: "" } });
    await waitFor(() => {
      const last = upsertMock.mock.calls[upsertMock.mock.calls.length - 1]?.[0] as
        | { model?: unknown }
        | undefined;
      expect(last?.model).toBeUndefined();
    });
  });

  it("renders the channel login card and probes health for both channels on mount", async () => {
    renderSection();
    expect(await screen.findByText("Login canali")).toBeTruthy();
    expect((await screen.findAllByText("ri-login richiesto")).length).toBe(2);
    expect(healthMock).toHaveBeenCalledWith("x", "Z:/repo");
    expect(healthMock).toHaveBeenCalledWith("facebook", "Z:/repo");
  });

  it("starts a manual login for the clicked channel", async () => {
    renderSection();
    await screen.findByText("Login canali");
    const logins = screen.getAllByRole("button", { name: "Login" });
    expect(logins).toHaveLength(2);

    fireEvent.click(logins[0]);
    await waitFor(() => expect(loginMock).toHaveBeenCalledWith("x", "Z:/repo"));
  });
});
