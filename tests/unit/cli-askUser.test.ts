import { describe, it, expect, vi } from "vitest";
import { createAskUserTool } from "../../src/cli/tools/askUser.js";
import { createBuiltinToolRegistry } from "../../src/cli/toolRegistry.js";

describe("ask_user tool (Grok-style same-loop Q&A)", () => {
  it("returns soft proceed when no interactive handler", async () => {
    const tool = createAskUserTool(undefined);
    const r = await tool.execute(
      {
        question: "Which scope?",
        choices: ["Minimal", "Full"],
      },
      { cwd: process.cwd(), sessionId: "t" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatch(/No interactive UI|assumption/i);
      expect(r.value).toMatch(/Minimal/);
    }
  });

  it("awaits handler and returns the user answer", async () => {
    const handler = vi.fn(async () => "Full");
    const tool = createAskUserTool(handler);
    const r = await tool.execute(
      {
        question: "Which scope?",
        choices: ["Minimal", "Full"],
        context: "affects MVP size",
      },
      { cwd: process.cwd(), sessionId: "t" },
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].question).toBe("Which scope?");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatch(/User answered/);
      expect(r.value).toMatch(/Full/);
      expect(r.value).toMatch(/Continue the task/);
    }
  });

  it("reports cancel when handler returns null", async () => {
    const tool = createAskUserTool(async () => null);
    const r = await tool.execute(
      { question: "Go?", choices: ["Yes", "No"] },
      { cwd: process.cwd(), sessionId: "t" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatch(/cancelled|assumption/i);
  });

  it("registers ask_user in the builtin registry (including planMode)", () => {
    const { registry } = createBuiltinToolRegistry({ planMode: true });
    expect(registry.list()).toContain("ask_user");
  });

  it("does not register ask_user for readOnly sub-agents", () => {
    const { registry } = createBuiltinToolRegistry({ readOnly: true });
    expect(registry.list()).not.toContain("ask_user");
  });
});
