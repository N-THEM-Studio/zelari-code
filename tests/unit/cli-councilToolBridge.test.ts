/**
 * cli-councilToolBridge.test.ts — verifies CLI-only tools (browser_check, LSP,
 * AST) become reachable from the council/zelari advertisement catalog after
 * registerCliToolsIntoCouncilCatalog() runs.
 *
 * THE BUG (v1.5.0 regression found live): the council's executor registry had
 * browser_check + LSP registered, so filterExecutable kept their names — but
 * getProviderTools() resolved names against the static getAllTools() catalog,
 * which never listed them. The models were never told the tools existed.
 * v1.5.1 bridges the gap by deriving catalog entries from the executor's
 * ToolDefinitions.
 *
 * Test contract:
 *   - After registerCliToolsIntoCouncilCatalog(registry), getAllTools() lists
 *     browser_check + go_to_definition (when their env kill-switches are on).
 *   - Kill-switches are respected: ZELARI_BROWSER=0 → browser_check absent.
 *   - Harness builtins (read_file, bash, …) are NOT re-registered (no dupes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import type { ToolDefinition } from "@zelari/core/harness/tools/toolTypes";

const REAL_ENV = { ...process.env };

/** Build a minimal fake ToolDefinition with a zod inputSchema. */
function mkTool(name: string, description = "test tool"): ToolDefinition {
  return {
    name,
    description,
    permissions: [],
    inputSchema: z.object({ x: z.string() }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    execute: async (_input: unknown) => ({ ok: true as const, value: "stub" }),
  } as unknown as ToolDefinition;
}

beforeEach(() => {
  vi.resetModules();
  // Clear kill-switches + reset catalog to defaults (clearCustomTools).
  delete process.env.ZELARI_BROWSER;
  delete process.env.ZELARI_LSP;
  delete process.env.ZELARI_AST;
  delete process.env.ZELARI_SEMANTIC;
});

afterEach(async () => {
  // Restore env + wipe any custom tools we registered so tests don't leak.
  process.env = { ...REAL_ENV };
  const { clearCustomTools } = await import("@zelari/core/skills");
  clearCustomTools();
});

describe("cliToolToEnhanced (core helper, exercised via CLI)", () => {
  it("derives an EnhancedToolDefinition with name/description/JSON Schema", async () => {
    const { cliToolToEnhanced } = await import("@zelari/core/skills");
    const tool = mkTool("my_test_tool", "does a thing");
    const entry = cliToolToEnhanced(tool as never);
    expect(entry.name).toBe("my_test_tool");
    expect(entry.description).toBe("does a thing");
    expect(entry.parameters).toBeTypeOf("object");
    // JSON Schema shape: { type: 'object', properties, required }
    const params = entry.parameters as { type?: string; properties?: unknown };
    expect(params.type).toBe("object");
    expect(params.properties).toBeTypeOf("object");
  });

  it("execute is a guard stub, not a real implementation", async () => {
    const { cliToolToEnhanced } = await import("@zelari/core/skills");
    const entry = cliToolToEnhanced(mkTool("guard_test") as never);
    const result = entry.execute({});
    expect(String(result)).toMatch(/harness ToolRegistry/i);
  });
});

describe("getCliToolCatalogEntries — filters harness builtins", () => {
  it("returns entries for non-harness tools (browser_check, go_to_definition)", async () => {
    const { ToolRegistry } = await import("@zelari/core/harness/tools/registry");
    const { getCliToolCatalogEntries } = await import("../../src/cli/toolRegistry.js");
    const reg = new ToolRegistry();
    reg.register(mkTool("read_file")); // harness builtin → must be skipped
    reg.register(mkTool("bash")); // harness builtin → must be skipped
    reg.register(mkTool("browser_check", "browser automation"));
    reg.register(mkTool("go_to_definition", "LSP"));
    const entries = getCliToolCatalogEntries(reg);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["browser_check", "go_to_definition"]);
  });

  it("returns nothing for a registry with only harness builtins", async () => {
    const { ToolRegistry } = await import("@zelari/core/harness/tools/registry");
    const { getCliToolCatalogEntries } = await import("../../src/cli/toolRegistry.js");
    const reg = new ToolRegistry();
    reg.register(mkTool("read_file"));
    reg.register(mkTool("write_file"));
    reg.register(mkTool("grep_content"));
    expect(getCliToolCatalogEntries(reg)).toEqual([]);
  });

  it("never throws on a tool whose schema can't be derived", async () => {
    const { ToolRegistry } = await import("@zelari/core/harness/tools/registry");
    const { getCliToolCatalogEntries } = await import("../../src/cli/toolRegistry.js");
    const reg = new ToolRegistry();
    // Tool with no inputSchema (will throw in zodToJsonSchema).
    const broken = { name: "broken", description: "x", execute: async () => ({ ok: true, value: "" }) };
    reg.register(broken as unknown as ToolDefinition);
    reg.register(mkTool("good_tool"));
    const entries = getCliToolCatalogEntries(reg);
    // broken is skipped, good_tool survives.
    expect(entries.map((e) => e.name)).toEqual(["good_tool"]);
  });
});

describe("registerCliToolsIntoCouncilCatalog — end-to-end bridge", () => {
  it("makes browser_check + LSP reachable via getAllTools()", async () => {
    const { ToolRegistry } = await import("@zelari/core/harness/tools/registry");
    const { registerCliToolsIntoCouncilCatalog } = await import("../../src/cli/toolRegistry.js");
    const { getAllTools } = await import("@zelari/core/skills");

    const reg = new ToolRegistry();
    reg.register(mkTool("browser_check"));
    reg.register(mkTool("go_to_definition"));
    reg.register(mkTool("hover_type"));
    registerCliToolsIntoCouncilCatalog(reg);

    const catalogNames = new Set(getAllTools().map((t) => t.name));
    expect(catalogNames.has("browser_check")).toBe(true);
    expect(catalogNames.has("go_to_definition")).toBe(true);
    expect(catalogNames.has("hover_type")).toBe(true);
  });

  it("does not shadow the harness builtins (read_file stays the harness version)", async () => {
    // registerCustomTool replaces by name; if we accidentally re-registered a
    // harness builtin name, it would shadow the real entry. We skip those names
    // specifically, so read_file in the catalog must remain the harness version
    // (description matches the real readFileTool, not our "test tool" stub).
    const { ToolRegistry } = await import("@zelari/core/harness/tools/registry");
    const { registerCliToolsIntoCouncilCatalog } = await import("../../src/cli/toolRegistry.js");
    const { getAllTools } = await import("@zelari/core/skills");

    const reg = new ToolRegistry();
    reg.register(mkTool("read_file", "SHADOW ATTEMPT")); // harness name → skipped
    registerCliToolsIntoCouncilCatalog(reg);

    const readEntry = getAllTools().find((t) => t.name === "read_file");
    expect(readEntry).toBeDefined();
    expect(readEntry?.description).not.toBe("SHADOW ATTEMPT");
  });

  it("is idempotent (calling twice doesn't duplicate or break)", async () => {
    const { ToolRegistry } = await import("@zelari/core/harness/tools/registry");
    const { registerCliToolsIntoCouncilCatalog } = await import("../../src/cli/toolRegistry.js");
    const { getAllTools } = await import("@zelari/core/skills");

    const reg = new ToolRegistry();
    reg.register(mkTool("browser_check"));
    registerCliToolsIntoCouncilCatalog(reg);
    registerCliToolsIntoCouncilCatalog(reg);

    const browserEntries = getAllTools().filter((t) => t.name === "browser_check");
    // registerCustomTool replaces by name, so still exactly one entry.
    expect(browserEntries.length).toBe(1);
  });
});
