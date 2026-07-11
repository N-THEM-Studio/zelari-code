/**
 * cli-singleAgentPrompt.test.ts — single-agent system prompt via
 * buildSystemPrompt(mode: 'agent') + SINGLE_AGENT_IDENTITY_MODULE.
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
    mode: "agent",
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

describe("single-agent prompt via buildSystemPrompt (agent pack)", () => {
  const prompt = buildSingleAgentPrompt();

  it("uses the single-agent persona (NOT the council identity)", () => {
    expect(prompt).toMatch(/Zelari Code/i);
    expect(prompt).not.toMatch(/member of an AI Council/i);
    expect(prompt).not.toMatch(/multi-agent system/i);
  });

  it("does not include Vault / wikilink formatting noise", () => {
    expect(prompt).not.toMatch(/wikilink/i);
    expect(prompt).not.toMatch(/Knowledge Vault/i);
    expect(prompt).not.toMatch(/AnathemaBrain/i);
  });

  it("includes the anti-confabulation directive", () => {
    expect(prompt).toMatch(/confabulate/i);
  });

  it("includes act-don't-describe / write-edit guidance", () => {
    expect(prompt).toMatch(/write|edit|implement/i);
  });

  it("prefers native tool calls over legacy ---TOOLS--- blocks", () => {
    expect(prompt).toMatch(/native/i);
    // Legacy format may be mentioned as fallback only — must not be the primary format block
    const primaryBlock = prompt.includes("---TOOLS---") && !prompt.includes("legacy");
    expect(primaryBlock).toBe(false);
  });

  it("includes coding practices", () => {
    expect(prompt).toMatch(/Read before edit|Minimal diffs|Coding Practices/i);
  });

  it("includes the clarification protocol (---QUESTION--- format)", () => {
    expect(prompt).toMatch(/---QUESTION---/);
    expect(prompt).toMatch(/Clarification Protocol/i);
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

  it("injects project instructions when provided", () => {
    const withAgents = buildSystemPrompt(SINGLE_AGENT_ROLE, {
      tools: getAllTools(),
      toolNames: SINGLE_AGENT_ROLE.tools,
      mode: "agent",
      projectInstructions: "# Project rules\n- Always run tests",
      aiConfig: {
        enabledSkills: [],
        enabledTools: SINGLE_AGENT_ROLE.tools,
        customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE],
        agentSkillConfigs: [],
      },
    });
    expect(withAgents).toMatch(/# Project Instructions/);
    expect(withAgents).toMatch(/Always run tests/);
  });
});
