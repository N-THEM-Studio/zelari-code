import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMcpPreset,
  getMcpPreset,
  isCuaDisabled,
  isCuaMcpServerName,
  listMcpPresetIds,
} from "../../src/cli/mcp/mcpPresets.js";
import { getProjectMcpPath } from "../../src/cli/mcp/mcpConfigIo.js";

describe("mcpPresets (Cua Driver)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.ZELARI_CUA;
  });

  it("lists the cua preset", () => {
    expect(listMcpPresetIds()).toContain("cua");
    expect(getMcpPreset("cua")?.servers["cua-driver"]?.command).toBe("cua-driver");
    expect(getMcpPreset("cua")?.servers["cua-driver"]?.args).toEqual(["mcp"]);
  });

  it("applyMcpPreset writes project mcp.json", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-preset-"));
    dirs.push(root);
    const r = applyMcpPreset({
      presetId: "cua",
      scope: "project",
      projectRoot: root,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const path = getProjectMcpPath(root);
    expect(existsSync(path)).toBe(true);
    const body = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(body.mcpServers["cua-driver"].command).toBe("cua-driver");
    expect(body.mcpServers["cua-driver"].args).toEqual(["mcp"]);
  });

  it("isCuaMcpServerName matches cua-driver family", () => {
    expect(isCuaMcpServerName("cua-driver")).toBe(true);
    expect(isCuaMcpServerName("cua")).toBe(true);
    expect(isCuaMcpServerName("github")).toBe(false);
  });

  it("isCuaDisabled reads ZELARI_CUA", () => {
    expect(isCuaDisabled()).toBe(false);
    process.env.ZELARI_CUA = "0";
    expect(isCuaDisabled()).toBe(true);
  });
});
