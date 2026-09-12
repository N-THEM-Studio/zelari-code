// @vitest-environment jsdom
/**
 * McpSection — Settings → Extensions → MCP, as an integrations manager.
 *
 * Contract under test:
 *   - `print_mcp { cwd }` loads the snapshot; each server becomes a card with
 *     the catalog description (known package) or a truncated command preview
 *     (hand-added server), scope badge, on/off switch, and the header carries
 *     the active counter;
 *   - "Add custom server" opens the form and ships the draft to `set_mcp`:
 *     args split one-per-line, env parsed KEY=VALUE, the picked scope and the
 *     workspace as cwd, then the config is re-read;
 *   - empty/malformed drafts are refused inline with NO `set_mcp` call;
 *   - Edit prefills the form (name frozen), re-ships the stored env and keeps
 *     the entry's enabled state;
 *   - Remove asks for confirmation and calls `remove_mcp`;
 *   - catalog servers keep the old flow — no Edit button, Install still ships
 *     the curated command/args, the switch flips the entry.
 *
 * vi.mock('react'): apps/desktop has its own React copy (npm --prefix install)
 * while the root @testing-library/react uses the root copy — two Reacts in one
 * module graph break hooks. Same pin as Sidebar.test.tsx.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  printMcp,
  removeMcp,
  setMcp,
  type McpConfigSnapshot,
  type McpServerEntryDto,
} from "../agentClient";
import { McpSection } from "./McpSection";
import { COMMAND_PREVIEW_MAX } from "./mcpServerForm";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

vi.mock("../agentClient", () => ({
  printMcp: vi.fn(),
  setMcp: vi.fn(),
  removeMcp: vi.fn(),
}));

const printMock = vi.mocked(printMcp);
const setMock = vi.mocked(setMcp);
const removeMock = vi.mocked(removeMcp);

const USER_PATH = "C:/Users/me/.zelari-code/mcp.json";
const PROJECT_PATH = "Z:/repo/.zelari/mcp.json";

function snapshot(servers: McpServerEntryDto[]): McpConfigSnapshot {
  return { userPath: USER_PATH, projectPath: PROJECT_PATH, servers, merged: {} };
}

function entry(
  over: Partial<McpServerEntryDto> & { name: string },
): McpServerEntryDto {
  return {
    command: "npx",
    args: [],
    enabled: true,
    scope: "user",
    path: USER_PATH,
    ...over,
  };
}

/** Long enough that the command preview MUST be truncated. */
const LONG_ARGS = [
  "C:/tools/gh-helper-server.js",
  "--mode=watch",
  "--no-color",
  "--verbose",
];

beforeEach(() => {
  printMock.mockReset();
  setMock.mockReset();
  removeMock.mockReset();
  printMock.mockResolvedValue(snapshot([]));
  setMock.mockResolvedValue({ ok: true });
  removeMock.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("McpSection — integrations manager", () => {
  it("renders a card per server with description, badges and the active counter", async () => {
    printMock.mockResolvedValue(
      snapshot([
        entry({ name: "context7", args: ["-y", "@upstash/context7-mcp"] }),
        entry({
          name: "gh-helper",
          command: "node",
          args: LONG_ARGS,
          enabled: false,
          scope: "project",
          path: PROJECT_PATH,
        }),
      ]),
    );
    const { container } = render(<McpSection workdir="Z:/repo" />);

    expect(await screen.findByText("1 of 2 active")).toBeTruthy();
    expect(printMock).toHaveBeenCalledWith({ cwd: "Z:/repo" });

    // One card per server, and the assertions stay inside the card that owns
    // them — the store list reuses the catalog names.
    const rows = container.querySelectorAll<HTMLElement>(".mcp-server-row");
    expect(rows.length).toBe(2);

    // Catalog entry → curated name + description, never a raw command preview.
    expect(within(rows[0]).getByText("Context7")).toBeTruthy();
    expect(within(rows[0]).getByText(/Up-to-date library docs lookup/)).toBeTruthy();
    expect(within(rows[0]).getByText("On")).toBeTruthy();
    expect(within(rows[0]).getByText("user")).toBeTruthy();

    // Unknown entry → the description IS the truncated command preview.
    const preview = rows[1].querySelector(".mcp-server-desc")!.textContent ?? "";
    expect(preview).toContain("C:/tools/gh-helper-server.js");
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBe(COMMAND_PREVIEW_MAX);

    expect(within(rows[1]).getByText("custom")).toBeTruthy();
    expect(within(rows[1]).getByText("project")).toBeTruthy();
    expect(within(rows[1]).getByText("Off")).toBeTruthy();
  });

  it("adds a custom server: parsed args/env reach set_mcp and the list refreshes", async () => {
    render(<McpSection workdir="Z:/repo" />);
    await screen.findByText(/No MCP servers configured yet/);

    fireEvent.click(screen.getByRole("button", { name: "Add custom server" }));
    fireEvent.change(screen.getByLabelText("Server name"), {
      target: { value: "gh-helper" },
    });
    fireEvent.change(screen.getByLabelText("Server command"), {
      target: { value: "npx" },
    });
    fireEvent.change(screen.getByLabelText("Server arguments"), {
      target: { value: "-y\n@example/gh-helper\n\n  --verbose  " },
    });
    fireEvent.change(screen.getByLabelText("Server environment"), {
      target: { value: '# api token\nGH_TOKEN=abc123\nMODE="quiet"' },
    });
    fireEvent.change(screen.getByLabelText("Server scope"), {
      target: { value: "project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(setMock).toHaveBeenCalledTimes(1));
    expect(setMock).toHaveBeenCalledWith({
      name: "gh-helper",
      command: "npx",
      args: ["-y", "@example/gh-helper", "--verbose"],
      env: { GH_TOKEN: "abc123", MODE: "quiet" },
      scope: "project",
      enabled: true,
      cwd: "Z:/repo",
    });
    // The snapshot is re-read so the new entry shows up with its toggle.
    await waitFor(() => expect(printMock).toHaveBeenCalledTimes(2));
  });

  it("refuses an empty or malformed draft inline without touching set_mcp", async () => {
    render(<McpSection workdir="Z:/repo" />);
    await screen.findByText(/No MCP servers configured yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add custom server" }));

    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(await screen.findByText("Name is required.")).toBeTruthy();
    expect(screen.getByText("Command is required (npx, node, uvx…).")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Server name"), {
      target: { value: "bad name!" },
    });
    fireEvent.change(screen.getByLabelText("Server command"), {
      target: { value: "npx" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(
      await screen.findByText("Name must use letters, digits, _ or - only."),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Server environment"), {
      target: { value: "GH_TOKEN abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(
      await screen.findByText('Invalid env line "GH_TOKEN abc" — use KEY=VALUE.'),
    ).toBeTruthy();

    expect(setMock).not.toHaveBeenCalled();
  });

  it("edits a custom server: prefilled form, stored env kept, enabled state kept", async () => {
    printMock.mockResolvedValue(
      snapshot([
        entry({
          name: "gh-helper",
          command: "node",
          args: ["server.js", "--verbose"],
          env: { GH_TOKEN: "abc123" },
          enabled: false,
        }),
      ]),
    );
    render(<McpSection workdir="Z:/repo" />);
    await screen.findByText("gh-helper");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const name = screen.getByLabelText("Server name") as HTMLInputElement;
    expect(name.value).toBe("gh-helper");
    expect(name.readOnly).toBe(true);
    expect((screen.getByLabelText("Server command") as HTMLInputElement).value).toBe(
      "node",
    );
    expect(
      (screen.getByLabelText("Server arguments") as HTMLTextAreaElement).value,
    ).toBe("server.js\n--verbose");
    expect(
      (screen.getByLabelText("Server environment") as HTMLTextAreaElement).value,
    ).toBe("GH_TOKEN=abc123");

    fireEvent.change(screen.getByLabelText("Server command"), {
      target: { value: "node22" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(setMock).toHaveBeenCalledTimes(1));
    expect(setMock).toHaveBeenCalledWith({
      name: "gh-helper",
      command: "node22",
      args: ["server.js", "--verbose"],
      env: { GH_TOKEN: "abc123" },
      scope: "user",
      enabled: false,
      cwd: "Z:/repo",
    });
  });

  it("removes a custom server only after the confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    printMock.mockResolvedValue(snapshot([entry({ name: "gh-helper" })]));
    render(<McpSection workdir="Z:/repo" />);
    await screen.findByText("gh-helper");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(removeMock).toHaveBeenCalledWith({
        name: "gh-helper",
        scope: "user",
        cwd: "Z:/repo",
      }),
    );
    confirmSpy.mockRestore();
  });
  it("keeps catalog servers on the install/uninstall/toggle flow (no Edit)", async () => {
    printMock.mockResolvedValue(
      snapshot([entry({ name: "context7", args: ["-y", "@upstash/context7-mcp"] })]),
    );
    const { container } = render(<McpSection workdir="Z:/repo" />);
    await screen.findByText("1 of 1 active");

    const card = container.querySelector<HTMLElement>(".mcp-server-row")!;
    expect(within(card).getByText("Context7")).toBeTruthy();
    // Catalog servers: no Edit (only the hand-added ones can be edited)…
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Remove" })).toBeTruthy();
    // …and the catalog entry itself is marked as already installed.
    expect(screen.getByRole("button", { name: "Installed" })).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Disable context7" }));
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith({
        name: "context7",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        // Re-sent so an env written by hand is not wiped by the toggle.
        env: null,
        scope: "user",
        enabled: false,
        cwd: "Z:/repo",
      }),
    );

    // Install from the store is unchanged: curated command + args, install scope.
    setMock.mockClear();
    fireEvent.click(screen.getAllByRole("button", { name: "Install" })[0]);
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith({
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        scope: "user",
        enabled: true,
        cwd: "Z:/repo",
      }),
    );
  });

  it("marks the project scope unavailable until a folder is open", async () => {
    render(<McpSection workdir={null} />);
    await screen.findByText(/No MCP servers configured yet/);
    const option = screen.getByRole("option", {
      name: /Project \(\.zelari\) — open folder/,
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });
});
