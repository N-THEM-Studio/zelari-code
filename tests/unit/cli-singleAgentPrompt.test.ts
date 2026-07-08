/**
 * cli-singleAgentPrompt.test.ts — verifies the single-agent system prompt
 * built via buildSystemPrompt() with the SINGLE_AGENT_IDENTITY_MODULE override.
 *
 * THE BUG (v1.5.2 and earlier): dispatchPrompt in useChatTurn.ts built the
 * single-agent prompt as an inline array, bypassing buildSystemPrompt(). The
 * 90%-of-usage path never received the 7 behavioral directives that live in
 * the builder (anti-confabulation, act-don't-describe, output self-check,
 * clarification, safety, formatting, tool-usage). v1.5.3 routes the single
 * agent through the builder with an identity-module override.
 *
 * This test exercises buildSystemPrompt directly with the same override the
 * CLI now passes, and asserts:
 *   - The 7 directives are present (they come from the builder modules).
 *   - The persona is "Zelari Code" (single-agent), NOT "AI Council" (the
 *     default identity module that must be replaced by the override).
 *   - The "AVAILABLE TOOLS" + shell/platform guidance blocks survive.
 */
import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  getAllTools,
  SINGLE_AGENT_IDENTITY_MODULE,
} from "@zelari/core/skills";

const SINGLE_AGENT_ROLE = {
  id: "single",
  name: "Zelari Code",
  codename: "zelari",
  role: "interactive coding agent",
  color: "#00d9a3",
  avatar: "◆",
  tools: ["read_file", "write_file", "edit_file", "bash", "grep_content"],
  systemPrompt: "# Platform & Shell\nplatform: linux\nshell: /bin/sh",
};

function buildSingleAgentPrompt(): string {
  return buildSystemPrompt(SINGLE_AGENT_ROLE, {
    tools: getAllTools(),
    toolNames: SINGLE_AGENT_ROLE.tools,
    aiConfig: {
      enabledSkills: [],
      enabledTools: SINGLE_AGENT_ROLE.tools,
      customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE],
      agentSkillConfigs: [],
    },
    workspaceContext: "# Workspace\nmain branch, 3 modified files",
    ragContext: undefined,
  });
}

describe("single-agent prompt via buildSystemPrompt (P1)", () => {
  const prompt = buildSingleAgentPrompt();

  it("uses the single-agent persona (NOT the council identity)", () => {
    expect(prompt).toMatch(/Zelari Code/i);
    // The council identity module says "member of an AI Council" — the
    // override must replace it, so this phrase must NOT appear.
    expect(prompt).not.toMatch(/member of an AI Council/i);
    expect(prompt).not.toMatch(/multi-agent system/i);
  });

  it("includes the anti-confabulation directive", () => {
    expect(prompt).toMatch(/confabulate/i);
  });

  it("includes the act-don't-describe (tool-use protocol) directive", () => {
    // From TOOL_USE_PROTOCOL_DIRECTIVE: "actually write/edit files"
    expect(prompt).toMatch(/write.*edit.*files/i);
  });

  it("includes the clarification protocol (---QUESTION--- format)", () => {
    expect(prompt).toMatch(/---QUESTION---/);
  });

  it("includes the output self-check directive", () => {
    expect(prompt).toMatch(/self.check|completeness|correctness/i);
  });

  it("includes the 'AVAILABLE TOOLS' section with the exact-name rule", () => {
    expect(prompt).toMatch(/AVAILABLE TOOLS.*use ONLY these exact names/is);
  });

  it("includes the 'never invent tool names' rule", () => {
    expect(prompt).toMatch(/never invent tool names/i);
  });

  it("preserves the shell/platform guidance (passed via agent.systemPrompt)", () => {
    expect(prompt).toMatch(/# Platform & Shell/);
    expect(prompt).toMatch(/platform: linux/);
    expect(prompt).toMatch(/shell: \/bin\/sh/);
  });

  it("includes the workspace context under its header", () => {
    expect(prompt).toMatch(/# Current Workspace State/);
    expect(prompt).toMatch(/main branch, 3 modified files/);
  });

  it("lists the registered tools by name", () => {
    expect(prompt).toMatch(/read_file/);
    expect(prompt).toMatch(/write_file/);
    expect(prompt).toMatch(/grep_content/);
  });
});
